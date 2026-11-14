import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export class OneBotConfigError extends Error {}

const defaults = {
    httpEnabled: false, forwardWsEnabled: false, reverseWsUrl: '', accessToken: '', httpPostUrl: '', httpPostSecret: '',
};
export const generalDefaults = { statusEnabled: false, statusTrigger: '#mk', statusSwallow: false, statusCooldown: 5 };
const extras = {
    ...generalDefaults, httpName: '', httpPostName: '', forwardWsName: '', reverseWsName: '',
    httpConfigured: true, forwardWsConfigured: true,
    forwardWsFormat: 'array', reverseWsFormat: 'array', reverseWsRole: 'Universal',
    forwardWsReportSelf: false, reverseWsReportSelf: false, reverseWsRetryMs: 0,
};
const endpointTokens = ['httpAccessToken', 'forwardWsAccessToken', 'reverseWsAccessToken'];

const endpointTypes = {
    http: {
        list: 'httpEndpoints', configured: 'httpConfigured', enabled: 'httpEnabled', token: 'httpAccessToken',
        fields: ['httpName', 'httpEnabled', 'httpAccessToken'],
    },
    forward: {
        list: 'forwardWsEndpoints', configured: 'forwardWsConfigured', enabled: 'forwardWsEnabled', token: 'forwardWsAccessToken',
        fields: ['forwardWsName', 'forwardWsEnabled', 'forwardWsAccessToken', 'forwardWsFormat', 'forwardWsReportSelf'],
    },
    reverse: {
        list: 'reverseWsEndpoints', url: 'reverseWsUrl', enabled: 'reverseWsEnabled', token: 'reverseWsAccessToken',
        fields: ['reverseWsName', 'reverseWsUrl', 'reverseWsEnabled', 'reverseWsAccessToken',
            'reverseWsFormat', 'reverseWsReportSelf', 'reverseWsRole', 'reverseWsRetryMs'],
    },
    'http-post': {
        list: 'httpPostEndpoints', url: 'httpPostUrl', enabled: 'httpPostEnabled', token: 'httpPostSecret',
        fields: ['httpPostName', 'httpPostUrl', 'httpPostEnabled', 'httpPostSecret'],
    },
};

export function getEndpoints(settings, kind) {
    const type = endpointTypes[kind];
    if (settings[type.list]) return settings[type.list];
    if (type.url ? !settings[type.url] : settings[type.configured] === false) return [];
    const legacy = Object.fromEntries(type.fields.map(key => [key, settings[key]]));
    if (kind !== 'http-post') legacy[type.token] ??= settings.accessToken;
    return [{ ...legacy, id: 'default' }];
}

export function serverEndpointPath(kind, id) {
    return id === 'default' ? '' : '/onebot/' + kind + '/' + id;
}

