import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function openMessageIds(path) {
    await mkdir(dirname(path), { recursive: true });
    const file = await open(path, 'a+');
    const ids = new Map();
    const keys = [];
    const locations = new Map();
    const groupSequences = new Map();
    function indexSequence(key, { seq, parentId }) {
        if (!seq || parentId) return;
        const [account, kind, peer, nativeId] = JSON.parse(key);
        if (kind === 'group') groupSequences.set(JSON.stringify([account, peer, seq]), nativeId);
    }
    try {
        const contents = await file.readFile();
        const lastNewline = contents.lastIndexOf(10);
        if (lastNewline + 1 < contents.length) await file.truncate(lastNewline + 1);
        for (const line of contents.subarray(0, lastNewline + 1).toString('utf8').split('\n').filter(Boolean)) {
            const entry = JSON.parse(line);
            const key = typeof entry === 'string' ? entry : entry?.key;
            if (typeof key !== 'string') throw new Error('Invalid OneBot message ID store');
            if (!ids.has(key)) {
                ids.set(key, keys.length + 1);
                keys.push(key);
            } else if (typeof entry === 'string') {
                throw new Error('Duplicate OneBot message ID');
            }
            if (typeof entry !== 'string') {
                const { seq, parentId } = entry;
                if (!(seq || parentId) || [seq, parentId].some(value => value !== undefined &&
                    (typeof value !== 'string' || !/^[1-9]\d{0,23}$/.test(value)))) {
                    throw new Error('Invalid OneBot message location');
                }
                locations.set(key, { ...(seq && { seq }), ...(parentId && { parentId }) });
                indexSequence(key, { seq, parentId });
            }
        }
    } catch (error) {
        await file.close();
        throw error;
    }
    let writes = Promise.resolve();
    let failure;
    return {
        get(selfId, kind, peer, nativeId, { seq, parentId } = {}) {
            if (typeof nativeId !== 'string' || !/^[1-9]\d*$/.test(nativeId)) {
                throw new Error('QQ did not return a valid native message ID');
            }
            const key = JSON.stringify([String(selfId), kind, String(peer), nativeId]);
            const operation = writes.then(async () => {
                if (failure) throw failure;
                const existing = ids.get(key);
                const previous = locations.get(key);
                const location = { seq: previous?.seq ?? seq, parentId: previous?.parentId ?? parentId };
                const hasLocation = location.seq || location.parentId;
                if (existing && location.seq === previous?.seq && location.parentId === previous?.parentId) {
                    return existing;
                }
                const id = existing ?? keys.length + 1;
                if (id > 0x7fffffff) throw new Error('OneBot message ID space is exhausted');
                try {
                    await file.appendFile(JSON.stringify(hasLocation ? { key, ...location } : key) + '\n');
                } catch (error) {
                    failure = error;
                    throw error;
                }
                if (!existing) {
                    ids.set(key, id);
                    keys.push(key);
                }
                if (hasLocation) {
                    locations.set(key, location);
                    indexSequence(key, location);
                }
                return id;
            });
            writes = operation.catch(() => {});
            return operation;
        },
        resolve(account, id, { poke = false } = {}) {
            const key = keys[id - 1];
            if (!key) return;
            const [selfId, kind, peer, nativeId] = JSON.parse(key);
            if (selfId === String(account) && kind.startsWith('poke-') === poke) {
                return { kind, peer, nativeId, ...locations.get(key) };
            }
        },
        findGroupMessage(account, peer, seq) {
            return seq ? groupSequences.get(JSON.stringify([String(account), String(peer), seq])) : undefined;
        },
        async close() {
            await writes;
            await file.close();
        },
    };
}
