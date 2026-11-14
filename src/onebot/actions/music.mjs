import { ActionError } from './shared.mjs';

const maxCardBytes = 24 * 1024;

export async function signMusic(data, signUrl = process.env.MIAOKO_MUSIC_SIGN_URL) {
    if (!signUrl) throw new ActionError(1500, 'Music signing requires MIAOKO_MUSIC_SIGN_URL');
    try {
        const url = new URL(signUrl);
        if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid signing URL');
        const response = await fetch(url, {
            method: 'POST',
            redirect: 'error',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
            signal: AbortSignal.timeout(10000),
        });
        if (!response.ok || !response.body) {
            await response.body?.cancel();
            throw new Error('Signing request failed');
        }
        const chunks = [];
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            if (length > maxCardBytes) throw new Error('Music card exceeds 24 KiB');
            chunks.push(chunk);
        }
        const responseText = Buffer.concat(chunks, length).toString('utf8').trim();
        const payload = JSON.parse(responseText);
        const raw = typeof payload === 'string' ? payload : responseText;
        const card = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (card?.app !== 'com.tencent.music.lua' || card.view !== 'music' ||
            typeof card.config?.token !== 'string' || !card.config.token ||
            typeof card.meta?.music?.title !== 'string' || !card.meta.music.title) {
            throw new Error('Expected a signed QQ music card');
        }
        return { type: 'json', data: { data: raw } };
    } catch {
        throw new ActionError(1500, 'Music signing failed. Check the service URL, song ID and signing response');
    }
}
