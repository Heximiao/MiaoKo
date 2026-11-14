import { ActionError, booleanParam, qqId } from './shared.mjs';
import { oneBotMessageId } from './message-params.mjs';

async function interact(account, request, type, params) {
    const outcome = await request(account, type, params);
    if (outcome.status !== 'ok') {
        throw new ActionError(outcome.status === 'unknown' ? 1501 : 1500, outcome.error ?? 'QQ interaction failed');
    }
    return outcome;
}

async function sendPokeTo(account, { request, ids }, kind, peer, params) {
    const { nativeId } = await interact(account, request, 'send-poke', params);
    if (!nativeId) return {};
    return { poke_id: await ids.get(account, 'poke-' + kind, peer, nativeId) };
}

export function friendPoke(params, account, dependencies) {
    const user = qqId(params.user_id, 'user_id');
    const target = params.target_id === undefined ? user : qqId(params.target_id, 'target_id');
    if (target !== user && target !== account) throw new ActionError(1400, 'target_id must be a chat participant');
    return sendPokeTo(account, dependencies, 'private', user, { user, target });
}

export function groupPoke(params, account, dependencies) {
    const group = qqId(params.group_id, 'group_id');
    const user = qqId(params.user_id, 'user_id');
    const target = params.target_id === undefined ? user : qqId(params.target_id, 'target_id');
    return sendPokeTo(account, dependencies, 'group', group, { group, target });
}

export function sendPoke(params, account, dependencies) {
    return params.group_id === undefined || String(params.group_id) === '0'
        ? friendPoke(params, account, dependencies) : groupPoke(params, account, dependencies);
}

export async function recallPoke(params, account, { ids, request }) {
    const reference = ids.resolve(account, oneBotMessageId(params.poke_id), { poke: true });
    if (!reference || !['poke-private', 'poke-group'].includes(reference.kind)) {
        throw new ActionError(1404, 'Poke was not found for this account');
    }
    const { kind, peer, nativeId } = reference;
    await interact(account, request, 'recall-poke', { reference: { kind: kind.slice(5), peer, nativeId } });
    return {};
}

export async function sendLike(params, account, { request }) {
    const user = qqId(params.user_id, 'user_id');
    const { times = 1 } = params;
    if ((typeof times !== 'string' && !Number.isInteger(times)) || !/^(?:[1-9]|10)$/.test(String(times))) {
        throw new ActionError(1400, 'times must be between 1 and 10');
    }
    await interact(account, request, 'send-profile-like', { user, times: Number(times) });
    return null;
}

export async function setMsgEmojiLike(params, account, { ids, request }) {
    const reference = ids.resolve(account, oneBotMessageId(params.message_id));
    if (!reference) throw new ActionError(1404, 'Message was not found for this account');
    const { emoji_id: emoji, set = true } = params;
    if ((typeof emoji !== 'string' && !Number.isSafeInteger(emoji)) || !/^\d{1,10}$/.test(String(emoji))) {
        throw new ActionError(1400, 'Invalid emoji_id');
    }
    await interact(account, request, 'set-emoji-like', {
        reference, emojiId: String(emoji), set: booleanParam(set, 'set'),
    });
    return { result: true };
}

export async function getEmojiLikes(params, account, { ids, request }) {
    const id = String(params.message_id ?? '');
    const reference = /^[1-9]\d{0,9}$/.test(id) && Number(id) <= 0x7fffffff
        ? ids.resolve(account, oneBotMessageId(id))
        : /^[1-9]\d{0,23}$/.test(id) && typeof params.message_id === 'string'
            ? { kind: 'group', peer: qqId(params.group_id, 'group_id'), nativeId: id } : undefined;
    if (!reference) throw new ActionError(1404, 'Message was not found for this account');
    if (params.group_id !== undefined && (reference.kind !== 'group' ||
        reference.peer !== qqId(params.group_id, 'group_id'))) {
        throw new ActionError(1400, 'Message does not belong to this group');
    }
    const emojiId = String(params.emoji_id ?? '');
    const emojiType = String(params.emoji_type ?? (emojiId.length > 3 ? '2' : '1'));
    const count = String(params.count ?? '0');
    if (!/^\d{1,10}$/.test(emojiId) || !/^[12]$/.test(emojiType) ||
        !/^\d{1,4}$/.test(count) || Number(count) > 3000) {
        throw new ActionError(1400, 'Invalid emoji query');
    }
    const outcome = await interact(account, request, 'get-emoji-likes', {
        reference, emojiId, emojiType, count: Number(count),
    });
    return { emoji_like_list: outcome.likes };
}