export function createOneBotConfig(path) {
    let writes = Promise.resolve();

    async function read() {
        let settings;
        try {
            settings = { ...defaults, ...JSON.parse(await readFile(path, 'utf8')) };
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            settings = { ...defaults };
        }
        return { ...settings, reverseWsEnabled: settings.reverseWsEnabled ?? Boolean(settings.reverseWsUrl),
            httpPostEnabled: settings.httpPostEnabled ?? Boolean(settings.httpPostUrl) };
    }

    function publicView(settings) {
        const { httpEnabled, forwardWsEnabled, reverseWsUrl, reverseWsEnabled, accessToken,
            httpPostUrl, httpPostEnabled, httpPostSecret } = settings;
        return { httpEnabled, forwardWsEnabled, reverseWsUrl, reverseWsEnabled, hasAccessToken: Boolean(accessToken),
            httpPostUrl, httpPostEnabled, hasHttpPostSecret: Boolean(httpPostSecret),
            ...Object.fromEntries(Object.values(endpointTypes).filter(type => settings[type.list]).map(type => [
                type.list, settings[type.list].map(entry => {
                    const { [type.token]: token, ...endpoint } = entry;
                    return { ...endpoint, ['has' + type.token[0].toUpperCase() + type.token.slice(1)]: Boolean(token) };
                }),
            ])),
            ...Object.fromEntries(Object.keys(extras).filter(key => settings[key] !== undefined)
                .map(key => [key, settings[key]])),
            ...Object.fromEntries(endpointTokens.filter(key => settings[key] !== undefined)
                .map(key => ['has' + key[0].toUpperCase() + key.slice(1), Boolean(settings[key])])) };
    }

    return {
        async getEndpoint() {
            await writes;
            return read();
        },
        async get() {
            await writes;
            return publicView(await read());
        },
        save(input) {
            const mutation = input?.endpoint;
            let type;
            let endpointChange;
            if (mutation !== undefined) {
                if (!mutation || !Object.hasOwn(endpointTypes, mutation.kind) ||
                    (mutation.id !== undefined && typeof mutation.id !== 'string') ||
                    (mutation.remove !== undefined && typeof mutation.remove !== 'boolean')) {
                    throw new OneBotConfigError('端点操作无效');
                }
                type = endpointTypes[mutation.kind];
                endpointChange = mutation.remove ? {} : validate(mutation.change);
            }
            const change = validate(input);
            const operation = writes.then(async () => {
                const current = await read();
                const next = {
                    httpEnabled: change.httpEnabled ?? current.httpEnabled,
                    forwardWsEnabled: change.forwardWsEnabled ?? current.forwardWsEnabled,
                    reverseWsUrl: change.reverseWsUrl ?? current.reverseWsUrl,
                    reverseWsEnabled: change.reverseWsEnabled ?? (change.reverseWsUrl === undefined
                        ? current.reverseWsEnabled : Boolean(change.reverseWsUrl)),
                    accessToken: change.clearToken ? '' : change.accessToken ?? current.accessToken,
                    httpPostUrl: change.httpPostUrl ?? current.httpPostUrl,
                    httpPostEnabled: change.httpPostEnabled ?? (change.httpPostUrl === undefined
                        ? current.httpPostEnabled : Boolean(change.httpPostUrl)),
                    httpPostSecret: change.clearHttpPostSecret ? '' : change.httpPostSecret ?? current.httpPostSecret,
                };
                for (const key of Object.keys(extras)) {
                    const value = change[key] ?? current[key];
                    if (value !== undefined) next[key] = value;
                }
                for (const [enabled, configured] of [['httpEnabled', 'httpConfigured'],
                    ['forwardWsEnabled', 'forwardWsConfigured']]) {
                    if (change[configured] === false) next[enabled] = false;
                    else if (change[enabled] === true && current[configured] === false) next[configured] = true;
                }
                for (const key of endpointTokens) {
                    const token = change[key] ?? current[key];
                    if (token !== undefined) next[key] = token;
                }
                if ((next.reverseWsEnabled && !next.reverseWsUrl) || (next.httpPostEnabled && !next.httpPostUrl)) {
                    throw new OneBotConfigError('启用端点前请填写地址');
                }
                for (const [kind, outgoing] of Object.entries(endpointTypes)) {
                    if (current[outgoing.list]) next[outgoing.list] = current[outgoing.list];
                    if (outgoing !== type) continue;
                    const endpoints = getEndpoints(current, kind);
                    const existing = endpoints.find(endpoint => endpoint.id === mutation.id);
                    if (!existing && (mutation.id !== undefined || mutation.remove)) {
                        throw new OneBotConfigError('端点已不存在，请重新加载配置');
                    }
                    if (mutation.remove) {
                        next[outgoing.list] = endpoints.filter(endpoint => endpoint.id !== mutation.id);
                        continue;
                    }
                    const updated = { ...existing, id: existing?.id ?? randomUUID() };
                    for (const key of outgoing.fields) {
                        if (endpointChange[key] !== undefined) updated[key] = endpointChange[key];
                    }
                    if (endpointChange.clearHttpPostSecret && kind === 'http-post') updated.httpPostSecret = '';
                    if (outgoing.url && !updated[outgoing.url]) throw new OneBotConfigError('请填写端点地址');
                    updated[outgoing.enabled] ??= true;
                    next[outgoing.list] = existing
                        ? endpoints.map(endpoint => endpoint.id === existing.id ? updated : endpoint)
                        : [...endpoints, updated];
                }
                await mkdir(dirname(path), { recursive: true });
                const pending = path + '.' + randomUUID() + '.tmp';
                try {
                    await writeFile(pending, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
                    await rename(pending, path);
                } finally {
                    await rm(pending, { force: true });
                }
                return publicView(next);
            });
            writes = operation.catch(() => {});
            return operation;
        },
    };
}

function validate(input) {
    const switches = ['httpEnabled', 'forwardWsEnabled', 'reverseWsEnabled', 'httpPostEnabled',
        'clearToken', 'clearHttpPostSecret'];
    const tokens = ['accessToken', ...endpointTokens];
    const strings = ['reverseWsUrl', 'httpPostUrl', 'httpPostSecret', ...tokens];
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        switches.some(key => input[key] !== undefined && typeof input[key] !== 'boolean') ||
        strings.some(key => input[key] !== undefined && (typeof input[key] !== 'string' ||
            input[key].length > 2048 || /[\r\n\x00]/.test(input[key]))) ||
        tokens.some(key => input[key] !== undefined && !/^[\x20-\x7e\x80-\xff]*$/.test(input[key]))) {
        throw new OneBotConfigError('配置格式无效');
    }
    const change = { ...input };
    for (const [key, fallback] of Object.entries(extras)) {
        if (input[key] !== undefined && typeof input[key] !== typeof fallback) {
            throw new OneBotConfigError('配置格式无效');
        }
    }
    for (const key of ['httpName', 'httpPostName', 'forwardWsName', 'reverseWsName', 'statusTrigger']) {
        if (input[key] === undefined) continue;
        change[key] = input[key].trim();
        if (change[key].length > (key === 'statusTrigger' ? 32 : 64) ||
            /[\r\n\x00]/.test(change[key]) || (key === 'statusTrigger' && !change[key])) {
            throw new OneBotConfigError('名称或触发词格式无效');
        }
    }
    for (const key of ['forwardWsFormat', 'reverseWsFormat']) {
        if (input[key] !== undefined && !['array', 'string'].includes(input[key])) {
            throw new OneBotConfigError('消息格式无效');
        }
    }
    if (input.reverseWsRole !== undefined && !['Universal', 'Event', 'Api'].includes(input.reverseWsRole)) {
        throw new OneBotConfigError('WebSocket 角色无效');
    }
    for (const [key, min, max] of [['reverseWsRetryMs', 1000, 300000], ['statusCooldown', 0, 3600]]) {
        const value = input[key];
        if (value === undefined || (key === 'reverseWsRetryMs' && value === 0)) continue;
        if (!Number.isInteger(value) || value < min || value > max) {
            throw new OneBotConfigError('时间设置超出范围');
        }
    }
    for (const [key, pattern, label] of [
        ['reverseWsUrl', /^wss?:\/\//i, '反向 WebSocket'],
        ['httpPostUrl', /^https?:\/\//i, 'HTTP 回调'],
    ]) {
        if (input[key] === undefined) continue;
        const value = input[key].trim();
        change[key] = value;
        if (!value) continue;
        let parsed;
        try {
            parsed = new URL(value);
        } catch {
            throw new OneBotConfigError(label + '地址格式无效');
        }
        if (!pattern.test(value) || parsed.username || parsed.password || parsed.hash) {
            throw new OneBotConfigError(label + '地址的协议或格式无效');
        }
    }
    return change;
}
