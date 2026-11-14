import { STATUS_CODES } from 'node:http';
import { WebSocketServer } from 'ws';
import { oneBotAccess } from './auth.mjs';
import { MAX_ACTION_BYTES } from './actions/message-params.mjs';
import { HEARTBEAT_MS, metaEvent, respondToWsAction, sendOneBotPacket, sendWsEvent } from './ws-packets.mjs';

export function createForwardWs({ host, accounts, dispatch, onState, basePath = '' }) {
    const server = new WebSocketServer({ noServer: true, maxPayload: MAX_ACTION_BYTES, perMessageDeflate: false });
    const peers = new Map();
    let enabled = false;
    let token = '';
    let behavior = {};

    function reject(socket, status) {
        socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }

    function upgrade(request, socket, head) {
        if (request.headers.host !== host) return reject(socket, 403);
        let url;
        try {
            url = new URL(request.url, 'http://' + host);
        } catch {
            return reject(socket, 400);
        }
        if (basePath && url.pathname !== basePath && !url.pathname.startsWith(basePath + '/')) {
            return reject(socket, 404);
        }
        const path = url.pathname.slice(basePath.length).replace(/\/$/, '') || '/';
        if (!enabled || !['/', '/api', '/event'].includes(path)) return reject(socket, 404);
        const denied = oneBotAccess(request, url, host, token);
        if (denied) return reject(socket, denied.status);
        const available = accounts();
        const chosen = url.searchParams.get('self_id');
        const account = chosen ?? (available.length === 1 ? available[0] : undefined);
        if (!account || !available.includes(account)) return reject(socket, 409);

        server.handleUpgrade(request, socket, head, ws => {
            const events = path !== '/api';
            peers.set(ws, { account, events });
            onState?.(account, 'connected');
            ws.on('error', () => {});
            if (path !== '/event') {
                ws.on('message', async (data, binary) => {
                    if (binary || !peers.has(ws)) return;
                    const response = await respondToWsAction(dispatch, data, account, () => onState?.(account, 'invalid'));
                    if (peers.has(ws)) sendOneBotPacket(ws, response);
                });
            }
            let alive = true;
            ws.on('pong', () => { alive = true; });
            const heartbeat = setInterval(() => {
                if (!alive) return ws.terminate();
                alive = false;
                ws.ping();
                if (events) sendOneBotPacket(ws, metaEvent(account, 'heartbeat'));
            }, HEARTBEAT_MS);
            ws.on('close', () => {
                peers.delete(ws);
                clearInterval(heartbeat);
                onState?.(account, 'closed');
            });
            if (events) sendOneBotPacket(ws, metaEvent(account, 'lifecycle'));
        });
    }

    function disconnect(account) {
        for (const [ws, peer] of peers) {
            if (account && peer.account !== account) continue;
            peers.delete(ws);
            ws.terminate();
        }
    }

    return {
        upgrade,
        update(config) {
            behavior = { format: config.forwardWsFormat, reportSelf: config.forwardWsReportSelf };
            const accessToken = config.forwardWsAccessToken ?? config.accessToken;
            if (enabled === config.forwardWsEnabled && token === accessToken) return;
            enabled = config.forwardWsEnabled;
            token = accessToken;
            disconnect();
        },
        detach: disconnect,
        publish(account, event) {
            for (const [ws, peer] of peers) {
                if (peer.account === account && peer.events) sendWsEvent(ws, event, behavior);
            }
        },
        count(account) {
            return [...peers.values()].filter(peer => peer.account === account).length;
        },
        close() {
            disconnect();
            server.close();
        },
    };
}
