function newSession(pid) {
    return {
        pid, selfId: null, state: 'starting', messages: [], notices: new Set(), reactions: new Map(),
        pending: [], checking: null,
    };
}

export function createInbox(pids = []) {
    const sessions = new Map(pids.map(pid => [pid, newSession(pid)]));
    return {
        open(pid) {
            sessions.set(pid, newSession(pid));
        },
        bind(pid, selfId) {
            const session = sessions.get(pid);
            if (session.state !== 'starting' || typeof selfId !== 'string' ||
                !/^[1-9][0-9]{4,11}$/.test(selfId)) {
                throw new Error('Invalid account binding');
            }
            session.selfId = selfId;
            session.state = 'receiving';
        },
        beginCheck(pid) {
            const session = sessions.get(pid);
            if (session.state !== 'receiving' || session.checking !== null) return false;
            session.checking = session.pending.splice(0);
            return true;
        },
        hasPending(pid) {
            const session = sessions.get(pid);
            return session.state === 'receiving' && session.checking === null && session.pending.length > 0;
        },
        completeCheck(pid, selfId) {
            const session = sessions.get(pid);
            if (session.state !== 'receiving' || session.checking === null) return;
            const batch = session.checking;
            session.checking = null;
            if (selfId !== session.selfId) {
                session.state = 'account-changed';
                session.pending.length = 0;
                return;
            }
            const published = [];
            for (const message of batch) {
                if (message.type === 'emoji-like' && !message.msgId) {
                    const key = JSON.stringify([message.peerUin, message.seq, message.emojiId,
                        message.senderUid ?? message.senderUin]);
                    const previous = session.reactions.get(key);
                    if (previous && (message.time < previous.time ||
                        (message.isAdd === previous.isAdd && message.time === previous.time))) continue;
                    session.reactions.delete(key);
                    session.reactions.set(key, message);
                    if (session.reactions.size > 200) session.reactions.delete(session.reactions.keys().next().value);
                    published.push(message);
                    continue;
                }
                if (message.type) {
                    const key = JSON.stringify([message.type, message.chatType, message.peerUin || message.peerUid,
                        message.msgId, message.seq, message.emojiId]);
                    if (session.notices.has(key)) continue;
                    session.notices.add(key);
                    if (session.notices.size > 200) session.notices.delete(session.notices.values().next().value);
                    published.push(message);
                    continue;
                }
                if (!session.messages.some(row => row.msgId === message.msgId)) {
                    session.messages.unshift(message);
                    published.push(message);
                }
            }
            session.messages.length = Math.min(100, session.messages.length);
            return published;
        },
        close(pid, state, error) {
            const session = sessions.get(pid);
            if (session.state === 'starting' || session.state === 'receiving') {
                session.state = state;
                if (error) session.error = error;
            }
            session.pending.length = 0;
            session.checking = null;
        },
        receive(pid, message) {
            if (message.pid !== pid) {
                throw new Error('Message PID does not match its pipe');
            }
            const session = sessions.get(pid);
            if (session.state !== 'receiving' && session.state !== 'starting') return;
            if (['recall', 'poke', 'poke-recall', 'emoji-like', 'group-ban', 'group-increase', 'group-decrease',
                'request'].includes(message.type)) {
                const rawReaction = message.type === 'emoji-like' && message.msgId === undefined;
                const validSource = rawReaction
                    ? message.chatType === 2 && /^[1-9]\d{4,11}$/.test(message.peerUin) &&
                        /^[1-9]\d{0,23}$/.test(message.seq) && (/^u_[\w-]+$/.test(message.senderUid) ||
                            (message.source === 'message-update' && /^[1-9]\d{4,11}$/.test(message.senderUin) &&
                                /^[1-9]\d{0,23}$/.test(message.nativeId))) &&
                        /^\d{1,10}$/.test(message.emojiId) && typeof message.isAdd === 'boolean' &&
                        Number.isSafeInteger(message.count) && message.count >= 0
                    : typeof message.msgId === 'string' && /^[1-9]\d{0,23}$/.test(message.msgId);
                if (![1, 2].includes(message.chatType) || !validSource ||
                    !Number.isSafeInteger(message.time) || message.time <= 0) {
                    throw new Error('Invalid QQ notice event');
                }
                session.pending.push(message);
                if (session.pending.length > 200) session.pending.shift();
                return;
            }
            const { chatType, msgId, senderUin, peerUin, msgTime, msgSeq, text, segments } = message;
            if (![1, 2].includes(chatType) || !/^[1-9][0-9]*$/.test(msgId) ||
                !/^[0-9]+$/.test(senderUin) || !/^[0-9]+$/.test(peerUin) ||
                typeof text !== 'string' || (!text && !segments?.length) || !/^\d+$/.test(msgTime) ||
                (segments !== undefined && (!Array.isArray(segments) || segments.length > 32))) {
                throw new Error('Invalid QQ message event');
            }
            session.pending.push({
                chatType, msgId, senderUin, peerUin, msgTime, text,
                ...(typeof msgSeq === 'string' && /^[1-9]\d{0,23}$/.test(msgSeq) ? { msgSeq } : {}),
                ...(segments ? { segments } : {}),
                nickname: typeof message.nickname === 'string' ? message.nickname : '',
                peerName: typeof message.peerName === 'string' ? message.peerName : '',
                ...(typeof message.senderNickname === 'string' ? { senderNickname: message.senderNickname } : {}),
                ...(typeof message.senderCard === 'string' ? { senderCard: message.senderCard } : {}),
            });
            if (session.pending.length > 200) session.pending.shift();
        },
        snapshot() {
            return [...sessions.values()].map(({ pid, selfId, state, messages, error }) => ({
                pid, selfId, state, messages, ...(error ? { error } : {}),
            }));
        },
    };
}
