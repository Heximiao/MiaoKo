import { ActionError } from '../onebot/actions/shared.mjs';

const MAX_SENDS_PER_ACCOUNT = 8;
const SEND_QUEUE_TIMEOUT_MS = 10000;

export function createSendQueue() {
    const accounts = new Map();
    async function run(account, waiting, send) {
        try {
            return await send();
        } finally {
            const next = waiting.shift();
            if (next) next.start();
            else accounts.delete(account);
        }
    }

    return async function enqueue(account, send) {
        const waiting = accounts.get(account);
        if (!waiting) {
            const queue = [];
            accounts.set(account, queue);
            return run(account, queue, send);
        }
        if (waiting.length >= MAX_SENDS_PER_ACCOUNT - 1) {
            throw new ActionError(1500, 'QQ send queue is full for this account');
        }
        return new Promise((resolve, reject) => {
            const entry = {
                start() {
                    clearTimeout(timer);
                    resolve(run(account, waiting, send));
                },
            };
            const timer = setTimeout(() => {
                waiting.splice(waiting.indexOf(entry), 1);
                reject(new ActionError(1500, 'QQ send expired while waiting in the queue'));
            }, SEND_QUEUE_TIMEOUT_MS);
            waiting.push(entry);
        });
    };
}
