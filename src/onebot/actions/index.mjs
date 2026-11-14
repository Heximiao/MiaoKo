import { ActionError, qqId } from './shared.mjs';
import { getLoginInfo, getStatus, getVersionInfo } from './info.mjs';
import { getGroupDetailInfo, getGroupInfo, getGroupList, getGroupMemberInfo, getGroupMemberList } from './group-info.mjs';
import { getGroupIgnoreAddRequest, getGroupIgnoredNotifies, getGroupShutList, setGroupAdmin, setGroupCard,
    setGroupLeave, setGroupMemberInvitePolicy, setGroupMemberPermissions, setGroupName,
    setGroupNewMemberHistoryVisibility, setGroupSpecialTitle } from './group-management.mjs';
import { deleteEssenceMsg, deleteGroupNotice, getEssenceMsgList, getGroupNotice, setEssenceMsg } from './group-content.mjs';
import { cancelGroupTodo, completeGroupTodo, setGroupSign, setGroupTodo } from './group-todo-sign.mjs';
import { createGroupFileFolder, getGroupFileUrl, getGroupRootFiles, uploadGroupFile } from './group-files.mjs';
import { getQunAlbumList, uploadImageToQunAlbum } from './group-albums.mjs';
import { getFriendList, getStrangerInfo } from './friend.mjs';
import { deleteMsg, getMsg, sendGroupMsg, sendMsg, sendPrivateMsg } from './message.mjs';
import { friendPoke, getEmojiLikes, groupPoke, recallPoke, sendLike, sendPoke, setMsgEmojiLike } from './interactions.mjs';
import { getFriendMsgHistory, getGroupMsgHistory } from './history.mjs';
import { getForwardMsg, sendForwardMsg, sendGroupForwardMsg, sendPrivateForwardMsg } from './forward.mjs';
import { getFile, getImage, getPrivateFileUrl, getRecord } from './media.mjs';
import { setFriendAddRequest, setGroupAddRequest, setGroupBan, setGroupKick, setGroupWholeBan } from './moderation.mjs';

const actions = {
    get_group_detail_info: getGroupDetailInfo,
    get_group_info: getGroupInfo,
    get_group_list: getGroupList,
    get_group_member_info: getGroupMemberInfo,
    get_group_member_list: getGroupMemberList,
    get_group_root_files: getGroupRootFiles,
    get_group_file_url: getGroupFileUrl,
    get_private_file_url: getPrivateFileUrl,
    get_image: getImage,
    get_record: getRecord,
    get_file: getFile,
    set_group_ban: setGroupBan,
    set_group_whole_ban: setGroupWholeBan,
    set_group_kick: setGroupKick,
    set_group_leave: setGroupLeave,
    set_group_admin: setGroupAdmin,
    set_group_name: setGroupName,
    set_group_card: setGroupCard,
    set_group_special_title: setGroupSpecialTitle,
    get_group_shut_list: getGroupShutList,
    get_group_ignored_notifies: getGroupIgnoredNotifies,
    get_group_ignore_add_request: getGroupIgnoreAddRequest,
    get_essence_msg_list: getEssenceMsgList,
    set_essence_msg: setEssenceMsg,
    delete_essence_msg: deleteEssenceMsg,
    _get_group_notice: getGroupNotice,
    _del_group_notice: deleteGroupNotice,
    set_group_member_invite_policy: setGroupMemberInvitePolicy,
    set_group_member_permissions: setGroupMemberPermissions,
    set_group_new_member_history_visibility: setGroupNewMemberHistoryVisibility,
    set_group_todo: setGroupTodo,
    complete_group_todo: completeGroupTodo,
    cancel_group_todo: cancelGroupTodo,
    set_group_sign: setGroupSign,
    send_group_sign: setGroupSign,
    set_friend_add_request: setFriendAddRequest,
    set_group_add_request: setGroupAddRequest,
    create_group_file_folder: createGroupFileFolder,
    upload_group_file: uploadGroupFile,
    get_qun_album_list: getQunAlbumList,
    upload_image_to_qun_album: uploadImageToQunAlbum,
    get_friend_list: getFriendList,
    get_stranger_info: getStrangerInfo,
    send_group_msg: sendGroupMsg,
    send_private_msg: sendPrivateMsg,
    send_msg: sendMsg,
    get_msg: getMsg,
    get_group_msg_history: getGroupMsgHistory,
    get_friend_msg_history: getFriendMsgHistory,
    get_forward_msg: getForwardMsg,
    send_forward_msg: sendForwardMsg,
    send_group_forward_msg: sendGroupForwardMsg,
    send_private_forward_msg: sendPrivateForwardMsg,
    delete_msg: deleteMsg,
    friend_poke: friendPoke,
    group_poke: groupPoke,
    send_poke: sendPoke,
    recall_poke: recallPoke,
    send_like: sendLike,
    set_msg_emoji_like: setMsgEmojiLike,
    get_emoji_likes: getEmojiLikes,
    get_login_info: getLoginInfo,
    get_status: getStatus,
    get_version_info: getVersionInfo,
};

export function createActions({ ids, accounts, sendMessage, readMessage, formatRecord, sendForwardBatch,
    uploadGroupAlbum, request, replyRecords, images, pendingRequests }) {
    const dependencies = { ids, sendMessage, readMessage, formatRecord, sendForwardBatch, uploadGroupAlbum, request,
        replyRecords, images, pendingRequests };
    const supports = action => Object.hasOwn(actions, action);
    async function dispatch(request, boundAccount) {
        const echo = request && Object.hasOwn(request, 'echo') ? { echo: request.echo } : {};
        try {
            if (typeof request?.action !== 'string') throw new ActionError(1400, 'Expected an action name');
            if (!supports(request.action)) throw new ActionError(1404, 'Unsupported action');
            const params = request.params === undefined ? {} : request.params;
            if (!params || typeof params !== 'object' || Array.isArray(params)) {
                throw new ActionError(1400, 'Expected an object for params');
            }
            const chosen = params.self_id === undefined ? undefined : qqId(params.self_id, 'self_id');
            if (boundAccount && chosen && boundAccount !== chosen) {
                throw new ActionError(1400, 'self_id does not match this connection');
            }
            const available = accounts();
            const account = boundAccount ?? chosen ?? (available.length === 1 ? available[0] : undefined);
            if (!account || !available.includes(account)) {
                throw new ActionError(1400, 'Select an active QQ account with self_id');
            }
            const data = await actions[request.action](params, account, dependencies);
            return { status: 'ok', retcode: 0, data, ...echo };
        } catch (error) {
            if (!(error instanceof ActionError)) console.error('OneBot action: %s', error.message);
            return { status: 'failed', retcode: error.retcode ?? 1500, data: null,
                message: error instanceof ActionError ? error.message : 'OneBot action failed', ...echo };
        }
    }
    return Object.assign(dispatch, { supports });
}
