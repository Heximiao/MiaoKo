import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { open, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { encode } from 'silk-wasm';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_BYTES = 32 * 1024 * 1024;
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const exec = promisify(execFile);

function jpegSize(bytes) {
    let index = 2;
    while (index + 4 <= bytes.length && bytes[index++] === 0xff) {
        while (bytes[index] === 0xff) index++;
        const marker = bytes[index++];
        if (marker === 0xda || marker === 0xd9 || index + 2 > bytes.length) break;
        const length = bytes.readUInt16BE(index);
        if (length < 2 || index + length > bytes.length) break;
        if ((marker === 0xc0 || marker === 0xc1 || marker === 0xc2) && length >= 8) {
            return { height: bytes.readUInt16BE(index + 3), width: bytes.readUInt16BE(index + 5),
                extension: 'jpg', picType: marker === 0xc2 ? 1003 : 1000 };
        }
        index += length;
    }
}

export function imageFormat(bytes) {
    if (bytes.length >= 33 && bytes.subarray(0, 8).equals(pngSignature) &&
        bytes.readUInt32BE(8) === 13 && bytes.toString('ascii', 12, 16) === 'IHDR') {
        let picType = 1001;
        for (let offset = 8; offset + 12 <= bytes.length;) {
            const type = bytes.toString('ascii', offset + 4, offset + 8);
            if (type === 'IDAT' || type === 'IEND') break;
            if (type === 'acTL' && bytes.readUInt32BE(offset) === 8 && offset + 20 <= bytes.length) {
                picType = 2001;
                break;
            }
            offset += 12 + bytes.readUInt32BE(offset);
        }
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), extension: 'png', picType };
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
    if (bytes.length >= 13 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) {
        return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), extension: 'gif', picType: 2000 };
    }
    if (bytes.length >= 26 && bytes.toString('latin1', 0, 2) === 'BM') {
        const headerSize = bytes.readUInt32LE(14);
        if (headerSize === 12) {
            return { width: bytes.readUInt16LE(18), height: bytes.readUInt16LE(20), extension: 'bmp', picType: 1005 };
        }
        if (headerSize >= 40 && 14 + headerSize <= bytes.length) {
            return { width: bytes.readInt32LE(18), height: Math.abs(bytes.readInt32LE(22)),
                extension: 'bmp', picType: 1005 };
        }
    }
    if (bytes.length < 25 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
        bytes.toString('latin1', 8, 12) !== 'WEBP') return;
    const format = { extension: 'webp', picType: 1002 };
    switch (bytes.toString('latin1', 12, 16)) {
        case 'VP8X':
            if (bytes.length >= 30) return { ...format,
                width: 1 + bytes.readUIntLE(24, 3), height: 1 + bytes.readUIntLE(27, 3) };
            break;
        case 'VP8L':
            if (bytes[20] === 0x2f) return { ...format, width: 1 + (bytes.readUInt16LE(21) & 0x3fff),
                height: 1 + ((bytes.readUIntLE(22, 3) >>> 6) & 0x3fff) };
            break;
        case 'VP8 ':
            if (bytes.length >= 30 && bytes.readUIntBE(23, 3) === 0x9d012a) return { ...format,
                width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
            break;
    }
}

export class InvalidImage extends Error {}

