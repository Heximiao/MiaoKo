const limit = 256;
const lifetime = 5 * 60 * 1000;

// QQ can supply the quoted record when resolving a reply and fail to return it on a later read.
export function createReplyRecords() {
    const entries = new Map();
    const key = (account, id) => JSON.stringify([account, id]);
    return {
        remember(account, id, record) {
            const entry = key(account, id);
            entries.delete(entry);
            entries.set(entry, { account, record, expires: Date.now() + lifetime });
            if (entries.size > limit) entries.delete(entries.keys().next().value);
        },
        get(account, id) {
            const entry = key(account, id);
            const cached = entries.get(entry);
            if (cached && cached.expires > Date.now()) return cached.record;
            entries.delete(entry);
        },
        delete(account, id) {
            entries.delete(key(account, id));
        },
        detach(account) {
            for (const [entry, cached] of entries) {
                if (cached.account === account) entries.delete(entry);
            }
        },
    };
}
