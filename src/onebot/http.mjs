import { oneBotAccess } from './auth.mjs';
import { MAX_ACTION_BYTES } from './actions/message-params.mjs';

export function oneBotHttpAction(request, url, dispatch, basePath = '') {
    if (!['GET', 'POST'].includes(request.method) || !url.pathname.startsWith(basePath + '/')) return;
    const action = /^\/([a-z_]+)\/?$/.exec(url.pathname.slice(basePath.length))?.[1];
    if (action && dispatch.supports(action)) return action;
}

export async function handleOneBotHttp({ request, url, action, dispatch, host, accessToken }) {
    const fail = (status, message) => ({ status, body: { status: 'failed', retcode: 100, data: null, message } });
    const denied = oneBotAccess(request, url, host, accessToken);
    if (denied) return fail(denied.status, denied.message);

    const params = Object.fromEntries(url.searchParams);
    delete params.access_token;
    if (request.method === 'POST') {
        const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
        if (type !== 'application/json' && type !== 'application/x-www-form-urlencoded') {
            return fail(406, 'Unsupported Content-Type');
        }
        const limit = /^(?:send|upload)_/.test(action) ? MAX_ACTION_BYTES : 8192;
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
            size += chunk.length;
            if (size <= limit) chunks.push(chunk);
        }
        if (size > limit) return fail(400, 'Request body is too large');
        const content = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
            body = type === 'application/json' ? JSON.parse(content) : Object.fromEntries(new URLSearchParams(content));
        } catch {
            return fail(400, 'Invalid request body');
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return fail(400, 'Expected an object for params');
        return { status: 200, body: await dispatch({ action, params: { ...params, ...body } }) };
    }
    return { status: 200, body: await dispatch({ action, params }) };
}