async function readMedia(source, limit = MAX_IMAGE_BYTES) {
    const inline = /^(?:base64:\/\/|data:(?:image|audio)\/[a-z0-9.+-]+;base64,)/i.exec(source);
    if (inline) {
        const base64 = source.slice(inline[0].length);
        if (!base64 || base64.length > Math.ceil(limit / 3) * 4 ||
            !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new InvalidImage('Invalid or oversized Base64 image');
        const bytes = Buffer.from(base64, 'base64');
        if (bytes.toString('base64').replace(/=+$/, '') !== base64.replace(/=+$/, '')) {
            throw new InvalidImage('Invalid Base64 image encoding');
        }
        return bytes;
    }
    if (/^https?:\/\//i.test(source)) {
        try {
            const response = await fetch(source, { signal: AbortSignal.timeout(10000) });
            if (!response.ok || !response.body || Number(response.headers.get('content-length')) > limit) {
                await response.body?.cancel();
                throw new InvalidImage('Unable to download media within the size limit');
            }
            const chunks = [];
            let length = 0;
            for await (const chunk of response.body) {
                length += chunk.length;
                if (length > limit) throw new InvalidImage('Media exceeds the size limit');
                chunks.push(chunk);
            }
            return Buffer.concat(chunks, length);
        } catch (error) {
            if (error instanceof InvalidImage) throw error;
            throw new InvalidImage('Unable to download media');
        }
    }
    try {
        const path = /^file:\/\//i.test(source) ? fileURLToPath(source) : source;
        if (!isAbsolute(path) || /^[\\/]{2}/.test(path)) throw new Error('Expected a local absolute path');
        const file = await open(path, 'r');
        try {
            const info = await file.stat();
            if (!info.isFile() || info.size > limit) throw new Error('Invalid file size');
            const { buffer, bytesRead } = await file.read({ buffer: Buffer.alloc(info.size + 1), position: 0 });
            return buffer.subarray(0, bytesRead);
        } finally {
            await file.close();
        }
    } catch {
        throw new InvalidImage('Unable to read a local file within the size limit');
    }
}

async function prepareVideo(path, data, bytes) {
    if (bytes.toString('latin1', 4, 8) !== 'ftyp') throw new InvalidImage('Expected MP4 video');
    const options = { windowsHide: true, timeout: 12000 };
    const thumbnail = path + '.png';
    try {
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-protocol_whitelist', 'file',
            '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration',
            '-of', 'json', path], options);
        const info = JSON.parse(stdout);
        const { width, height } = info.streams[0];
        const seconds = Number(info.format.duration);
        if (!width || !height || width * height > 40_000_000 || !Number.isFinite(seconds) || seconds <= 0) {
            throw new Error('Invalid video metadata');
        }
        if (data.thumb) {
            const bytes = await readMedia(data.thumb);
            if (imageFormat(bytes)?.extension !== 'png') throw new Error('Expected a PNG thumbnail');
            await writeFile(thumbnail, bytes, { flag: 'wx' });
        } else {
            await exec('ffmpeg', ['-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', path,
                '-map', '0:v:0', '-frames:v', '1', '-update', '1', thumbnail], options);
        }
        const thumbnailBytes = await readMedia(thumbnail);
        const size = imageFormat(thumbnailBytes);
        if (!size?.width || !size.height) throw new Error('Invalid thumbnail dimensions');
        return { duration: Math.ceil(seconds), width, height, thumbnail, thumbSize: thumbnailBytes.length,
            thumbWidth: size.width, thumbHeight: size.height,
            thumbMd5: createHash('md5').update(thumbnailBytes).digest('hex') };
    } catch (error) {
        if (error.code === 'ENOENT') throw new InvalidImage('MP4 sending requires ffmpeg and ffprobe on PATH');
        throw new InvalidImage('Unable to prepare MP4 video or PNG thumbnail');
    }
}

export function silkHeader(bytes) {
    const headerStart = bytes[0] === 2 ? 1 : 0;
    return bytes.toString('ascii', headerStart, headerStart + 9) === '#!SILK_V3' ? headerStart + 9 : 0;
}

export function silkDuration(bytes, maxPackets = Infinity) {
    let offset = silkHeader(bytes);
    if (!offset) throw new InvalidImage('Expected a SILK V3 voice file');
    let packets = 0;
    while (offset + 2 <= bytes.length) {
        const length = bytes.readInt16LE(offset);
        offset += 2;
        if (length === -1 && offset === bytes.length) break;
        if (length < 0 || offset + length > bytes.length) throw new InvalidImage('Invalid SILK packet');
        offset += length;
        if (++packets > maxPackets) throw new InvalidImage('SILK voice file exceeds the duration limit');
    }
    if (!packets || offset !== bytes.length) throw new InvalidImage('Invalid SILK voice file');
    return Math.ceil(packets / 50);
}

