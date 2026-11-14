import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { imageFormat } from '../qq/actions/messages/image-files.mjs';

export function mediaBaseUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('Expected an HTTP(S) media base URL without credentials, query or fragment');
    }
    return url.href.replace(/\/+$/, '');
}

export async function serveMedia(request, response, images, prefix = '') {
    if (!request.url.startsWith(prefix)) return false;
    const token = ['GET', 'HEAD'].includes(request.method) &&
        /^\/media\/([0-9a-f-]{36})$/.exec(request.url.slice(prefix.length))?.[1];
    if (!token) return false;
    const media = await images.get(token);
    if (!media) {
        response.writeHead(404).end();
        return true;
    }
    response.writeHead(200, { 'Content-Type': media.type, 'Content-Length': media.bytes.length,
        ...(media.type === 'application/octet-stream' && { 'Content-Disposition': 'attachment' }),
        'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=60' });
    response.end(request.method === 'HEAD' ? undefined : media.bytes);
    return true;
}

function mime(bytes) {
    const format = imageFormat(bytes);
    if (format) return 'image/' + (format.extension === 'jpg' ? 'jpeg' : format.extension);
}

export function createReceivedImages({ root, baseUrl, request }) {
    const images = new Map();
    const locations = new Map();
    const urlFor = token => baseUrl && baseUrl + '/media/' + token;
    function remove(token) {
        const media = images.get(token);
        if (media) locations.delete(media.key);
        images.delete(token);
    }

    async function read({ account, reference, elementId, mediaType }) {
        await mkdir(root, { recursive: true });
        const directory = await mkdtemp(join(root, 'received-'));
        const output = join(directory, 'image');
        try {
            const result = await request(account, 'get-image', { reference, elementId, output, mediaType });
            if (result.status !== 'ok') return;
            const info = await stat(output).catch(error => {
                if (error.code !== 'ENOENT') throw error;
            });
            if (!info?.isFile() || !info.size || info.size > (mediaType === 'image' ? 10 : 32) * 1024 * 1024) return;
            const bytes = await readFile(output);
            const type = mediaType === 'image' ? mime(bytes)
                : mediaType === 'video' && bytes.toString('latin1', 4, 8) === 'ftyp' ? 'video/mp4'
                    : 'application/octet-stream';
            if (type) return { bytes, type };
        } finally {
            await rm(directory, { recursive: true, force: true }).catch(() => {});
        }
    }

    return {
        register(account, reference, elementId, mediaType = 'image', metadata = {}) {
            const key = JSON.stringify([account, reference.kind, reference.peer, reference.nativeId, reference.parentId,
                elementId, mediaType]);
            const previous = locations.get(key);
            if (previous && Date.now() < images.get(previous).expires) return previous;
            if (previous) remove(previous);
            const token = randomUUID();
            if (images.size >= 2048) remove(images.keys().next().value);
            images.set(token, { account, reference, elementId, mediaType, ...metadata, key,
                expires: Date.now() + 24 * 60 * 60 * 1000 });
            locations.set(key, token);
            return token;
        },
        link(...args) {
            return urlFor(this.register(...args));
        },
        async url(token) {
            const media = images.get(token);
            if (!media || Date.now() >= media.expires) return;
            if (media.remote && Date.now() < media.remote.expires) return media.remote.url;
            media.resolving ??= Promise.resolve().then(async () => {
                const { account, reference, elementId, mediaType } = media;
                try {
                    const result = await request(account, 'resolve-media-url', { reference, elementId, mediaType });
                    if (result.status === 'ok') {
                        const url = new URL(result.url);
                        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) {
                            media.remote = { url: url.href, expires: Date.now() + 60_000 };
                            return url.href;
                        }
                    }
                } catch {}
                return urlFor(token);
            }).finally(() => { media.resolving = undefined; });
            return media.resolving;
        },
        find(account, id, types, peer) {
            for (const [token, media] of images) {
                if (media.account !== account || Date.now() >= media.expires || !types.includes(media.mediaType) ||
                    (peer && peer !== media.reference.peer)) continue;
                const url = urlFor(token);
                if ([token, media.fileId, media.name, url, media.remote?.url].includes(id)) {
                    return { token, url, name: media.name, size: media.size, type: media.mediaType };
                }
            }
        },
        get(token) {
            const image = images.get(token);
            if (!image || Date.now() >= image.expires) {
                remove(token);
                return;
            }
            image.pending ??= read(image).finally(() => { image.pending = undefined; });
            return image.pending;
        },
    };
}
