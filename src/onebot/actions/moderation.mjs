import { ActionError, booleanParam, qqId } from './shared.mjs';

async function perform(account, request, type, params) {
    const result = await request(account, type, params);
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ rejected the operation');
    }
    return null;
}

export function setGroupBan(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const user = qqId(params.user_id, 'user_id');
    const duration = String(params.duration ?? 1800);
    if (!/^\d{1,8}$/.test(duration) || Number(duration) > 30 * 86400) {
        throw new ActionError(1400, 'Invalid duration in seconds');
    }
    return perform(account, request, 'set-group-ban', { group, user, duration: Number(duration) });
}

export function setGroupWholeBan(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    return perform(account, request, 'set-group-whole-ban',
        { group, enable: booleanParam(params.enable ?? true, 'enable') });
}

export function setGroupKick(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const user = qqId(params.user_id, 'user_id');
    const reject = booleanParam(params.reject_add_request ?? false, 'reject_add_request');
    return perform(account, request, 'set-group-kick', { group, user, reject });
}

async function handleRequest(kind, params, account, { request, pendingRequests }) {
    const { flag, sub_type: subtype = params.type, reason = '' } = params;
    if (typeof flag !== 'string' || !/^[a-f0-9-]{36}$/.test(flag) ||
        (kind === 'group' && !['add', 'invite'].includes(subtype)) ||
        typeof reason !== 'string' || Buffer.byteLength(reason) > 512 || reason.includes('\0')) {
        throw new ActionError(1400, 'Invalid request flag, sub_type or reason');
    }
    const approve = booleanParam(params.approve ?? true, 'approve');
    const entry = pendingRequests?.get(flag);
    if (!entry || entry.account !== account || entry.record.kind !== kind ||
        (kind === 'group' && subtype !== entry.record.subtype)) {
        throw new ActionError(1404, 'Request was not found for this account');
    }
    if (entry.pending) throw new ActionError(1500, 'Request is already being handled');
    entry.pending = true;
    try {
        await perform(account, request, 'handle-' + kind + '-request',
            { notification: entry.record.notification, approve, reason });
        pendingRequests.delete(flag);
        return null;
    } finally {
        entry.pending = false;
    }
}

export function setFriendAddRequest(params, account, dependencies) {
    return handleRequest('friend', params, account, dependencies);
}

export function setGroupAddRequest(params, account, dependencies) {
    return handleRequest('group', params, account, dependencies);
}
