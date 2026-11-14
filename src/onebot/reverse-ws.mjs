import WebSocket from 'ws';
import { MAX_ACTION_BYTES } from './actions/message-params.mjs';
import { HEARTBEAT_MS, metaEvent, respondToWsAction, sendOneBotPacket, sendWsEvent } from './ws-packets.mjs';

export function createReverseWs({ dispatch, onState }) {
    const peers = new Map();
    let endpoint = {};

    const configured = () => Boolean(endpoint.reverseWsUrl) && endpoint.reverseWsEnabled !== false;

    function connect(peer) {
        if (!configured()) return;
        const role = endpoint.reverseWsRole ?? 'Universal';
        const events = role !== 'Api';
        const headers = { 'X-Self-ID': peer.account, 'X-Client-Role': role };
        if (endpoint.accessToken) headers.Authorization = 'Bearer ' + endpoint.accessToken;
        const ws = new WebSocket(endpoint.reverseWsUrl, {
            headers, handshakeTimeout: 5000, maxPayload: MAX_ACTION_BYTES, perMessageDeflate: false,
        });
        peer.socket = ws;
        onState?.(peer.account, 'connecting');
        let failure;
        const recordFailure = reason => { failure ??= reason; };
        peer.recordFailure = recordFailure;
        let alive = true;
        let heartbeat;
        ws.on('open', () => {
            if (peer.socket !== ws) return;
            peer.delay = 1000;
            onState?.(peer.account, 'connected', `角色 ${role}`);
            if (events) sendOneBotPacket(ws, metaEvent(peer.account, 'lifecycle'), recordFailure);
            heartbeat = setInterval(() => {
                if (!alive) {
                    recordFailure('心跳未收到 Pong');
                    ws.terminate();
                    return;
                }
                alive = false;
                ws.ping();
                if (events) sendOneBotPacket(ws, metaEvent(peer.account, 'heartbeat'), recordFailure);
            }, HEARTBEAT_MS);
        });
        ws.on('pong', () => { alive = true; });
        ws.on('message', async (data, binary) => {
            if (peer.socket !== ws || binary || role === 'Event') return;
            const response = await respondToWsAction(dispatch, data, peer.account, () => onState?.(peer.account, 'invalid'));
            if (peer.socket === ws) sendOneBotPacket(ws, response, recordFailure);
        });
        ws.on('error', error => {
            const status = /^Unexpected server response: (\d{3})$/.exec(error.message)?.[1];
            recordFailure(status ? `握手 HTTP ${status}` : error.code || '连接出错');
        });
        ws.on('close', code => {
            clearInterval(heartbeat);
            if (peer.socket !== ws) return;
            peer.socket = undefined;
            const delay = endpoint.reverseWsRetryMs || peer.delay;
            const detail = [`角色 ${role}`, `关闭码 ${code}`, failure, `${delay / 1000} 秒后重连`];
            onState?.(peer.account, 'retrying', detail.filter(Boolean).join(' · '));
            peer.retry = setTimeout(() => connect(peer), delay);
            peer.delay = Math.min(peer.delay * 2, 30000);
        });
    }

    function disconnect(peer) {
        clearTimeout(peer.retry);
        const ws = peer.socket;
        peer.socket = undefined;
        ws?.terminate();
    }

    return {
        update(config) {
            const accessToken = config.reverseWsAccessToken ?? config.accessToken;
            const reconnect = endpoint.reverseWsUrl !== config.reverseWsUrl || endpoint.accessToken !== accessToken ||
                endpoint.reverseWsEnabled !== config.reverseWsEnabled || endpoint.reverseWsRole !== config.reverseWsRole ||
                endpoint.reverseWsRetryMs !== config.reverseWsRetryMs;
            endpoint = { ...config, accessToken };
            if (!reconnect) return;
            for (const peer of peers.values()) {
                disconnect(peer);
                peer.delay = 1000;
                connect(peer);
            }
        },
        attach(account) {
            if (peers.has(account)) return;
            const peer = { account, delay: 1000 };
            peers.set(account, peer);
            connect(peer);
        },
        detach(account) {
            const peer = peers.get(account);
            if (!peer) return;
            peers.delete(account);
            disconnect(peer);
        },
        publish(account, event) {
            const peer = peers.get(account);
            if (endpoint.reverseWsRole !== 'Api') {
                sendWsEvent(peer?.socket, event, { format: endpoint.reverseWsFormat,
                    reportSelf: endpoint.reverseWsReportSelf, onFailure: peer?.recordFailure });
            }
        },
        status() {
            return [...peers.values()].map(peer => ({
                selfId: peer.account,
                state: !configured() ? 'unconfigured'
                    : peer.socket?.readyState === WebSocket.OPEN ? 'connected' : 'connecting',
            }));
        },
        close() {
            for (const peer of peers.values()) disconnect(peer);
            peers.clear();
        },
    };
}
