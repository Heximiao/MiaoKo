import { qqId } from './shared.mjs';
import { queryProfile, userInfo } from './profiles.mjs';

function groupInfo(info) {
    return {
        group_id: Number(info.id), group_name: info.name,
        member_count: info.memberCount, max_member_count: info.maxMemberCount,
        ...(info.allMuted === undefined ? {} : { group_all_shut: info.allMuted ? -1 : 0 }),
    };
}

export async function getGroupList(params, account, { request }) {
    const { groups } = await queryProfile(request, account, 'get-group-list', params, {});
    return groups.map(groupInfo);
}

export async function getGroupInfo(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const result = await queryProfile(request, account, 'get-group-info', params, { group });
    return groupInfo(result.group);
}

export async function getGroupDetailInfo(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const { group: info } = await queryProfile(request, account, 'get-group-detail-info', params, { group });
    return { ...info.detail, ...groupInfo(info), group_remark: info.detail.groupRemark ?? '' };
}

function memberInfo(info, user, group) {
    return {
        ...userInfo(info, user), group_id: Number(group), card: info.card ?? '', area: '',
        join_time: Number(info.joinTime) || 0, last_sent_time: Number(info.lastSpeakTime) || 0,
        level: String(info.level ?? ''), role: { 4: 'owner', 3: 'admin' }[info.role] ?? 'member',
        title: info.title ?? '', title_expire_time: 0, unfriendly: false, card_changeable: true,
        ...(info.muteUntil === undefined ? {} : { shut_up_time: info.muteUntil, shut_up_timestamp: info.muteUntil }),
    };
}

export async function getGroupMemberInfo(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const user = qqId(params.user_id, 'user_id');
    const { profile } = await queryProfile(request, account, 'get-group-member', params, { user, group });
    return memberInfo(profile, user, group);
}

export async function getGroupMemberList(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const { members } = await queryProfile(request, account, 'get-group-member-list', params, { group });
    return members.map(info => memberInfo(info, info.user, group));
}
