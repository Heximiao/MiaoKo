import { ActionError } from './shared.mjs';

export function boundedText(value, name, limit, allowEmpty = false) {
    if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.includes('\0') ||
        Buffer.byteLength(value) > limit) throw new ActionError(1400, 'Invalid ' + name);
    return value;
}

export async function groupOperation(request, account, type, params) {
    const result = await request(account, type, params);
    if (result.status !== 'ok') {
        throw new ActionError(result.status === 'unknown' ? 1501 : 1500, result.error ?? 'QQ rejected the operation');
    }
    return result.data ?? null;
}
