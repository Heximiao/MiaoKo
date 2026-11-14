import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { openMessagePipe } from '../../ipc/pipe.mjs';

const ACCOUNT_CHECK_INTERVAL_MS = 3000;
const ACTIVE_CHECK_MIN_INTERVAL_MS = 350;
const MESSAGE_BATCH_MS = 35;
const MAX_ACTIVE_ACTIONS = 4;
const MAX_ACTIVE_PROFILE_LIKES = 2;
const MAX_WAITING_ACTIONS = 32;
const MAX_WAITING_PROFILE_LIKES = 16;
const ACTION_QUEUE_TIMEOUT_MS = 10000;
const serialActions = new Set(['send-message', 'send-poke']);

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
    const waiting = [];
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
        pumpActions();
    }

    function stopActions() {
        stopping = true;
        for (const action of waiting.splice(0)) {
            clearTimeout(action.timer);
            action.resolve({ status: 'failed', error: 'QQ session closed before starting the action' });
        }
    }

    function pumpActions() {
        while (!stopping && !child.stdin.destroyed && !child.stdin.writableEnded && pending.size < MAX_ACTIVE_ACTIONS) {
            const activeTypes = [...pending.values()].map(action => action.type);
            const activeLikes = activeTypes.filter(type => type === 'send-profile-like').length;
            const index = waiting.findIndex(({ type }) =>
                (!serialActions.has(type) || !activeTypes.includes(type)) &&
                (type !== 'send-profile-like' || activeLikes < MAX_ACTIVE_PROFILE_LIKES));
            if (index === -1) return;
            const [action] = waiting.splice(index, 1);
            clearTimeout(action.timer);
            const { id, type, params } = action;
            action.timer = setTimeout(() => settle(id, {
                status: 'unknown', error: 'QQ did not confirm the action',
            }), 35000);
            pending.set(id, action);
            child.stdin.write(JSON.stringify({ type, id, selfId, params }) + '\n');
        }
    }

    child.stdin.on('error', error => {
        stopActions();
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
                        stopActions();
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
            stopActions();
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
                child.stdin.writableEnded) {
                return { status: 'failed', error: 'QQ session is unavailable' };
            }
            if (waiting.length >= MAX_WAITING_ACTIONS) {
                return { status: 'failed', error: 'QQ action queue is full' };
            }
            if (type === 'send-profile-like' &&
                waiting.filter(action => action.type === type).length >= MAX_WAITING_PROFILE_LIKES) {
                return { status: 'failed', error: 'QQ profile like queue is full' };
            }
            return new Promise(resolve => {
                const action = { id: randomUUID(), type, params, resolve };
                action.timer = setTimeout(() => {
                    waiting.splice(waiting.indexOf(action), 1);
                    resolve({ status: 'failed', error: 'QQ action expired while waiting in the queue' });
                }, ACTION_QUEUE_TIMEOUT_MS);
                waiting.push(action);
                pumpActions();
            });
        },
        async close({ verify = false } = {}) {
            stopActions();
            if (selfId) onDetached?.(selfId, pid);
            stopTimers();
            child.stdin.end();
            await done;
            if (verify && !detached) throw new Error(failure || 'QQ did not confirm hook removal');
        },
    };
}
