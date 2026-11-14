import WebSocket from 'ws';

export const HEARTBEAT_MS = 15000;

export function sendOneBotPacket(socket, packet) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) {
        socket.terminate();
        return;
    }
    socket.send(JSON.stringify(packet), error => { if (error) socket.terminate(); });
}

export function sendWsEvent(socket, event, { format, reportSelf }) {
    if (event.post_type === 'message_sent' && !reportSelf) return;
    const packet = format === 'string' && Array.isArray(event.message)
        ? { ...event, message: event.raw_message } : event;
    sendOneBotPacket(socket, packet);
}

export function metaEvent(account, type) {
    return { time: Math.floor(Date.now() / 1000), self_id: Number(account), post_type: 'meta_event',
        meta_event_type: type, ...(type === 'heartbeat'
            ? { status: { online: true, good: true }, interval: HEARTBEAT_MS }
            : { sub_type: 'connect' }) };
}

export async function respondToWsAction(dispatch, data, account, onInvalid) {
    let request;
    try {
        request = JSON.parse(data.toString('utf8'));
    } catch {
        onInvalid?.();
        return { status: 'failed', retcode: 1400, data: null, message: 'Invalid JSON' };
    }
    return dispatch(request, account);
}
