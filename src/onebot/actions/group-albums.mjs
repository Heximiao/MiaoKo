import { ActionError, qqId } from './shared.mjs';

export async function getQunAlbumList(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const attachInfo = params.attach_info ?? '';
    if (typeof attachInfo !== 'string' || Buffer.byteLength(attachInfo) > 4096 || attachInfo.includes('\0')) {
        throw new ActionError(1400, 'Invalid attach_info');
    }
    const result = await request(account, 'get-group-album-list', { group, attachInfo });
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ album query failed');
    }
    return result.albums;
}

export async function uploadImageToQunAlbum(params, account, { uploadGroupAlbum }) {
    const group = qqId(params.group_id, 'group_id');
    const { album_id: albumId, album_name: albumName = '', file } = params;
    if (typeof albumId !== 'string' || !albumId.trim() || Buffer.byteLength(albumId) > 512 || albumId.includes('\0') ||
        typeof albumName !== 'string' || Buffer.byteLength(albumName) > 512 || albumName.includes('\0') ||
        typeof file !== 'string' || !file || file.includes('\0')) {
        throw new ActionError(1400, 'Expected a valid album_id, album_name and image file');
    }
    const result = await uploadGroupAlbum(account, { group, albumId, albumName, file });
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ album upload failed');
    }
    return null;
}
