import { ActionError } from './shared.mjs';
import { messageRequest, oneBotMessageId } from './message-params.mjs';
import { signMusic } from './music.mjs';

async function sendTo(kind, params, account, { ids, sendMessage }) {
    const { peer, segments } = messageRequest(params, kind);
    for (const segment of segments) {
        if (segment.type !== 'reply' || segment.data.id === undefined) continue;
        const reference = ids.resolve(account, segment.data.id);
        if (!reference || reference.kind !== kind || reference.peer !== peer) {
            throw new ActionError(1400, 'Quoted message does not belong to this account and conversation');
        }
        const { kind: _kind, peer: _peer, ...location } = reference;
        segment.data = location;
    }
    const outgoing = await Promise.all(segments.map(segment => segment.type === 'music' ? signMusic(segment.data) : segment));
    const outcome = await sendMessage(account, kind, peer, outgoing);
    if (outcome.status !== 'sent') {
        throw new ActionError(outcome.status === 'unknown' ? 1501 : 1500, outcome.error ?? 'QQ send failed');
    }
    return { message_id: await ids.get(account, kind, peer, outcome.messageId) };
}

export function sendGroupMsg(params, account, dependencies) {
    return sendTo('group', params, account, dependencies);
}

export function sendPrivateMsg(params, account, dependencies) {
    return sendTo('private', params, account, dependencies);
}

export function sendMsg(params, account, dependencies) {
    const { message_type: type, group_id: group, user_id: user } = params;
    if (type === 'group' || (type === undefined && group !== undefined && user === undefined)) {
        return sendGroupMsg(params, account, dependencies);
    }
    if (type === 'private' || (type === undefined && user !== undefined && group === undefined)) {
        return sendPrivateMsg(params, account, dependencies);
    }
    throw new ActionError(1400, 'Specify message_type or exactly one destination');
}

export async function getMsg(params, account, { ids, readMessage, formatRecord, replyRecords }) {
    const id = oneBotMessageId(params.message_id);
    const reference = ids.resolve(account, id);
    if (!reference) throw new ActionError(1404, 'Message was not found for this account');
    let message = await readMessage(account, reference);
    if (!message) {
        const quoted = replyRecords?.get(account, id);
        if (quoted) {
            const { seq, parentId } = reference;
            message = await formatRecord(account, quoted, { seq, parentId });
        }
    }
    if (!message) throw new ActionError(1404, 'Message is unavailable in QQ history');
    return { ...message, message_id: id, real_id: id };
}

export async function deleteMsg(params, account, { ids, request }) {
    const id = oneBotMessageId(params.message_id);
    const reference = ids.resolve(account, id);
    if (!reference) throw new ActionError(1404, 'Message was not found for this account');
    const outcome = await request(account, 'recall-message', { reference });
    if (outcome.status !== 'ok') {
        throw new ActionError(outcome.status === 'unknown' ? 1501 : 1500, outcome.error ?? 'QQ recall failed');
    }
    return null;
}