async function encodeVoice(bytes, input) {
    if (silkHeader(bytes)) return bytes;
    if (!ffmpegPath) throw new InvalidImage('The bundled FFmpeg does not support this platform');
    const sampleRate = 24000;
    const maxSeconds = 300;
    await writeFile(input, bytes, { flag: 'wx' });
    try {
        // Restrict demuxers to standalone audio containers and block secondary input protocols.
        const { stdout: pcm } = await exec(ffmpegPath, [
            '-nostdin', '-v', 'error', '-xerror', '-protocol_whitelist', 'file',
            '-format_whitelist', 'wav,mp3,aac,mov,flac,ogg,matroska,webm,amr,asf',
            '-i', input, '-map', '0:a:0', '-t', String(maxSeconds + 1),
            '-ar', String(sampleRate), '-ac', '1', '-f', 's16le', 'pipe:1',
        ], { windowsHide: true, timeout: 20000, encoding: 'buffer',
            maxBuffer: (maxSeconds + 2) * sampleRate * 2 });
        if (!pcm.length || pcm.length > maxSeconds * sampleRate * 2) {
            throw new InvalidImage('Audio must be between 0 and 300 seconds');
        }
        const frameBytes = sampleRate * 2 / 50;
        const frames = Buffer.alloc(Math.ceil(pcm.length / frameBytes) * frameBytes);
        pcm.copy(frames);
        const { data } = await encode(frames, sampleRate);
        return Buffer.from(data);
    } catch (error) {
        if (error instanceof InvalidImage) throw error;
        if (error.code === 'ENOENT') throw new InvalidImage('Bundled FFmpeg is missing. Run npm ci with install scripts enabled');
        throw new InvalidImage('Unable to transcode audio to SILK V3');
    } finally {
        await rm(input, { force: true });
    }
}

export async function prepareMedia(root, segments) {
    if (!segments.some(segment => ['image', 'video', 'file', 'record'].includes(segment.type))) {
        return { segments, async close() {} };
    }
    await mkdir(root, { recursive: true });
    const directory = await mkdtemp(join(root, 'message-'));
    const cleanup = () => rm(directory, { recursive: true, force: true });
    const prepared = [];
    let total = 0;
    let mediaTotal = 0;
    try {
        for (const segment of segments) {
            const { type, data } = segment;
            if (type === 'video' || type === 'file' || type === 'record') {
                let bytes = await readMedia(data.file, MAX_MEDIA_BYTES);
                mediaTotal += bytes.length;
                if (!bytes.length || mediaTotal > MAX_MEDIA_BYTES) throw new InvalidImage('Media exceeds the 32 MiB limit');
                if (type === 'record') bytes = await encodeVoice(bytes, join(directory, 'audio-input'));
                const md5 = createHash('md5').update(bytes).digest('hex');
                let name = data.name;
                if (!name && type === 'file') {
                    try {
                        name = /^(?:file|https?):\/\//i.test(data.file)
                            ? decodeURIComponent(basename(new URL(data.file).pathname))
                            : isAbsolute(data.file) ? basename(data.file) : '';
                    } catch {}
                }
                if (!name || /[\\/:*?"<>|\x00-\x1f]/.test(name) || Buffer.byteLength(name) > 160) name = md5;
                const extension = type === 'video' ? '.mp4' : type === 'record' ? '.silk' : '';
                const fileName = extension && !name.toLowerCase().endsWith(extension) ? name + extension : name;
                const path = join(directory, String(prepared.length) + (extension || '.file'));
                const duration = type === 'record' ? silkDuration(bytes) : undefined;
                await writeFile(path, bytes, { flag: 'wx' });
                const video = type === 'video' ? await prepareVideo(path, data, bytes) : {};
                prepared.push({ type, data: { path, md5, fileName, size: bytes.length, ...video,
                    ...(duration !== undefined && { duration }),
                    ...(data.groupUpload && { groupUpload: data.groupUpload }) } });
                continue;
            }
            if (type !== 'image') {
                prepared.push(segment);
                continue;
            }
            const bytes = await readMedia(data.file);
            total += bytes.length;
            if (bytes.length > MAX_IMAGE_BYTES || total > MAX_TOTAL_BYTES) {
                throw new InvalidImage('Images exceed the 5 MiB per image or 10 MiB per message limit');
            }
            const size = imageFormat(bytes);
            if (!size || size.width <= 0 || size.height <= 0 || size.width * size.height > 40_000_000) {
                throw new InvalidImage('Expected a PNG, APNG, JPEG, GIF, WebP or BMP image within the dimension limit');
            }
            const md5 = createHash('md5').update(bytes).digest('hex');
            const fileName = `${md5}.${size.extension}`;
            const path = join(directory, `${prepared.length}-${fileName}`);
            await writeFile(path, bytes, { flag: 'wx' });
            const { subType, summary } = data;
            prepared.push({ type: 'image', data: { subType, summary, path, md5, fileName,
                size: bytes.length, width: size.width, height: size.height, picType: size.picType } });
        }
        return {
            segments: prepared,
            async close({ uncertain = false } = {}) {
                if (uncertain) {
                    setTimeout(() => cleanup().catch(() => {}), 120000).unref();
                } else await cleanup();
            },
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
