import { ActionError, booleanParam, qqId } from './shared.mjs';
import { isAbsolute } from 'node:path';

function imageSource(file) {
    return typeof file === 'string' && (/^(?:base64:\/\/|data:image\/|https?:\/\/|file:\/\/)/i.test(file) ||
        isAbsolute(file));
}

function mediaSource(data, acceptsAudio = false) {
    return [data?.file, data?.url, data?.path].find(file =>
        imageSource(file) || (acceptsAudio && typeof file === 'string' && /^data:audio\//i.test(file)));
}

export function oneBotMessageId(value) {
    if (typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value)) value = Number(value);
    if (!Number.isInteger(value) || value < 1 || value > 0x7fffffff) {
        throw new ActionError(1400, 'Invalid message_id');
    }
    return value;
}

export const MAX_ACTION_BYTES = 14 * 1024 * 1024;

function unescapeCQ(text, parameter = false) {
    const entities = { '&#91;': '[', '&#93;': ']', '&amp;': '&', '&#44;': ',' };
    return text.replace(parameter ? /&#91;|&#93;|&amp;|&#44;/g : /&#91;|&#93;|&amp;/g,
        entity => entities[entity]);
}

function parseCQ(message) {
    const segments = [];
    let offset = 0;
    const text = value => {
        if (value.includes('[CQ:')) throw new ActionError(1400, 'Malformed CQ code');
        if (value) segments.push({ type: 'text', data: { text: unescapeCQ(value) } });
    };
    for (const match of message.matchAll(/\[CQ:([a-z_]+)((?:,[^\[\]]*)?)\]/g)) {
        text(message.slice(offset, match.index));
        const data = Object.create(null);
        for (const field of match[2].slice(1).split(',').filter(Boolean)) {
            const equals = field.indexOf('=');
            if (equals < 1 || Object.hasOwn(data, field.slice(0, equals))) {
                throw new ActionError(1400, 'Malformed CQ parameter');
            }
            data[field.slice(0, equals)] = unescapeCQ(field.slice(equals + 1), true);
        }
        segments.push({ type: match[1], data });
        offset = match.index + match[0].length;
    }
    text(message.slice(offset));
    return segments;
}

export function messageRequest(params, kind, textLimit = 1024) {
    const field = kind === 'group' ? 'group_id' : 'user_id';
    const peer = qqId(params[field], field);
    const { message, auto_escape: autoEscape = false } = params;
    const escape = booleanParam(autoEscape, 'auto_escape');
    const input = typeof message === 'string'
        ? escape ? [{ type: 'text', data: { text: message } }] : parseCQ(message)
        : message && typeof message === 'object' && !Array.isArray(message) ? [message] : message;
    if (!Array.isArray(input) || !input.length || input.length > 16) {
        throw new ActionError(1400, 'Expected 1–16 message segments');
    }
    let textBytes = 0;
    let visible = false;
    let images = 0;
    const segments = input.map((segment, index) => {
        const { type, data } = segment ?? {};
        switch (type) {
            case 'text':
                if (typeof data?.text !== 'string' || data.text.includes('\0')) {
                    throw new ActionError(1400, 'Invalid text segment');
                }
                textBytes += Buffer.byteLength(data.text);
                visible ||= !!data.text.trim();
                return { type, data: { text: data.text } };
            case 'image': {
                const file = mediaSource(data);
                const subType = String(data?.sub_type ?? 0);
                if (!imageSource(file) || file.includes('\0') ||
                    (data.type !== undefined && data.type !== '') || !/^[0-7]$/.test(subType) ||
                    (data.summary !== undefined && (typeof data.summary !== 'string' ||
                        Buffer.byteLength(data.summary) > 160 || data.summary.includes('\0'))) || ++images > 4) {
                    throw new ActionError(1400, 'Invalid image segment or more than four images');
                }
                visible = true;
                return { type, data: { file, subType: Number(subType), summary: data.summary ?? '' } };
            }
            case 'json': {
                let card;
                try {
                    card = typeof data?.data === 'string' ? JSON.parse(data.data) : data?.data;
                } catch {}
                const raw = typeof data?.data === 'string' ? data.data : JSON.stringify(card);
                if (!card || typeof card !== 'object' || Array.isArray(card) || Buffer.byteLength(raw) > 24 * 1024) {
                    throw new ActionError(1400, 'Expected an Ark JSON object of at most 24 KiB');
                }
                visible = true;
                return { type, data: { data: raw } };
            }
            case 'music': {
                const { type: platform, id } = data ?? {};
                if (typeof platform !== 'string' || platform === 'custom' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(platform) ||
                    (typeof id !== 'string' && !Number.isSafeInteger(id)) ||
                    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(String(id)) ||
                    (typeof id === 'number' && id <= 0)) {
                    throw new ActionError(1400, 'Expected music.type and a valid music.id');
                }
                visible = true;
                return { type, data: { type: platform, id: String(id) } };
            }
            case 'file':
            case 'record':
            case 'video': {
                const file = mediaSource(data, type === 'record');
                const thumb = type === 'video' ? data?.thumb : undefined;
                const name = data?.name ?? '';
                if (!file || file.includes('\0') ||
                    (thumb !== undefined && (!imageSource(thumb) || thumb.includes('\0'))) ||
                    typeof name !== 'string' || /[\\/:*?"<>|\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 160) {
                    throw new ActionError(1400, 'Invalid file or video source');
                }
                visible = true;
                return { type, data: { file, thumb, name } };
            }
            case 'markdown': {
                const content = data?.content;
                if (typeof content !== 'string' || !content.trim() || content.includes('\0') ||
                    Buffer.byteLength(content) > 24 * 1024) {
                    throw new ActionError(1400, 'Expected Markdown content of at most 24 KiB');
                }
                visible = true;
                return { type, data: { content } };
            }
            case 'contact': {
                const contactType = data?.type ?? 'qq';
                if (contactType !== 'qq' && contactType !== 'group') {
                    throw new ActionError(1400, 'Invalid contact.type');
                }
                visible = true;
                return { type, data: { type: contactType, id: qqId(data?.id, 'contact.id') } };
            }
            case 'mface': {
                const { emoji_id, emoji_package_id, key, summary = '[商城表情]' } = data ?? {};
                if (typeof emoji_id !== 'string' || !/^[a-f0-9]{32}$/i.test(emoji_id) ||
                    !/^\d{1,10}$/.test(String(emoji_package_id)) || typeof key !== 'string' || !key ||
                    Buffer.byteLength(key) > 128 || typeof summary !== 'string' || Buffer.byteLength(summary) > 160 ||
                    key.includes('\0') || summary.includes('\0')) {
                    throw new ActionError(1400, 'Invalid market face segment');
                }
                visible = true;
                return { type, data: { emoji_id, emoji_package_id: Number(emoji_package_id), key, summary } };
            }
            case 'dice':
            case 'rps':
                visible = true;
                return { type, data: {} };
            case 'at':
                if (kind !== 'group') throw new ActionError(1400, 'Mention segments require a group conversation');
                visible = true;
                return { type, data: { qq: data?.qq === 'all' ? 'all' : qqId(data?.qq, 'at.qq') } };
            case 'face': {
                const { id: face, resultId, chainCount } = data ?? {};
                if ((typeof face !== 'number' && typeof face !== 'string') || !/^\d{1,4}$/.test(String(face)) ||
                    (resultId !== undefined && ((typeof resultId !== 'number' && typeof resultId !== 'string') ||
                        !/^\d{1,10}$/.test(String(resultId)))) ||
                    (chainCount !== undefined && ((typeof chainCount !== 'number' && typeof chainCount !== 'string') ||
                        !/^\d{1,10}$/.test(String(chainCount)) || Number(chainCount) > 0xffffffff))) {
                    throw new ActionError(1400, 'Invalid face segment');
                }
                visible = true;
                return { type, data: { id: Number(face),
                    ...(resultId !== undefined ? { resultId: String(resultId) } : {}),
                    ...(chainCount !== undefined ? { chainCount: Number(chainCount) } : {}) } };
            }
            case 'reply':
                if (index !== 0) throw new ActionError(1400, 'A reply segment must be first');
                if (kind === 'group' && data?.seq !== undefined) {
                    const { seq } = data;
                    if ((typeof seq !== 'string' && !Number.isSafeInteger(seq)) ||
                        !/^[1-9]\d{0,23}$/.test(String(seq))) {
                        throw new ActionError(1400, 'Invalid group reply sequence');
                    }
                    return { type, data: { seq: String(seq) } };
                }
                return { type, data: { id: oneBotMessageId(data?.id) } };
            default:
                throw new ActionError(1400, 'Unsupported message segment');
        }
    });
    if (!visible || textBytes > textLimit) {
        throw new ActionError(1400, `Message must have content and at most ${textLimit} bytes of text`);
    }
    return { peer, segments };
}
