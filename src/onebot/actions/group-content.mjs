import { ActionError, qqId } from './shared.mjs';
import { oneBotMessageId } from './message-params.mjs';
import { boundedText, groupOperation } from './group-operation.mjs';

const groupId = params => qqId(params.group_id, 'group_id');

export function getGroupNotice(params, account, { request }) {
    return groupOperation(request, account, 'get-group-notice', { group: groupId(params) });
}

export function deleteGroupNotice(params, account, { request }) {
    return groupOperation(request, account, 'delete-group-notice', { group: groupId(params),
        noticeId: boundedText(params.notice_id ?? params.fid, 'notice_id', 256) });
}

export async function getEssenceMsgList(params, account, { request, ids, formatRecord }) {
    const group = groupId(params);
    const rows = await groupOperation(request, account, 'get-essence-list', { group });
    const messages = [];
    for (const { record, ...row } of rows) {
        const message = record && await formatRecord(account, record);
        const messageId = message?.message_id ?? await ids.get(account, 'essence', group,
            String(row.msg_seq) + String(row.msg_random + 0x80000000).padStart(10, '0'));
        messages.push({ ...row, message_id: messageId, content: message?.message ?? row.content });
    }
    return messages;
}

function essenceNumber(value, name, min, max) {
    if ((typeof value !== 'string' && !Number.isInteger(value)) || !/^-?\d{1,10}$/.test(String(value)) ||
        Number(value) < min || Number(value) > max) throw new ActionError(1400, 'Invalid ' + name);
    return Number(value);
}

function changeEssence(params, account, { ids, request }, add) {
    if (!add && params.msg_seq !== undefined && params.msg_random !== undefined && params.group_id !== undefined) {
        return groupOperation(request, account, 'change-group-essence', { add, group: groupId(params),
            seq: essenceNumber(params.msg_seq, 'msg_seq', 1, 0xffffffff),
            random: essenceNumber(params.msg_random, 'msg_random', -0x80000000, 0xffffffff) });
    }
    const reference = ids.resolve(account, oneBotMessageId(params.message_id));
    if (!reference || reference.parentId || (reference.kind !== 'group' && (add || reference.kind !== 'essence'))) {
        throw new ActionError(1404, 'Group message was not found for this account');
    }
    const { peer: group, nativeId } = reference;
    const source = reference.kind === 'essence'
        ? { seq: Number(nativeId.slice(0, -10)), random: Number(nativeId.slice(-10)) - 0x80000000 } : { reference };
    return groupOperation(request, account, 'change-group-essence', { add, group, ...source });
}

export const setEssenceMsg = (params, account, dependencies) => changeEssence(params, account, dependencies, true);
export const deleteEssenceMsg = (params, account, dependencies) => changeEssence(params, account, dependencies, false);
