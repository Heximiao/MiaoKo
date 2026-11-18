import { once } from 'node:events';
import { createServer } from 'node:http';
import { isIPv4 } from 'node:net';
import { getEndpoints, OneBotConfigError } from '../onebot/config.mjs';
import { validPort } from './webui-settings.mjs';

export function oneBotListeners(config) {
    return [
        ...getEndpoints(config, 'http').filter(entry => entry.httpPort !== undefined).map(entry => ({
            kind: 'http', id: entry.id, endpoint: entry, port: entry.httpPort, bind: entry.httpBind ?? '127.0.0.1',
            path: entry.httpPath ?? '/', enabled: entry.httpEnabled, token: entry.httpAccessToken,
        })),
        ...getEndpoints(config, 'forward').filter(entry => entry.forwardWsPort !== undefined).map(entry => ({
            kind: 'forward', id: entry.id, endpoint: entry, port: entry.forwardWsPort,
            bind: entry.forwardWsBind ?? '127.0.0.1', path: entry.forwardWsPath ?? '/',
            enabled: entry.forwardWsEnabled, token: entry.forwardWsAccessToken,
        })),
    ];
}

export function createOneBotListeners({ reservedPorts, handleHttp, handleUpgrade, onFailure }) {
    let listeners = new Map();
    let errors = {};
    let closing = false;
    const pendingCloses = new Set();

    function stop(server) {
        const pending = new Promise(resolve => server.close(resolve));
        pendingCloses.add(pending);
        pending.then(() => pendingCloses.delete(pending));
        return pending;
    }

    async function prepare(config, startup = false) {
        const next = new Map();
        const opened = new Set();
        const failures = {};
        const ports = new Set(reservedPorts());
        const rollback = () => Promise.all([...opened].map(stop));
        try {
            for (const entry of oneBotListeners(config)) {
                const { kind, id, port, bind, enabled, token } = entry;
                const key = kind + ':' + id;
                try {
                    if (!validPort(port) || !isIPv4(bind)) throw new OneBotConfigError('OneBot 监听地址或端口无效');
                    if (ports.has(port)) throw new OneBotConfigError(`端口 ${port} 与 WebUI、媒体服务或其他 OneBot 端点冲突`);
                    ports.add(port);
                    if (!enabled) continue;
                    if (!bind.startsWith('127.') && !token) {
                        throw new OneBotConfigError(`端口 ${port} 监听非回环地址时须设置访问令牌`);
                    }
                    const current = listeners.get(port);
                    if (current?.entry.bind === bind) {
                        next.set(port, { server: current.server, entry });
                        continue;
                    }
                    if (current) throw new OneBotConfigError(`请先停用端点，再修改端口 ${port} 的监听地址`);
                    const server = createServer((request, response) => {
                        const active = listeners.get(port);
                        if (active?.server !== server || active.entry.kind !== 'http') {
                            response.writeHead(404).end();
                            return;
                        }
                        handleHttp(active.entry, request, response);
                    });
                    server.on('upgrade', (request, socket, head) => {
                        const active = listeners.get(port);
                        if (active?.server !== server || active.entry.kind !== 'forward') {
                            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
                            return;
                        }
                        handleUpgrade(active.entry, request, socket, head);
                    });
                    const ready = once(server, 'listening');
                    server.listen(port, bind);
                    await ready;
                    opened.add(server);
                    next.set(port, { server, entry });
                } catch (error) {
                    const message = error instanceof OneBotConfigError ? error.message
                        : error.code === 'EADDRINUSE' ? `端口 ${port} 已被其他程序占用`
                            : `无法监听 ${bind}:${port}（${error.code ?? '监听失败'}）`;
                    if (!startup && errors[key] !== message) throw new OneBotConfigError(message);
                    failures[key] = message;
                    if (startup) onFailure(message);
                }
            }
            if (closing) throw new OneBotConfigError('MiaoKo 正在停止');
        } catch (error) {
            await rollback();
            throw error;
        }
        return {
            rollback,
            commit() {
                if (closing) {
                    void rollback();
                    return;
                }
                const previous = listeners;
                listeners = next;
                errors = failures;
                for (const [port, { server }] of previous) {
                    if (next.get(port)?.server !== server) void stop(server);
                }
            },
        };
    }

    return {
        prepare,
        errors: () => errors,
        close() {
            closing = true;
            for (const { server } of listeners.values()) void stop(server);
            listeners.clear();
            return Promise.all(pendingCloses);
        },
    };
}
