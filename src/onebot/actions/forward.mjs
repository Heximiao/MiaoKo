import { ActionError, qqId } from './shared.mjs';
import { messageRequest, oneBotMessageId } from './message-params.mjs';

function forwardAvatar(value) {
    if (value === undefined || value === '') return {};
    if (typeof value !== 'string' || value.length > 1024 || /[\x00-\x20\x7f]/.test(value)) {
        throw new ActionError(1400, 'Node avatars must be a QQ number or an HTTPS image URL');
    }
    if (/^[1-9]\d{4,11}$/.test(value)) {
        if (Number(value) > 0xffffffff) throw new ActionError(1400, 'Node avatar QQ number exceeds the forward format limit');
        return { avatar: `https://q.qlogo.cn/headimg_dl?dst_uin=${value}&spec=0&img_type=jpg`,
            nodeSender: value };
    }
    const url = URL.canParse(value) && new URL(value);
    if (!url || url.protocol !== 'https:' || url.username || url.password || url.href.length > 1024) {
        throw new ActionError(1400, 'Node avatars must be a QQ number or an HTTPS image URL');
    }
    return { avatar: url.href };
}

function validName(name) {
    return typeof name === 'string' && name.trim() && !name.includes('\0') && Buffer.byteLength(name) <= 160;
}

function customNodes(nodes, account, kind, field, peer) {
    if ([account, peer].some(id => Number(id) > 0xffffffff)) {
        throw new ActionError(1400, 'Custom forwarding requires 32-bit QQ and group IDs');
    }
    let textBytes = 0;
    return nodes.map(({ data }) => {
        const user = qqId(data.user_id ?? data.uin, 'node user_id');
        const nickname = data.nickname ?? data.name;
        const previewName = data.preview_name;
        if (user !== account || !validName(nickname) || (previewName !== undefined && !validName(previewName))) {
            throw new ActionError(1400, 'Custom nodes require the bound account and a valid display name');
        }
        const { segments } = messageRequest({ [field]: peer, message: data.content,
            auto_escape: typeof data.content === 'string' }, kind, 8 * 1024);
        for (const segment of segments) {
            if (segment.type === 'text') textBytes += Buffer.byteLength(segment.data.text);
            else if (segment.type !== 'image') {
                throw new ActionError(1400, 'Custom nodes accept text and image segments');
            }
        }
        if (textBytes > 64 * 1024) throw new ActionError(1400, 'Forward text exceeds 64 KiB');
        return { nickname, ...(previewName !== undefined && { previewName }), ...forwardAvatar(data.avatar), segments };
    });
}

async function sendForward(kind, params, account, { ids, sendForwardBatch }) {
    const field = kind === 'group' ? 'group_id' : 'user_id';
    const peer = qqId(params[field], field);
    const nodes = params.messages ?? params.message;
    if (!Array.isArray(nodes) || nodes.length < 1 || nodes.length > 50) {
        throw new ActionError(1400, 'Expected 1–50 forward nodes');
    }
    if (nodes.some(node => node?.type !== 'node' || !node.data || typeof node.data !== 'object')) {
        throw new ActionError(1400, 'Expected forward nodes');
    }
    const reference = { kind, peer };
    let request;
    if (nodes.every(node => node.data.id === undefined)) {
        request = { reference, nodes: customNodes(nodes, account, kind, field, peer) };
    } else {
        const references = nodes.map(({ data }) => {
            if (data.id === undefined) throw new ActionError(1400, 'Expected a forward node with data.id');
            const source = ids.resolve(account, oneBotMessageId(data.id));
            if (!source || source.parentId) throw new ActionError(1404, 'Forward source message was not found');
            return source;
        });
        const source = references[0];
        if (references.some(row => row.kind !== source.kind || row.peer !== source.peer)) {
            throw new ActionError(1400, 'Forward nodes must belong to one source conversation');
        }
        request = { reference, source, messageIds: references.map(row => row.nativeId) };
    }
    const outcome = await sendForwardBatch(account, request);
    if (outcome.status !== 'ok') {
        throw new ActionError(outcome.status === 'unknown' ? 1501 : 1500, outcome.error ?? 'QQ forward failed');
    }
    return { message_id: await ids.get(account, kind, peer, outcome.nativeId) };
}

export function sendGroupForwardMsg(params, account, dependencies) {
    return sendForward('group', params, account, dependencies);
}

export function sendPrivateForwardMsg(params, account, dependencies) {
    return sendForward('private', params, account, dependencies);
}

export function sendForwardMsg(params, account, dependencies) {
    if (params.message_type === 'group' ||
        (params.message_type === undefined && params.group_id !== undefined && params.user_id === undefined)) {
        return sendGroupForwardMsg(params, account, dependencies);
    }
    if (params.message_type === 'private' ||
        (params.message_type === undefined && params.user_id !== undefined && params.group_id === undefined)) {
        return sendPrivateForwardMsg(params, account, dependencies);
    }
    throw new ActionError(1400, 'Invalid message_type');
}

export async function getForwardMsg(params, account, { ids, request, formatRecord }) {
    const id = oneBotMessageId(params.message_id ?? params.id);
    const reference = ids.resolve(account, id);
    if (!reference) throw new ActionError(1404, 'Forward message was not found');
    const result = await request(account, 'get-forward-message', { reference });
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ forward lookup failed');
    }
    const messages = [];
    for (const record of result.messages) {
        const message = await formatRecord(account, record, { parentId: reference.parentId ?? reference.nativeId });
        if (message) messages.push(message);
    }
    return { messages };
}
