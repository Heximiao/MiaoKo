import { qqId } from './shared.mjs';
import { queryProfile, userInfo } from './profiles.mjs';

export async function getFriendList(_params, account, { request }) {
    const { friends } = await queryProfile(request, account, 'get-friend-list', {}, {});
    return friends.map(friend => ({
        user_id: Number(friend.user), nickname: friend.nickname, remark: friend.remark,
    }));
}

export async function getStrangerInfo(params, account, { request }) {
    const user = qqId(params.user_id, 'user_id');
    const { profile } = await queryProfile(request, account, 'get-user-profile', params, { user });
    return userInfo(profile, user);
}
