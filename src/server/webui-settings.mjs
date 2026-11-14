import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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

export async function openWebUISettings(path) {
    let settings;
    try {
        settings = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        settings = {};
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) ||
        (settings.port !== undefined && !validPort(settings.port)) ||
        (settings.bindAddress !== undefined && !isIPv4(settings.bindAddress)) ||
        (settings.messageIdPort !== undefined && !validPort(settings.messageIdPort)) ||
        (settings.logLevel !== undefined && !logLevels.includes(settings.logLevel)) ||
        (settings.password !== undefined && !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(settings.password))) {
        throw new Error('WebUI 配置格式无效');
    }

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
