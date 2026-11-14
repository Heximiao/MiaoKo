import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { openMessagePipe } from '../../ipc/pipe.mjs';

const ACCOUNT_CHECK_INTERVAL_MS = 3000;
const ACTIVE_CHECK_MIN_INTERVAL_MS = 350;
const MESSAGE_BATCH_MS = 35;

export async function startCapture({ pid, python, capture, seconds, inbox, onAttached, onMessages, onDetached,
    onNoticeListener }) {
    const pipe = await openMessagePipe(
        message => {
            inbox.receive(pid, message);
            scheduleCheck();
        },
        error => console.error('PID %d: %s', pid, error.message),
    );
    const args = [capture, '--pid', String(pid), '--pipe', pipe.path];
    if (seconds !== undefined) args.push('--seconds', String(seconds));
    const child = spawn(python, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
    });
    const control = createInterface({ input: child.stdout });
    let timer;
    let messageTimer;
    let lastCheck = -Infinity;
    let failure;
    let selfId;
    let duplex = false;
    let detached = false;
    const pending = new Map();
    let stopping = false;

    function checkAccount() {
        if (child.stdin.destroyed || child.stdin.writableEnded ||
            performance.now() - lastCheck < ACTIVE_CHECK_MIN_INTERVAL_MS || !inbox.beginCheck(pid)) {
            return;
        }
        lastCheck = performance.now();
        child.stdin.write('?\n');
    }

    function scheduleCheck() {
        if (messageTimer || child.stdin.destroyed || child.stdin.writableEnded || !inbox.hasPending(pid)) return;
        const delay = Math.max(MESSAGE_BATCH_MS, ACTIVE_CHECK_MIN_INTERVAL_MS - (performance.now() - lastCheck));
        messageTimer = setTimeout(() => {
            messageTimer = undefined;
            checkAccount();
            scheduleCheck();
        }, delay);
    }

    function stopTimers() {
        clearInterval(timer);
        clearTimeout(messageTimer);
    }

    function settle(id, outcome) {
        const action = pending.get(id);
        if (!action) return;
        clearTimeout(action.timer);
        pending.delete(id);
        action.resolve(outcome);
    }

    child.stdin.on('error', error => {
        console.error('PID %d: %s', pid, error.message);
        inbox.close(pid, 'error');
    });
    child.on('error', error => {
        failure = error.message;
        console.error('PID %d: %s', pid, failure);
    });
    child.stderr.on('data', data => {
        failure = String(data).trim().slice(-300);
        console.error('PID %d: %s', pid, failure);
    });
    control.on('line', line => {
        try {
            const event = JSON.parse(line);
            if (event.pid !== pid) throw new Error('Control message PID does not match its session');
            switch (event.type) {
                case 'attached':
                    inbox.bind(pid, event.selfId);
                    selfId = event.selfId;
                    duplex = event.duplex === true;
                    onAttached?.(selfId, pid, duplex);
                    checkAccount();
                    timer = setInterval(checkAccount, ACCOUNT_CHECK_INTERVAL_MS);
                    break;
                case 'account-check': {
                    const messages = inbox.completeCheck(pid, event.selfId);
                    if (messages?.length) onMessages?.(selfId, pid, messages);
                    if (event.selfId !== selfId) {
                        stopping = true;
                        onDetached?.(selfId, pid);
                    }
                    scheduleCheck();
                    break;
                }
                case 'action-result':
                    settle(event.id, event.outcome);
                    break;
                case 'notice-listener':
                    onNoticeListener?.(selfId, pid, event.outcome);
                    break;
                case 'account-unresolved':
                    inbox.close(pid, 'account-unresolved');
                    break;
                case 'detached':
                    detached = true;
                    stopTimers();
                    break;
                default:
                    throw new Error('Unexpected capture control message');
            }
        } catch (error) {
            console.error('PID %d: %s', pid, error.message);
            inbox.close(pid, 'error');
            child.stdin.end();
        }
    });
    const done = new Promise((resolve, reject) => {
        child.once('close', code => {
            stopping = true;
            stopTimers();
            for (const id of pending.keys()) settle(id, { status: 'unknown', error: 'QQ session closed during action' });
            if (selfId) onDetached?.(selfId, pid);
            inbox.close(pid, code === 0 ? 'stopped' : 'error', code === 0 ? undefined : failure);
            pipe.close().then(resolve, reject);
        });
    });
    return {
        done,
        request(expectedAccount, type, params) {
            if (stopping || !duplex || selfId !== expectedAccount || child.stdin.destroyed ||
                child.stdin.writableEnded || pending.size >= 5 ||
                (['send-message', 'send-poke'].includes(type) && [...pending.values()].some(action => action.type === type))) {
                return { status: 'failed', error: 'QQ session is busy or unavailable' };
            }
            const id = randomUUID();
            return new Promise(resolve => {
                const timer = setTimeout(() => settle(id, {
                    status: 'unknown', error: 'QQ did not confirm the action',
                }), 35000);
                pending.set(id, { type, timer, resolve });
                child.stdin.write(JSON.stringify({ type, id, selfId, params }) + '\n');
            });
        },
        async close({ verify = false } = {}) {
            stopping = true;
            if (selfId) onDetached?.(selfId, pid);
            stopTimers();
            child.stdin.end();
            await done;
            if (verify && !detached) throw new Error(failure || 'QQ did not confirm hook removal');
        },
    };
}
