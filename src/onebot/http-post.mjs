import { createHmac } from 'node:crypto';

export function createHttpPost({ onState } = {}) {
    const peers = new Map();
    let endpoint = { httpPostUrl: '', httpPostSecret: '' };
    const configured = () => Boolean(endpoint.httpPostUrl) && endpoint.httpPostEnabled !== false;

    function reset(peer) {
        peer.controller.abort();
        peer.controller = new AbortController();
        peer.queue.length = 0;
        peer.state = 'pending';
        peer.running = false;
    }

    function setState(peer, state, detail) {
        if (peer.state === state) return;
        peer.state = state;
        onState?.(peer.account, state, detail);
    }

    async function deliver(peer) {
        peer.running = true;
        const signal = peer.controller.signal;
        const { httpPostUrl, httpPostSecret } = endpoint;
        try {
            while (peer.queue.length && !signal.aborted) {
                const body = peer.queue.shift();
                const headers = { 'Content-Type': 'application/json', 'X-Self-ID': peer.account };
                if (httpPostSecret) headers['X-Signature'] = 'sha1=' + createHmac('sha1', httpPostSecret).update(body).digest('hex');
                try {
                    const response = await fetch(httpPostUrl, {
                        method: 'POST', headers, body, redirect: 'error',
                        signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
                    });
                    await response.body?.cancel();
                    if (!signal.aborted) setState(peer, response.ok ? 'delivered' : 'failed', 'HTTP ' + response.status);
                } catch {
                    if (!signal.aborted) setState(peer, 'failed', '请求失败或超时');
                }
            }
        } finally {
            if (!signal.aborted) peer.running = false;
        }
    }

    return {
        update(config) {
            if (config.httpPostUrl === endpoint.httpPostUrl && config.httpPostSecret === endpoint.httpPostSecret &&
                config.httpPostEnabled === endpoint.httpPostEnabled) return;
            endpoint = config;
            for (const peer of peers.values()) reset(peer);
        },
        attach(account) {
            if (peers.has(account)) return;
            peers.set(account, { account, queue: [], controller: new AbortController(), state: 'pending', running: false });
        },
        detach(account) {
            peers.get(account)?.controller.abort();
            peers.delete(account);
        },
        publish(account, event) {
            const peer = peers.get(account);
            if (!configured() || !peer) return;
            if (peer.queue.length >= 64) {
                setState(peer, 'failed', '回调队列已满');
                return;
            }
            peer.queue.push(JSON.stringify(event));
            if (!peer.running) void deliver(peer);
        },
        status(account) {
            return configured() ? peers.get(account)?.state ?? 'pending' : 'unconfigured';
        },
        close() {
            for (const peer of peers.values()) peer.controller.abort();
            peers.clear();
        },
    };
}
