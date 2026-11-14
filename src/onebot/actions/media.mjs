import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import ffmpeg from 'ffmpeg-static';
import { decode } from 'silk-wasm';
import { silkDuration, silkHeader } from '../../qq/actions/messages/image-files.mjs';
import { ActionError, qqId } from './shared.mjs';

const exec = promisify(execFile);
const formats = new Map([['mp3', 'mp3'], ['wav', 'wav'], ['flac', 'flac'],
    ['ogg', 'ogg'], ['m4a', 'ipod'], ['amr', 'amr'], ['wma', 'asf'], ['spx', 'ogg']]);

function lookup(params, account, images, types, peer) {
    const id = params.file_id || params.file;
    if (typeof id !== 'string' || !id.trim() || id.length > 2048) {
        throw new ActionError(1400, 'Expected file or file_id');
    }
    const media = images?.find(account, id, types, peer);
    if (!media) throw new ActionError(1404, 'Media was not found for this account');
    return media;
}

async function convertVoice(bytes, format) {
    const directory = await mkdtemp(join(tmpdir(), 'miaoko-record-'));
    try {
        const input = join(directory, 'input');
        const silk = silkHeader(bytes);
        if (silk) silkDuration(bytes, 15000);
        const pcm = silk ? (await decode(bytes, 24000)).data : bytes;
        await writeFile(input, pcm);
        const output = format === 'm4a' ? join(directory, 'output.m4a') : 'pipe:1';
        const codec = format === 'spx' ? ['-c:a', 'libspeex'] : format === 'amr'
            ? ['-ar', '8000', '-ac', '1', '-c:a', 'libopencore_amrnb'] : [];
        const { stdout } = await exec(ffmpeg, ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file,pipe',
            ...(silk ? ['-f', 's16le', '-ar', '24000', '-ac', '1'] : ['-format_whitelist', 'amr']),
            '-i', input, '-t', '300', ...codec, '-f', formats.get(format), output],
        { encoding: 'buffer', maxBuffer: 24 * 1024 * 1024, timeout: 20000, windowsHide: true });
        return format === 'm4a' ? await readFile(output) : stdout;
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function info(images, media, required = true) {
    const url = await images.url(media.token);
    if (!url && required) throw new ActionError(1500, 'QQ media download URL is unavailable');
    return { ...(url && { file: url, url }), file_id: media.token, file_name: media.name ?? '',
        file_size: Number(media.size) || 0 };
}

export function getImage(params, account, { images }) {
    return info(images, lookup(params, account, images, ['image']));
}

export function getFile(params, account, { images }) {
    return info(images, lookup(params, account, images, ['image', 'record', 'video', 'file']));
}

export async function getPrivateFileUrl(params, account, { images }) {
    const peer = params.user_id === undefined ? undefined : qqId(params.user_id, 'user_id');
    const media = lookup({ file_id: params.file_id }, account, images, ['file'], peer);
    return { url: (await info(images, media)).url };
}

export async function getRecord(params, account, { images }) {
    const format = params.out_format;
    if (format !== undefined && !formats.has(format)) throw new ActionError(1400, 'Invalid out_format');
    const media = lookup(params, account, images, ['record']);
    if (format === undefined) return info(images, media);
    try {
        const original = await images.get(media.token);
        if (!original) throw new Error('Voice file unavailable');
        const converted = await convertVoice(original.bytes, format);
        return { ...await info(images, media, false), out_format: format, base64: converted.toString('base64') };
    } catch {
        throw new ActionError(1500, 'QQ voice file could not be converted to ' + format);
    }
}
