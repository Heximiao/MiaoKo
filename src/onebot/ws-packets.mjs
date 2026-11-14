import WebSocket from 'ws';

export const HEARTBEAT_MS = 15000;

export function sendOneBotPacket(socket, packet, onFailure) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (socket.bufferedAmount > 256 * 1024) {
        onFailure?.('发送缓冲区超过 256 KiB');
        socket.terminate();
        return;
    }
    socket.send(JSON.stringify(packet), error => {
        if (!error) return;
        onFailure?.(error.code ? `写入失败（${error.code}）` : '写入失败');
        socket.terminate();
    });
}

export function sendWsEvent(socket, event, { format, reportSelf, onFailure }) {
    if (event.post_type === 'message_sent' && !reportSelf) return;
    const packet = format === 'string' && Array.isArray(event.message)
        ? { ...event, message: event.raw_message } : event;
    sendOneBotPacket(socket, packet, onFailure);
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
