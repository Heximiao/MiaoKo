import { ActionError, booleanParam, qqId } from './shared.mjs';
import { boundedText, groupOperation } from './group-operation.mjs';

const groupId = params => qqId(params.group_id, 'group_id');
const userId = params => qqId(params.user_id, 'user_id');
const pendingSettings = new Set();

export function setGroupLeave(params, account, { request }) {
    return groupOperation(request, account, 'set-group-leave', { group: groupId(params),
        dismiss: booleanParam(params.is_dismiss ?? false, 'is_dismiss') });
}

export function setGroupAdmin(params, account, { request }) {
    return groupOperation(request, account, 'set-group-admin', { group: groupId(params), user: userId(params),
        enable: booleanParam(params.enable ?? true, 'enable') });
}

export function setGroupName(params, account, { request }) {
    return groupOperation(request, account, 'set-group-name', { group: groupId(params),
        name: boundedText(params.group_name, 'group_name', 256) });
}

export function setGroupCard(params, account, { request }) {
    return groupOperation(request, account, 'set-group-card', { group: groupId(params), user: userId(params),
        card: boundedText(params.card ?? '', 'card', 256, true) });
}

export async function setGroupSpecialTitle(params, account, { request }) {
    const group = groupId(params);
    const user = userId(params);
    const title = boundedText(params.special_title === undefined ? '' : params.special_title, 'special_title', 256, true);
    const duration = params.duration === undefined ? -1 : params.duration;
    if ((typeof duration !== 'string' && !Number.isInteger(duration)) ||
        !/^(?:-1|\d{1,10})$/.test(String(duration)) || Number(duration) > 0x7fffffff) {
        throw new ActionError(1400, 'Invalid duration');
    }
    if (Number(group) > 0xffffffff) throw new ActionError(1400, 'Invalid group_id');
    await groupOperation(request, account, 'set-group-special-title', { group, user, title, duration: Number(duration) });
    return {};
}

export function getGroupShutList(params, account, { request }) {
    return groupOperation(request, account, 'get-group-shut-list', { group: groupId(params) });
}

export function getGroupIgnoredNotifies(_params, account, { request }) {
    return groupOperation(request, account, 'get-group-ignored-notifies', { doubt: false });
}

export function getGroupIgnoreAddRequest(_params, account, { request }) {
    return groupOperation(request, account, 'get-group-ignored-notifies', { doubt: true });
}

async function changeSettings(request, account, group, settings) {
    const key = `${account}:${group}`;
    if (pendingSettings.has(key)) throw new ActionError(1500, 'A settings change is already pending for this group');
    pendingSettings.add(key);
    try { return await groupOperation(request, account, 'set-group-settings', { group, ...settings }); }
    finally { pendingSettings.delete(key); }
}

export function setGroupMemberInvitePolicy(params, account, { request }) {
    if (!['disabled', 'require_approval', 'no_approval', 'no_approval_under_100'].includes(params.policy)) {
        throw new ActionError(1400, 'Invalid invitation policy');
    }
    return changeSettings(request, account, groupId(params), { policy: params.policy });
}

export function setGroupMemberPermissions(params, account, { request }) {
    const permissions = {};
    for (const [input, key] of [['allow_member_upload_album', 'album'],
        ['allow_member_temporary_session', 'temporarySession'], ['allow_member_create_group', 'createGroup']]) {
        if (params[input] !== undefined) permissions[key] = booleanParam(params[input], input);
    }
    if (!Object.keys(permissions).length) throw new ActionError(1400, 'Expected at least one member permission');
    return changeSettings(request, account, groupId(params), { permissions });
}

export function setGroupNewMemberHistoryVisibility(params, account, { request }) {
    return changeSettings(request, account, groupId(params), {
        visible: booleanParam(params.visible, 'visible') });
}
