function id(value, name) {
    const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(number) || number <= 0) {
        throw new Error('Invalid OneBot ' + name);
    }
    return number;
}

export function toOneBotMessage(event) {
    const { kind, text, time, segments } = event;
    if ((kind !== 'group' && kind !== 'private') || typeof text !== 'string' ||
        !Number.isSafeInteger(time) || time <= 0) {
        throw new Error('Invalid incoming text message');
    }
    const userId = id(event.userId, 'user ID');
    const message = {
        time,
        self_id: id(event.selfId, 'self ID'),
        post_type: 'message',
        message_type: kind,
        sub_type: kind === 'group' ? 'normal' : 'friend',
        message_id: id(event.messageId, 'message ID'),
        user_id: userId,
        message: segments ?? [{ type: 'text', data: { text } }],
        raw_message: segments ? segments.map(cqSegment).join('') : text,
        font: 0,
        sender: { user_id: userId, nickname: event.nickname ?? String(userId) },
    };
    if (kind === 'group') {
        message.group_id = id(event.groupId, 'group ID');
        message.anonymous = null;
        if (event.groupName) message.group_name = event.groupName;
        if (event.card !== undefined) message.sender.card = event.card;
    }
    return message;
}

function cqSegment(segment) {
    const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
    if (segment.type === 'text') return escape(segment.data.text);
    const params = Object.entries(segment.data).map(([key, value]) =>
        `,${key}=${escape(value).replaceAll(',', '&#44;')}`);
    return `[CQ:${segment.type}${params.join('')}]`;
}

export async function toOneBotRecord(account, record, { ids, images, request, replyRecords }, location,
    { disableUrl = false } = {}) {
    const kind = record.chatType === 2 ? 'group' : 'private';
    if (kind === 'group' && record.msgSeq && !location?.seq) location = { ...location, seq: record.msgSeq };
    const reference = { kind, peer: record.peerUin, nativeId: record.msgId, ...location };
    async function mediaLink(segment) {
        if (!images) return {};
        const metadata = { name: segment.name, size: segment.size, fileId: segment.fileId };
        if (!images.register) {
            const url = !disableUrl ? images.link(account, reference, segment.elementId, segment.type, metadata) : undefined;
            return { url, token: url?.split('/').at(-1) };
        }
        const token = images.register(account, reference, segment.elementId, segment.type, metadata);
        return { token, url: !disableUrl ? await images.url(token) : undefined };
    }
    let segments;
    if (record.segments) {
        segments = [];
        for (const segment of record.segments) {
            switch (segment.type) {
                case 'text':
                    segments.push({ type: 'text', data: { text: segment.text } });
                    break;
                case 'face':
                    segments.push({ type: 'face', data: { id: String(segment.id),
                        ...(segment.resultId ? { resultId: segment.resultId } : {}),
                        ...(segment.chainCount ? { chainCount: Number(segment.chainCount) } : {}) } });
                    break;
                case 'at': {
                    let qq = segment.qq === 'self' ? account : segment.qq;
                    if (!qq && segment.uid) {
                        const result = await request(account, 'resolve-mention', {
                            reference: { ...reference, uid: segment.uid },
                        });
                        qq = result.uin;
                    }
                    segments.push(qq ? { type: 'at', data: { qq } }
                        : { type: 'text', data: { text: segment.text } });
                    break;
                }
                case 'reply': {
                    const { nativeId, seq } = segment;
                    const parentId = reference.nativeId;
                    const result = await request(account, 'resolve-reply', {
                        reference: { kind, peer: reference.peer, nativeId, seq, parentId },
                    });
                    if (result.status === 'ok' && result.message.msgId !== parentId) {
                        const shortId = await ids.get(account, kind, reference.peer, result.message.msgId,
                            { seq: seq || undefined, parentId });
                        replyRecords?.remember(account, shortId, result.message);
                        const sourceSeq = Number(seq || result.message.msgSeq);
                        segments.push({ type: 'reply', data: { id: String(shortId),
                            ...(kind === 'group' && Number.isSafeInteger(sourceSeq) && sourceSeq > 0
                                ? { seq: sourceSeq } : {}) } });
                    }
                    break;
                }
                case 'image': {
                    const { url, token } = await mediaLink(segment);
                    segments.push({ type: 'image', data: { file: segment.name || url || segment.elementId,
                        ...(token ? { file_id: token } : {}),
                        ...(url ? { url } : {}),
                        ...(segment.size ? { file_size: segment.size } : {}),
                        ...(segment.subType !== undefined ? { sub_type: segment.subType } : {}),
                        ...(segment.summary ? { summary: segment.summary } : {}) } });
                    break;
                }
                case 'json':
                case 'xml':
                    segments.push({ type: segment.type, data: { data: segment.data } });
                    break;
                case 'markdown':
                    segments.push({ type: 'markdown', data: { content: segment.content } });
                    break;
                case 'flashtransfer':
                    segments.push({ type: 'flashtransfer', data: { fileSetId: segment.fileSetId } });
                    break;
                case 'onlinefile':
                    segments.push({ type: 'onlinefile', data: { msgId: reference.nativeId,
                        elementId: segment.elementId, fileName: segment.name, fileSize: segment.size,
                        isDir: segment.isDir } });
                    break;
                case 'poke':
                    segments.push({ type: 'poke', data: { type: segment.pokeType, id: String(segment.id) } });
                    break;
                case 'forward': {
                    const id = await ids.get(account, kind, reference.peer, reference.nativeId, location);
                    segments.push({ type: 'forward', data: { id: String(id) } });
                    break;
                }
                case 'mface': {
                    const emoji = segment.emojiId;
                    if (!/^[a-f0-9]{32}$/i.test(emoji)) break;
                    const url = `https://gxh.vip.qq.com/club/item/parcel/item/${emoji.slice(0, 2)}/${emoji}/raw300.gif`;
                    segments.push({ type: 'image', data: { file: emoji + '.gif',
                        ...(!disableUrl ? { url } : {}), sub_type: 1,
                        emoji_id: emoji, emoji_package_id: segment.packageId, key: segment.key,
                        summary: segment.name } });
                    break;
                }
                case 'dice':
                case 'rps':
                    segments.push({ type: segment.type, data: segment.result === undefined ? {}
                        : { result: String(segment.result) } });
                    break;
                case 'video':
                case 'record':
                case 'file': {
                    const isFile = segment.type === 'file';
                    const { url, token } = !isFile || kind === 'private' ? await mediaLink(segment) : {};
                    segments.push({ type: segment.type, data: {
                        file: segment.name || url || segment.elementId,
                        file_id: isFile && segment.fileId ? segment.fileId : token || segment.elementId,
                        ...(url ? { url } : {}),
                        ...(segment.size ? { file_size: segment.size } : {}),
                        ...(kind === 'group' && isFile && segment.busId ? { busid: Number(segment.busId) } : {}),
                    } });
                    break;
                }
            }
        }
        if (!segments.length) return;
    }
    return toOneBotMessage({
        kind, messageId: await ids.get(account, kind, reference.peer, reference.nativeId, location),
        selfId: account, groupId: reference.peer, userId: record.senderUin, time: Number(record.msgTime),
        text: record.text, nickname: record.senderNickname || record.nickname, card: record.senderCard,
        groupName: record.peerName, segments,
    });
}
