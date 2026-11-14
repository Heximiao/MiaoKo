import { TextDecoder } from 'node:util';

const maxFrameBytes = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });

export async function* readFrames(stream) {
    let pending = Buffer.alloc(0);
    for await (const chunk of stream) {
        let start = 0;
        while (start < chunk.length) {
            const newline = chunk.indexOf(10, start);
            const end = newline === -1 ? chunk.length : newline;
            const part = chunk.subarray(start, end);
            if (pending.length + part.length > maxFrameBytes) {
                throw new Error('IPC frame exceeds 64 KiB');
            }
            pending = pending.length ? Buffer.concat([pending, part]) : Buffer.from(part);
            if (newline === -1) {
                break;
            }
            const frame = JSON.parse(decoder.decode(pending));
            if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
                throw new Error('IPC frame must be a JSON object');
            }
            pending = Buffer.alloc(0);
            start = newline + 1;
            yield frame;
        }
    }
    if (pending.length > 0) {
        throw new Error('Incomplete IPC frame');
    }
}
