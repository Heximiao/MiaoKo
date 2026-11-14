import { ActionError, booleanParam, qqId } from './shared.mjs';

async function history(kind, params, account, { ids, request, formatRecord }) {
    const field = kind === 'group' ? 'group_id' : 'user_id';
    const peer = qqId(params[field], field);
    const { message_seq: rawCursor = '0', count: rawCount = 20 } = params;
    const cursor = String(rawCursor) || '0';
    const count = String(rawCount);
    if ((typeof rawCursor !== 'string' && !Number.isSafeInteger(rawCursor)) ||
        (typeof rawCount !== 'string' && !Number.isSafeInteger(rawCount)) ||
        !/^(?:0|[1-9]\d{0,23})$/.test(cursor) || !/^[1-9]\d{0,2}$/.test(count) || Number(count) > 100) {
        throw new ActionError(1400, 'Invalid message_seq or count (1–100)');
    }
    const reverse = booleanParam(params.reverse_order ?? params.reverseOrder ?? false, 'reverse_order');
    const disableUrl = booleanParam(params.disable_get_url ?? false, 'disable_get_url');
    const saved = cursor !== '0' && Number(cursor) <= 0x7fffffff ? ids.resolve(account, Number(cursor)) : undefined;
    const reference = { kind, peer };
    if (saved && saved.kind === kind && saved.peer === peer && !saved.parentId) {
        reference.nativeId = saved.nativeId;
    } else if (cursor !== '0') {
        if (saved) throw new ActionError(1404, 'History cursor does not belong to this conversation');
        reference.seq = cursor;
    }
    const result = await request(account, 'get-message-history', { reference, count: Number(count), reverse });
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ history query failed');
    }
    const messages = [];
    for (const record of result.messages) {
        const message = await formatRecord(account, record, undefined, { disableUrl });
        if (message) messages.push({ ...message, real_id: message.message_id, message_seq: message.message_id,
            ...(record.msgSeq ? { real_seq: record.msgSeq } : {}),
            ...(message.user_id === message.self_id ? { post_type: 'message_sent' } : {}) });
    }
    return { messages };
}

export function getGroupMsgHistory(params, account, dependencies) {
    return history('group', params, account, dependencies);
}

export function getFriendMsgHistory(params, account, dependencies) {
    return history('private', params, account, dependencies);
}
