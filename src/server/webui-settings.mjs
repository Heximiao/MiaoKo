import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isIPv4 } from 'node:net';

export const defaultPort = 8765;
export const defaultBindAddress = '0.0.0.0';
export const logLevels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
export const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;

export class WebUIError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

async function readSettings(path) {
    let settings;
    try {
        settings = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        settings = {};
    }
    return settings;
}

export async function openWebUISettings(path) {
    const settings = await readSettings(path);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        (settings.port !== undefined && !validPort(settings.port)) ||
        (settings.bindAddress !== undefined && !isIPv4(settings.bindAddress)) ||
        (settings.messageIdPort !== undefined && !validPort(settings.messageIdPort)) ||
        (settings.logLevel !== undefined && !logLevels.includes(settings.logLevel)) ||
        (settings.password !== undefined && !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(settings.password))) {
        throw new Error('WebUI 配置格式无效');
    }
    return writableSettings(path, settings);
}

export function stickerSummarySettings(input) {
    const { summary, quickMode = false, scope = 'all', targets = [], limit = null } = input;
    if (typeof summary !== 'string' ||
        Buffer.byteLength(summary) > 160 || /[\r\n\0]/.test(summary)) {
        throw new WebUIError('摘要须为单行文字，长度不能超过 160 个 UTF-8 字节');
    }
    if (typeof quickMode !== 'boolean') throw new WebUIError('快速模式设置无效');
    if (!['all', 'selected'].includes(scope) || !Array.isArray(targets) ||
        targets.some(target => !target || !['group', 'private'].includes(target.kind) ||
            typeof target.id !== 'string' || !/^[1-9]\d{4,11}$/.test(target.id))) {
        throw new WebUIError('请填写有效的群号或私聊 QQ 号');
    }
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) {
        throw new WebUIError('次数须为正整数，留空表示不限');
    }
    const unique = new Map(targets.map(({ kind, id }) => [kind + ':' + id, { kind, id }]));
    return { summary: summary.trim(), quickMode, scope,
        targets: [...unique.keys()].sort().map(key => unique.get(key)), limit };
}

export async function openStickerSummarySettings(path) {
    const settings = await readSettings(path);
    const defaults = stickerSummarySettings({ summary: '' });
    const quota = rule => rule.quickMode ? 1 : rule.limit;
    function readRule(input) {
        const migrated = ['group', 'private'].includes(input?.scope)
            ? { ...input, scope: 'selected', targets: (input.targets ?? []).map(id => ({ kind: input.scope, id })) }
            : input;
        const rule = stickerSummarySettings({ ...defaults, ...migrated,
            summary: input?.enabled === false ? '' : input?.summary ?? '' });
        const runId = quota(rule) !== null && typeof input?.runId === 'string' &&
            /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(input.runId) ? input.runId : null;
        return { ...rule, runId };
    }
    const accounts = Object.fromEntries(Object.entries(settings?.accounts ?? {})
        .filter(([account]) => /^[1-9]\d{4,11}$/.test(account))
        .map(([account, rule]) => [account, readRule(rule)]));
    const legacy = settings?.accounts ? null : readRule(settings);
    if (legacy && /^[1-9]\d{4,11}$/.test(settings?.selfId ?? '')) accounts[settings.selfId] = legacy;
    const store = writableSettings(path, { accounts, legacy: Object.keys(accounts).length ? null : legacy });
    const usagePath = id => join(path + '.usage', id);
    const rule = value => JSON.stringify([value.summary, value.scope, value.scope === 'selected' ? value.targets : [],
        value.quickMode, quota(value)]);
    const get = account => store.get().accounts[account] ?? store.get().legacy ?? defaults;
    async function view(account) {
        const { runId: current, ...value } = get(account);
        const limit = quota(value);
        const used = current ? (await readdir(usagePath(current)).catch(error => {
            if (error.code !== 'ENOENT') throw error;
            return null;
        }))?.length : null;
        const remaining = limit === null ? null : Math.max(0, limit - (used ?? limit));
        return { ...value, summary: value.quickMode && remaining === 0 ? '' : value.summary, remaining };
    }
    return {
        get,
        view,
        async save(account, patch) {
            const previous = get(account);
            const current = await view(account);
            const change = stickerSummarySettings({ ...current, ...patch });
            const existing = previous.runId;
            const keepRun = existing && !(previous.quickMode && current.remaining === 0) &&
                (rule(previous) === rule(change) ||
                    (previous.quickMode && change.quickMode && previous.summary === change.summary));
            const next = change.summary && quota(change) !== null ? keepRun ? existing : randomUUID() : null;
            if (next && next !== existing) await mkdir(usagePath(next), { recursive: true });
            try {
                await store.save({ accounts: { ...store.get().accounts, [account]: { ...change, runId: next } }, legacy: null });
            } catch (error) {
                if (next && next !== existing) await rm(usagePath(next), { recursive: true, force: true }).catch(() => {});
                throw error;
            }
            if (existing && next !== existing) {
                await rm(usagePath(existing), { recursive: true, force: true }).catch(() => {});
            }
        },
    };
}

function writableSettings(path, settings) {
    let writes = Promise.resolve();
    return {
        get: () => settings,
        save(change) {
            const operation = writes.then(async () => {
                const next = { ...settings, ...change };
                const temporary = path + '.' + randomUUID() + '.tmp';
                await mkdir(dirname(path), { recursive: true });
                try {
                    await writeFile(temporary, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
                    await rename(temporary, path);
                    settings = next;
                } finally {
                    await rm(temporary, { force: true });
                }
            });
            writes = operation.catch(() => {});
            return operation;
        },
    };
}
