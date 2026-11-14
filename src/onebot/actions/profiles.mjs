import { ActionError, booleanParam } from './shared.mjs';

export async function queryProfile(request, account, type, { no_cache: noCache = false }, identifiers) {
    const result = await request(account, type, { ...identifiers, noCache: booleanParam(noCache, 'no_cache') });
    if (result.status !== 'ok') throw new ActionError(1404, result.error ?? 'QQ profile is unavailable');
    return result;
}

export function userInfo(info, user) {
    return {
        user_id: Number(user), nickname: info.nickname ?? '', age: Number(info.age) || 0,
        sex: { 1: 'male', 2: 'female' }[info.sex] ?? 'unknown',
    };
}
