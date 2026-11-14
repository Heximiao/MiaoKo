import { ActionError, booleanParam, qqId } from './shared.mjs';
import { messageRequest } from './message-params.mjs';

function checkOutcome(outcome, status, fallback) {
    if (outcome.status !== status) {
        throw new ActionError(outcome.status === 'unknown' ? 1501 : 1500, outcome.error ?? fallback);
    }
}

export async function uploadGroupFile(params, account, { sendMessage }) {
    const { file, name, folder = params.folder_id ?? '', upload_file: upload = true } = params;
    if (typeof name !== 'string' || !name.trim()) throw new ActionError(1400, 'Expected a file name');
    if (typeof folder !== 'string' || Buffer.byteLength(folder) > 256 || /[\x00-\x1f]/.test(folder)) {
        throw new ActionError(1400, 'Invalid folder ID');
    }
    const { peer, segments } = messageRequest({ group_id: params.group_id,
        message: { type: 'file', data: { file, name } } }, 'group');
    const cache = booleanParam(upload, 'upload_file');
    segments[0].data.groupUpload = { folderId: folder === '/' ? '' : folder, cache };
    const outcome = await sendMessage(account, 'group', peer, segments);
    checkOutcome(outcome, 'sent', 'QQ group file upload failed');
    return { file_id: outcome.fileId ?? null };
}

export async function getGroupRootFiles(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const rawCount = params.file_count ?? 50;
    if ((typeof rawCount !== 'string' && !Number.isSafeInteger(rawCount)) ||
        !/^[1-9]\d{0,3}$/.test(String(rawCount)) || Number(rawCount) > 1000) {
        throw new ActionError(1400, 'Invalid file_count (1–1000)');
    }
    const outcome = await request(account, 'get-group-root-files', { group, count: Number(rawCount) });
    checkOutcome(outcome, 'ok', 'QQ could not read the group file list');
    return { files: outcome.files, folders: outcome.folders };
}

export async function getGroupFileUrl(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const { file_id: fileId, busid = 102 } = params;
    if (Number(group) > 0xffffffff || typeof fileId !== 'string' || !fileId.trim() ||
        Buffer.byteLength(fileId) > 256 || /[\x00-\x1f]/.test(fileId) ||
        (typeof busid !== 'number' && typeof busid !== 'string') ||
        !/^[1-9]\d{0,9}$/.test(String(busid)) || Number(busid) > 0xffffffff) {
        throw new ActionError(1400, 'Invalid group file ID or busid');
    }
    const outcome = await request(account, 'get-group-file-url', { group, fileId, busId: Number(busid) });
    checkOutcome(outcome, 'ok', 'QQ could not resolve the group file URL');
    return { url: outcome.url };
}

export async function createGroupFileFolder(params, account, { request }) {
    const group = qqId(params.group_id, 'group_id');
    const name = params.folder_name ?? params.name;
    if (typeof name !== 'string' || !name.trim() || name === '.' || name === '..' ||
        /[\\/\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 160) {
        throw new ActionError(1400, 'Invalid folder name');
    }
    if ((params.parent_id ?? '/') !== '/') throw new ActionError(1400, 'Expected the root parent ID (/)');
    const outcome = await request(account, 'create-group-file-folder', { group, name });
    checkOutcome(outcome, 'ok', 'QQ could not create the group file folder');
    return { folder_id: outcome.folderId };
}
