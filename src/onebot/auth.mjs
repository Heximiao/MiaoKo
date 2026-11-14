import { timingSafeEqual } from 'node:crypto';

export function oneBotAccess(request, url, host, accessToken) {
    const { origin, 'sec-fetch-site': site, authorization } = request.headers;
    if ((origin !== undefined && origin !== 'http://' + host) ||
        (site !== undefined && site !== 'same-origin' && site !== 'none')) {
        return { status: 403, message: 'Forbidden' };
    }
    if (!accessToken) return;
    const token = authorization ?? url.searchParams.get('access_token');
    if (token === null) return { status: 401, message: 'Access token is required' };
    const actual = Buffer.from(token);
    const expected = Buffer.from(authorization === undefined ? accessToken : 'Bearer ' + accessToken);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return { status: 403, message: 'Invalid access token' };
    }
}
