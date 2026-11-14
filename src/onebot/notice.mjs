function qqNumber(value) {
    return /^[1-9]\d{4,11}$/.test(String(value)) ? Number(value) : undefined;
}

function resolveUser(account, request) {
    return async (uin, uid, group) => {
        const number = qqNumber(uin);
        if (number || typeof uid !== 'string' || !/^u_[\w-]+$/.test(uid)) return number;
        const result = await request(account, 'resolve-mention', { reference: { uid, ...(group ? { group } : {}) } });
        return result.status === 'ok' ? qqNumber(result.uin) : undefined;
    };
}

export async function toOneBotRecall(account, record, { ids, request }) {
    const resolve = resolveUser(account, request);
    const group = record.chatType === 2;
    const peer = group ? qqNumber(record.peerUin) : await resolve(record.peerUin, record.peerUid);
    if (!peer) return;
    const base = { time: record.time, self_id: Number(account), post_type: 'notice' };
    if (!group) {
        const messageId = await ids.get(account, 'private', String(peer), record.msgId);
        return { ...base, notice_type: 'friend_recall', user_id: peer, message_id: messageId };
    }
    const [user, operator] = await Promise.all([
        resolve(record.senderUin, record.senderUid),
        resolve(record.operatorUin, record.operatorUid),
    ]);
    if (!user || !operator) return;
    const messageId = await ids.get(account, 'group', String(peer), record.msgId);
    return { ...base, notice_type: 'group_recall', group_id: peer, user_id: user, operator_id: operator,
        message_id: messageId };
}

export async function toOneBotNotice(account, record, { ids, request, onUnresolved }) {
    if (record.type === 'recall') return toOneBotRecall(account, record, { ids, request });
    const base = { time: record.time, self_id: Number(account), post_type: 'notice' };
    const group = record.chatType === 2;
    const resolve = resolveUser(account, request);
    if (['group-increase', 'group-decrease', 'group-ban'].includes(record.type)) {
        const groupId = qqNumber(record.peerUin);
        if (!groupId) return;
        const [user, operator] = await Promise.all([
            record.type === 'group-ban' && !record.userUid ? 0 : resolve(undefined, record.userUid, record.peerUin),
            resolve(undefined, record.operatorUid, record.peerUin),
        ]);
        if (user === undefined) return;
        const common = { ...base, group_id: groupId, user_id: user,
            operator_id: operator ?? (record.type === 'group-decrease' && !record.operatorUid ? user : 0) };
        if (record.type === 'group-ban') return { ...common, notice_type: 'group_ban',
            sub_type: record.duration ? 'ban' : 'lift_ban', duration: record.duration };
        if (record.type === 'group-increase') return { ...common, notice_type: 'group_increase',
            sub_type: record.change === 131 ? 'invite' : 'approve' };
        return { ...common, notice_type: 'group_decrease', sub_type: record.operatorUid
            ? user === Number(account) ? 'kick_me' : 'kick' : 'leave' };
    }
    if (record.type === 'poke' || record.type === 'poke-recall') {
        const [sender, target, peer] = await Promise.all([
            resolve(record.sender, record.sender, group ? record.peerUin : undefined),
            resolve(record.target, record.target, group ? record.peerUin : undefined),
            group ? qqNumber(record.peerUin) : resolve(record.peerUin, record.peerUid),
        ]);
        if (!sender || !target || !peer) return;
        const kind = group ? 'group' : 'private';
        const pokeId = sender === Number(account)
            ? await ids.get(account, 'poke-' + kind, String(peer), record.msgId) : undefined;
        const extension = pokeId ? { poke_id: pokeId } : {};
        if (record.type === 'poke-recall') {
            return { ...base, notice_type: 'notify', sub_type: 'poke_recall', user_id: sender, target_id: target,
                raw_info: record.items, ...(group && { group_id: peer }), ...extension };
        }
        return { ...base, notice_type: 'notify', sub_type: 'poke', target_id: target, raw_info: record.items,
            ...(group ? { group_id: peer, user_id: sender } : { user_id: peer, sender_id: sender }), ...extension };
    }
    if (record.type === 'emoji-like' && group) {
        const groupId = qqNumber(record.peerUin);
        if (!groupId) return onUnresolved?.('群号无效');
        const peer = String(groupId);
        const knownId = record.nativeId || ids.findGroupMessage?.(account, peer, record.seq);
        const [userId, result] = await Promise.all([
            resolve(record.senderUin, record.senderUid, peer),
            knownId ? { status: 'ok', nativeId: knownId } : request(account, 'resolve-reaction', {
                reference: { kind: 'group', peer, seq: record.seq },
            }),
        ]);
        if (!userId || result.status !== 'ok') {
            const missing = [!userId && '操作者 QQ 号', result.status !== 'ok' && '原消息'].filter(Boolean).join('、');
            onUnresolved?.(missing);
            return;
        }
        const messageId = await ids.get(account, 'group', peer, result.nativeId, { seq: record.seq || undefined });
        const isAdd = record.isAdd ?? true;
        return { ...base, notice_type: 'group_msg_emoji_like', sub_type: isAdd ? 'add' : 'remove', group_id: groupId,
            user_id: userId, operator_id: userId, message_id: messageId,
            ...(record.seq ? { message_seq: record.seq } : {}), is_add: isAdd,
            likes: [{ emoji_id: record.emojiId, count: record.count ?? 1 }] };
    }
}

export async function toOneBotRequest(account, record, request, flag) {
    const user = await resolveUser(account, request)(undefined, record.userUid, record.peerUin);
    const group = record.kind === 'group' ? qqNumber(record.peerUin) : undefined;
    if (!user || (record.kind === 'group' && !group)) return;
    return { time: record.time, self_id: Number(account), post_type: 'request', request_type: record.kind,
        user_id: user, comment: record.comment, flag,
        ...(group && { group_id: group, sub_type: record.subtype }) };
}
