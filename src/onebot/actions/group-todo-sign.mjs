import { ActionError, qqId } from './shared.mjs';
import { oneBotMessageId } from './message-params.mjs';
import { groupOperation } from './group-operation.mjs';

const groupId = params => qqId(params.group_id, 'group_id');

function groupTodo(operation, params, account, { ids, request }) {
    const group = groupId(params);
    if (Number(group) > 0xffffffff) throw new ActionError(1400, 'Invalid group_id');
    let source;
    if (params.message_seq !== undefined) {
        const seq = String(params.message_seq);
        if ((typeof params.message_seq !== 'string' && !Number.isSafeInteger(params.message_seq)) ||
            !/^[1-9]\d{0,19}$/.test(seq) || BigInt(seq) > 0xffffffffffffffffn) {
            throw new ActionError(1400, 'Invalid message_seq');
        }
        source = { seq };
    } else {
        const reference = ids.resolve(account, oneBotMessageId(params.message_id));
        if (reference?.kind !== 'group' || reference.peer !== group || reference.parentId) {
            throw new ActionError(1404, 'Group message was not found for this account and group');
        }
        source = { reference };
    }
    return groupOperation(request, account, 'group-todo', { operation, group, ...source });
}

export const setGroupTodo = (params, account, deps) => groupTodo(1, params, account, deps);
export const completeGroupTodo = (params, account, deps) => groupTodo(2, params, account, deps);
export const cancelGroupTodo = (params, account, deps) => groupTodo(3, params, account, deps);

export function setGroupSign(params, account, { request }) {
    return groupOperation(request, account, 'group-sign', { group: groupId(params) });
}

