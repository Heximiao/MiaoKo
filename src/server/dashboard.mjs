import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cpus, freemem, networkInterfaces, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { startCapture } from '../qq/hook/capture-session.mjs';
import { createInbox } from '../qq/inbox.mjs';
import { createOneBotConfig, getEndpoints, serverEndpointPath, generalDefaults, OneBotConfigError } from '../onebot/config.mjs';
import { createActions } from '../onebot/actions/index.mjs';
import { createReplyRecords } from '../onebot/reply-records.mjs';
import { openMessageIds } from '../onebot/message-ids.mjs';
import { toOneBotRecord } from '../onebot/message.mjs';
import { toOneBotNotice, toOneBotRequest } from '../onebot/notice.mjs';
import { createOutgoingClients } from '../onebot/outgoing.mjs';
import { createReverseWs } from '../onebot/reverse-ws.mjs';
import { createForwardWs } from '../onebot/forward-ws.mjs';
import { handleOneBotHttp, oneBotHttpAction } from '../onebot/http.mjs';
import { createHttpPost } from '../onebot/http-post.mjs';
import { ActionError } from '../onebot/actions/shared.mjs';
import { InvalidImage, prepareMedia } from '../qq/actions/messages/image-files.mjs';
import { createReceivedImages, mediaBaseUrl, serveMedia } from './received-images.mjs';
import { createOneBotLogs, describeOneBotEvent, writeTerminal } from './onebot-logs.mjs';
import { createWebUIAuth } from './webui-auth.mjs';
import { defaultBindAddress, defaultPort, logLevels, openWebUISettings, validPort, WebUIError } from './webui-settings.mjs';

const python = fileURLToPath(new URL('../../.conda/python.exe', import.meta.url));
const capture = fileURLToPath(new URL('../qq/hook/capture.py', import.meta.url));
const exec = promisify(execFile);

const normalizeStatusTrigger = text => text?.normalize('NFKC').trim().toLowerCase();

async function hostResources() {
    const cpuTimes = cores => cores.reduce(({ idle, total }, { times }) => ({
        idle: idle + times.idle, total: total + Object.values(times).reduce((sum, time) => sum + time, 0),
    }), { idle: 0, total: 0 });
    const before = cpuTimes(cpus());
    await delay(250);
    const cores = cpus();
    const after = cpuTimes(cores);
    const elapsed = after.total - before.total;
    const cpuPercent = elapsed > 0
        ? Math.min(100, Math.max(0, 100 * (1 - (after.idle - before.idle) / elapsed))) : null;
    return {
        cpuModel: cores[0]?.model, cpuCount: cores.length, cpuPercent, node: process.version,
        totalMemory: totalmem(), freeMemory: freemem(), pid: process.pid, memory: process.memoryUsage(),
    };
}

function isPrivateAddress(address) {
    if (!isIPv4(address)) return false;
    const [first, second] = address.split('.').map(Number);
    return first === 127 || first === 10 || (first === 192 && second === 168) ||
        (first === 172 && second >= 16 && second <= 31);
}

export async function runDashboard({ port: portOverride, bind: bindOverride, publicUrl, resetPassword, seconds, requested,
    mediaUrl, mediaPort, mediaBind }) {
    const webui = await openWebUISettings(fileURLToPath(new URL('../../data/webui.json', import.meta.url)));
    const port = portOverride ?? webui.get().port ?? defaultPort;
    const bindAddress = bindOverride ?? webui.get().bindAddress ?? defaultBindAddress;
    const messageIdPort = webui.get().messageIdPort ?? port;
    if (!isIPv4(bindAddress)) throw new Error('--bind 需要 IPv4 地址');
    const publicOrigin = publicUrl && new URL(publicUrl);
    if (publicOrigin && (publicOrigin.protocol !== 'https:' || publicOrigin.href !== publicOrigin.origin + '/')) {
        throw new Error('--public-url 需要无路径的 HTTPS 地址');
    }
    if (!validPort(port) ||
        (seconds !== undefined && (!Number.isInteger(seconds) || seconds < 1 || seconds > 3600))) {
        throw new Error('Expected --port 1024–65535 and --seconds 1–3600');
    }
    if (mediaPort !== undefined && (!validPort(mediaPort) ||
        mediaPort === port || !mediaUrl)) {
        throw new Error('A separate media port requires a media base URL and an unused port from 1024 to 65535');
    }
    if (mediaBind && mediaPort === undefined) throw new Error('A media bind address requires --media-port');

    const validPid = pid => Number.isInteger(pid) && pid > 0 && pid <= 0xffffffff;
    if (requested.some(pid => !validPid(pid))) throw new Error('Invalid --pid');

    const assets = new Map(await Promise.all([
        ['/', 'index.html', 'text/html'],
        ['/logo.png', 'logo.png', 'image/png'],
        ['/style.css', 'style.css', 'text/css'],
        ['/app.mjs', 'app.mjs', 'text/javascript'],
        ['/particles.mjs', 'particles.mjs', 'text/javascript'],
        ['/qq-avatar.mjs', 'qq-avatar.mjs', 'text/javascript'],
        ['/onebot-settings.mjs', 'onebot-settings.mjs', 'text/javascript'],
        ['/onebot-logs.mjs', 'onebot-logs.mjs', 'text/javascript'],
        ['/webui.mjs', 'webui.mjs', 'text/javascript'],
    ].map(async ([route, file, type]) => [route, {
        type: type.startsWith('image/') ? type : type + '; charset=utf-8',
        body: await readFile(new URL('../ui/' + file, import.meta.url)),
    }])));
    async function discover() {
        return JSON.parse((await exec(python, [capture, '--list'])).stdout);
    }

    const inbox = createInbox();
    const retryWarnings = new Set();
    const logs = createOneBotLogs(({ level, module, message }) => {
        if (['Event', 'Notice', 'Action', 'HTTP'].includes(module) && level === 'SUCCESS') return;
        if (logLevels.indexOf(level === 'SUCCESS' ? 'INFO' : level) <
            logLevels.indexOf(webui.get().logLevel ?? 'INFO')) return;
        const safeMessage = message.replace(/\bQQ (\d+)(\d{4})\b/g, 'QQ ****$2');
        writeTerminal(level === 'SUCCESS' ? 'INFO' : level, module, safeMessage);
    });
    const auth = createWebUIAuth(webui, source => logs.add('WARN', 'Auth',
        source ? `来源 ${source} 登录失败次数过多，已暂时限速` : '远程登录失败次数过多，已暂时限速'));
    const onebot = createOneBotConfig(fileURLToPath(new URL('../../data/onebot.json', import.meta.url)));
    const active = new Map();
    const bindings = new Map();
    const sending = new Set();
    const listingGroupFiles = new Set();
    const host = '127.0.0.1:' + port;
    const localOneBot = request => request.socket.remoteAddress === '127.0.0.1' && request.headers.host === host;
    const publicWebUI = () => ({
        port, savedPort: webui.get().port ?? defaultPort,
        bindAddress, savedBindAddress: webui.get().bindAddress ?? defaultBindAddress,
        logLevel: webui.get().logLevel ?? 'INFO', mediaShared: Boolean(mediaUrl && mediaPort === undefined),
        portOverride: portOverride !== undefined, bindOverride: bindOverride !== undefined,
    });
    const mediaRoot = fileURLToPath(new URL('../../build/onebot-media/', import.meta.url));
    let shuttingDown = false;
    const publications = new Map();
    const pendingRequests = new Map();
    const reactions = new Map();
    const statusReplies = new Map();
    let general = generalDefaults;
    let reportSelf = false;
    let ids;

    async function request(account, type, params) {
        const pid = [...(bindings.get(account) ?? [])].find(([, duplex]) => duplex)?.[0];
        const session = await active.get(pid);
        return session?.request(account, type, params) ??
            { status: 'failed', error: 'Start listening with the duplex DLL before using QQ actions' };
    }

    async function requestOneBot(account, type, params) {
        if (type !== 'get-group-root-files') return request(account, type, params);
        if (listingGroupFiles.has(account)) throw new ActionError(1500, 'QQ is already listing group files for this account');
        // QQ can return an empty page without a group identifier.
        listingGroupFiles.add(account);
        try {
            return await request(account, type, params);
        } finally {
            listingGroupFiles.delete(account);
        }
    }

    const baseUrl = mediaBaseUrl(mediaUrl ?? 'http://' + host);
    const mediaPrefix = new URL(baseUrl).pathname.replace(/\/+$/, '');
    const images = createReceivedImages({ root: join(mediaRoot, 'incoming'), baseUrl: mediaUrl ? baseUrl : undefined, request });
    const replyRecords = createReplyRecords();
    const format = (account, record, location, options) =>
        toOneBotRecord(account, record, { ids, images, request, replyRecords }, location, options);
    const dispatch = createActions({
        ids: { get: (...args) => ids.get(...args), resolve: (...args) => ids.resolve(...args) },
        accounts: () => [...bindings.keys()],
        request: requestOneBot,
        images,
        pendingRequests,
        formatRecord: format,
        replyRecords,
        async uploadGroupAlbum(account, { group, albumId, albumName, file }) {
            if (sending.has(account)) throw new ActionError(1500, 'QQ is already sending for this account');
            sending.add(account);
            let prepared;
            let outcome;
            try {
                prepared = await prepareMedia(join(mediaRoot, 'outgoing'), [{ type: 'image', data: { file } }]);
                const { path, md5, fileName, size } = prepared.segments[0].data;
                outcome = await request(account, 'upload-group-album', { group, albumId, albumName, path, md5, fileName, size });
                return outcome;
            } catch (error) {
                if (error instanceof InvalidImage) throw new ActionError(1400, error.message);
                throw error;
            } finally {
                sending.delete(account);
                await prepared?.close({ uncertain: outcome?.status === 'unknown' }).catch(() =>
                    logs.add('WARN', 'Media', '图片暂存清理失败'));
            }
        },
        async sendForwardBatch(account, params) {
            if (sending.has(account)) throw new ActionError(1500, 'QQ is already sending for this account');
            sending.add(account);
            let prepared;
            let outcome;
            try {
                if (params.nodes) {
                    prepared = await prepareMedia(join(mediaRoot, 'outgoing'), params.nodes.flatMap(node => node.segments));
                    let offset = 0;
                    const nodes = params.nodes.map(({ nickname, segments }) => {
                        const start = offset;
                        offset += segments.length;
                        return { nickname, segments: prepared.segments.slice(start, offset) };
                    });
                    params = { ...params, nodes };
                }
                outcome = await request(account, 'send-forward-message', params);
                return outcome;
            } catch (error) {
                if (error instanceof InvalidImage) throw new ActionError(1400, error.message);
                throw error;
            } finally {
                sending.delete(account);
                await prepared?.close({ uncertain: outcome?.status === 'unknown' }).catch(() =>
                    logs.add('WARN', 'Media', '转发媒体暂存清理失败'));
            }
        },
        async sendMessage(account, kind, peer, segments) {
            if (sending.has(account)) throw new ActionError(1500, 'QQ is already sending for this account');
            sending.add(account);
            let prepared;
            let outcome;
            try {
                prepared = await prepareMedia(join(mediaRoot, 'outgoing'), segments);
                outcome = await request(account, 'send-message', { kind, peer, segments: prepared.segments });
                return outcome;
            } catch (error) {
                if (error instanceof InvalidImage) throw new ActionError(1400, error.message);
                throw error;
            } finally {
                sending.delete(account);
                await prepared?.close({ uncertain: outcome?.status === 'unknown' }).catch(() =>
                    logs.add('WARN', 'Media', '图片暂存清理失败'));
            }
        },
        async readMessage(account, reference) {
            const result = await request(account, 'get-message', { reference });
            if (result.status === 'ok') {
                const { seq, parentId } = reference;
                return format(account, result.message, { seq, parentId });
            }
        },
    });
    function loggedDispatch(transport) {
        return Object.assign(async (packet, account) => {
            const started = performance.now();
            const result = await dispatch(packet, account);
            const action = typeof packet?.action === 'string' && /^[a-z_]{1,80}$/.test(packet.action)
                ? packet.action : '无效动作';
            const candidate = account ?? packet?.params?.self_id;
            const identity = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
            const owner = /^[1-9]\d{4,11}$/.test(identity) ? ` · QQ ${identity}` : '';
            logs.add(result.retcode === 0 ? 'SUCCESS' : 'WARN', 'Action',
                `${transport}${owner} · ${action} · retcode ${result.retcode} · ${Math.round(performance.now() - started)} ms`);
            return result;
        }, { supports: dispatch.supports });
    }
    const httpDispatch = loggedDispatch('HTTP');
    const reverse = createOutgoingClients(id => createReverseWs({
        dispatch: loggedDispatch('反向 WS'),
        onState(account, state, detail) {
            const labels = { connecting: '正在连接反向 WebSocket', connected: '反向 WebSocket 已连接',
                retrying: '反向 WebSocket 已断开，等待重连', invalid: '收到无效的 OneBot JSON 请求' };
            const key = id + ':' + account;
            const repeatedRetry = state === 'retrying' && retryWarnings.has(key);
            if (state === 'retrying') retryWarnings.add(key);
            else if (state === 'connected') retryWarnings.delete(key);
            logs.add(repeatedRetry ? 'DEBUG' : state === 'retrying' || state === 'invalid' ? 'WARN'
                : state === 'connected' ? 'SUCCESS' : 'DEBUG',
                'WebSocket', `QQ ${account} · ${labels[state]}${detail ? ` · ${detail}` : ''}`);
        },
    }));
    const forward = createOutgoingClients(id => createForwardWs({
        host, basePath: serverEndpointPath('ws', id), accounts: () => [...bindings.keys()],
        dispatch: loggedDispatch('正向 WS'),
        onState(account, state) {
            const labels = { connected: '正向 WebSocket 客户端已连接', closed: '正向 WebSocket 客户端已断开',
                invalid: '收到无效的 OneBot JSON 请求' };
            logs.add(state === 'invalid' ? 'WARN' : state === 'connected' ? 'SUCCESS' : 'INFO',
                'WebSocket', `QQ ${account} · ${labels[state]}`);
        },
    }));
    const httpPost = createOutgoingClients(() => createHttpPost({
        onState(account, state, detail) {
            logs.add(state === 'delivered' ? 'SUCCESS' : 'WARN', 'HTTP',
                `QQ ${account} · 事件回调${state === 'delivered' ? '已送达' : '失败'} · ${detail}`);
        },
    }));

    function updateEndpoints(config) {
        const next = { ...generalDefaults, ...config };
        if (!next.statusEnabled || next.statusTrigger !== general.statusTrigger ||
            next.statusCooldown !== general.statusCooldown) statusReplies.clear();
        general = next;
        const reverseEndpoints = getEndpoints(config, 'reverse');
        const forwardEndpoints = getEndpoints(config, 'forward');
        reportSelf = forwardEndpoints.some(endpoint => endpoint.forwardWsEnabled && endpoint.forwardWsReportSelf) ||
            reverseEndpoints.some(endpoint => endpoint.reverseWsEnabled &&
                endpoint.reverseWsReportSelf && endpoint.reverseWsRole !== 'Api');
        reverse.update(reverseEndpoints);
        forward.update(forwardEndpoints);
        httpPost.update(getEndpoints(config, 'http-post'));
    }

    function bind(account, pid, duplex) {
        const processes = bindings.get(account) ?? new Map();
        processes.set(pid, duplex);
        bindings.set(account, processes);
        logs.add('INFO', 'Session', `QQ ${account} · PID ${pid} 已开始监听`);
        reverse.attach(account);
        forward.attach(account);
        httpPost.attach(account);
    }

    function unbind(account, pid) {
        const processes = bindings.get(account);
        if (processes?.delete(pid)) logs.add('INFO', 'Session', `QQ ${account} · PID ${pid} 已停止监听`);
        if (processes && !processes.size) {
            bindings.delete(account);
            replyRecords.detach(account);
            reactions.delete(account);
            statusReplies.delete(account);
            reverse.detach(account);
            forward.detach(account);
            httpPost.detach(account);
        }
    }

    function duplicateReaction(account, event, source) {
        const history = reactions.get(account) ?? new Map();
        reactions.set(account, history);
        const key = JSON.stringify([event.group_id, event.message_id, event.user_id, event.likes[0].emoji_id]);
        const previous = history.get(key);
        if (previous && previous.source !== source && Math.abs(previous.time - event.time) <= 2) {
            if (previous.isAdd === event.is_add) return true;
            if (source === 'gray-tip' && event.time <= previous.time) return true;
        }
        history.delete(key);
        history.set(key, { time: event.time, isAdd: event.is_add, source });
        if (history.size > 200) history.delete(history.keys().next().value);
        return false;
    }

    async function handleStatusCommand(account, message) {
        const { statusEnabled, statusTrigger, statusCooldown, statusSwallow } = general;
        if (!statusEnabled || message.type ||
            message.segments?.some(segment => segment.type !== 'text') ||
            normalizeStatusTrigger(message.text) !== normalizeStatusTrigger(statusTrigger)) return false;

        const kind = message.chatType === 2 ? 'group' : 'private';
        const peer = kind === 'group' || String(message.senderUin) === account ? message.peerUin : message.senderUin;
        const replies = statusReplies.get(account) ?? new Map();
        statusReplies.set(account, replies);
        const key = kind + ':' + peer;
        const now = Date.now();
        for (const [conversation, last] of replies) {
            if (now - last >= statusCooldown * 1000) replies.delete(conversation);
        }
        if (!replies.has(key)) {
            replies.set(key, now);
            const version = await dispatch({ action: 'get_version_info' }, account);
            if (version.status !== 'ok') {
                replies.delete(key);
                return false;
            }
            const seconds = Math.floor(process.uptime());
            const response = await dispatch({ action: 'send_msg', params: {
                message_type: kind, [kind === 'group' ? 'group_id' : 'user_id']: peer,
                message: [{ type: 'text', data: {
                    text: 'MiaoKo ' + version.data.app_version + ' · ' + process.platform + '/' + process.arch +
                        ' · 已运行 ' + Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒',
                } }],
            } }, account);
            if (response.status !== 'ok') {
                replies.delete(key);
                logs.add('WARN', 'OneBot', 'QQ ' + account + ' · 状态指令回复失败 · retcode ' + response.retcode);
            }
        }
        return statusSwallow;
    }

    function publish(account, pid, messages) {
        const publication = (publications.get(account) ?? Promise.resolve()).then(async () => {
            for (const message of messages) {
                if (shuttingDown || bindings.get(account)?.keys().next().value !== pid) return;
                const selfSent = !message.type && String(message.senderUin) === account;
                const swallow = await handleStatusCommand(account, message);
                if (selfSent && !reportSelf) {
                    if (message.chatType === 2 && message.msgSeq) {
                        await ids.get(account, 'group', message.peerUin, message.msgId, { seq: message.msgSeq });
                    }
                    continue;
                }
                if (swallow) continue;
                if (shuttingDown || bindings.get(account)?.keys().next().value !== pid) return;
                let unresolved;
                const flag = message.type === 'request' ? randomUUID() : undefined;
                const event = flag ? await toOneBotRequest(account, message, request, flag) : message.type
                    ? await toOneBotNotice(account, message, { ids, request, onUnresolved: missing => { unresolved = missing; } })
                    : await format(account, message);
                if (shuttingDown || bindings.get(account)?.keys().next().value !== pid) return;
                if (event) {
                    if (flag) {
                        if (pendingRequests.size >= 1024) pendingRequests.delete(pendingRequests.keys().next().value);
                        pendingRequests.set(flag, { account, record: message });
                    }
                    if (event.notice_type === 'group_recall' || event.notice_type === 'friend_recall') {
                        replyRecords.delete(account, event.message_id);
                    }
                    if (event.notice_type === 'group_msg_emoji_like' &&
                        duplicateReaction(account, event, message.source ?? (message.msgId ? 'gray-tip' : 'system'))) continue;
                    if (selfSent) event.post_type = 'message_sent';
                    logs.add('SUCCESS', event.post_type === 'message' || selfSent ? 'Event' : 'Notice',
                        describeOneBotEvent(event, message));
                    if (!selfSent) httpPost.publish(account, event);
                    reverse.publish(account, event);
                    forward.publish(account, event);
                } else if (message.type === 'emoji-like') {
                    logs.add('WARN', 'Notice',
                        `群 ${message.peerUin} · 收到表情回应 ${message.emojiId}，未能关联${unresolved ?? '事件'}` +
                        `（序号 ${message.seq || '未知'}，来源 ${message.source ?? '系统推送'}）`);
                }
            }
        }).catch(() => {
            logs.add('ERROR', 'Event', `QQ ${account} · OneBot 事件转换失败`);
        });
        publications.set(account, publication);
        void publication.then(() => {
            if (publications.get(account) === publication) publications.delete(account);
        });
    }

    async function start(pid) {
        if (shuttingDown || active.has(pid)) return;
        inbox.open(pid);
        const pending = startCapture({ pid, python, capture, seconds, inbox,
            onAttached: bind, onMessages: publish, onDetached: unbind,
            onNoticeListener(account, pid, outcome) {
                const ready = outcome.status === 'ok';
                logs.add(ready ? 'INFO' : 'WARN', 'Notice', `QQ ${account} · PID ${pid} · ` +
                    (ready ? '通知监听已就绪' : '通知监听启动失败'));
            },
        });
        active.set(pid, pending);
        try {
            const session = await pending;
            session.done.catch(() => logs.add('ERROR', 'Session', `PID ${pid} · QQ 监听进程异常退出`))
                .finally(() => {
                    active.delete(pid);
                    const state = inbox.snapshot().find(entry => entry.pid === pid)?.state;
                    if (state === 'error') logs.add('ERROR', 'Session', 'PID ' + pid + ' · QQ 接入失败，请查看终端');
                    if (state === 'account-unresolved' || state === 'account-changed') {
                        logs.add('WARN', 'Session', 'PID ' + pid + ' · QQ 账号未确认或已切换');
                    }
                });
        } catch (error) {
            inbox.close(pid, 'error');
            active.delete(pid);
            throw error;
        }
    }

    function json(response, status, data) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(data));
    }

    async function readConfig(request) {
        const limit = 8192;
        const chunks = [];
        let bytes = 0;
        for await (const chunk of request) {
            bytes += chunk.length;
            if (bytes > limit) throw new OneBotConfigError('请求内容过长');
            chunks.push(chunk);
        }
        try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
            return data;
        } catch {
            throw new OneBotConfigError('配置格式无效');
        }
    }

    const server = createServer(async (request, response) => {
        if (!ids || shuttingDown) {
            json(response, 503, { error: 'MiaoKo 正在启动或停止，请稍后重试' });
            return;
        }
        const requestHost = request.headers.host;
        const remoteAddress = request.socket.remoteAddress;
        const proxied = Boolean(publicOrigin) && remoteAddress === '127.0.0.1' && requestHost === publicOrigin.host &&
            request.headers['x-forwarded-proto'] === 'https';
        // Match the connected interface to protect direct access from DNS rebinding.
        if (!proxied && (requestHost !== request.socket.localAddress + ':' + port || !isPrivateAddress(remoteAddress))) {
            response.writeHead(403).end();
            return;
        }
        const origin = proxied ? publicOrigin.origin : 'http://' + requestHost;
        const proxyAddress = request.headers['x-real-ip'];
        const authSource = proxied ? 'HTTPS ' + (isIPv4(proxyAddress ?? '') || isIPv6(proxyAddress ?? '') ? proxyAddress : '未知来源')
            : remoteAddress;
        let url;
        try {
            url = new URL(request.url, origin);
        } catch {
            response.writeHead(400).end();
            return;
        }
        const httpId = /^\/onebot\/http\/([a-f0-9-]{36})\//.exec(url.pathname)?.[1] ?? 'default';
        const action = oneBotHttpAction(request, url, dispatch, serverEndpointPath('http', httpId));
        if ((action && !localOneBot(request)) || (!action &&
            ((request.headers.origin !== undefined && request.headers.origin !== origin) ||
                (request.method === 'POST' && request.headers.origin !== origin) ||
                (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))))) {
            response.writeHead(403).end();
            return;
        }
        try {
            if (action) {
                const config = await onebot.getEndpoint();
                const endpoint = getEndpoints(config, 'http').find(entry => entry.id === httpId);
                if (!endpoint?.httpEnabled) {
                    json(response, 404, { status: 'failed', retcode: 1404, data: null, message: 'HTTP API is disabled' });
                    return;
                }
                const { status, body } = await handleOneBotHttp({ request, url, action, dispatch: httpDispatch,
                    host, accessToken: endpoint.httpAccessToken });
                json(response, status, body);
                return;
            }
            const session = auth.session(request, proxied);
            if (request.method === 'GET' && request.url === '/api/auth/status') {
                json(response, 200, { authenticated: Boolean(session), setup: auth.setupRequired(),
                    setupVerified: auth.verified(request, proxied) });
                return;
            }
            if (request.method === 'POST' && ['/api/auth/verify', '/api/auth/setup', '/api/auth/login'].includes(request.url)) {
                const operation = request.url.split('/').at(-1);
                await auth.authenticate(request, response, operation, await readConfig(request), { source: authSource, secure: proxied });
                if (operation !== 'verify') {
                    logs.add('INFO', 'Auth', operation === 'setup' ? '管理密码已初始化' : '管理会话已登录');
                }
                json(response, 200, { ok: true });
                return;
            }
            if (request.method === 'GET' && assets.has(request.url)) {
                const asset = assets.get(request.url);
                response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store',
                    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
                    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://q4.qlogo.cn data:; " +
                        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
                response.end(asset.body);
                return;
            }
            // Explicitly published OneBot media URLs are capabilities used by clients without a WebUI session.
            if (mediaUrl && mediaPort === undefined && localOneBot(request) &&
                await serveMedia(request, response, images, mediaPrefix)) return;
            if (!session) {
                json(response, 401, { error: '请先登录管理面板' });
                return;
            }
            if (request.method === 'POST' && request.url === '/api/auth/logout') {
                auth.logout(request, response, proxied);
                json(response, 200, { ok: true });
            } else if (request.method === 'POST' && request.url === '/api/auth/password') {
                await auth.authenticate(request, response, 'change', await readConfig(request), { source: authSource, secure: proxied });
                logs.add('INFO', 'Auth', '管理密码已修改，旧会话已结束');
                json(response, 200, { ok: true });
            } else if (request.method === 'GET' && request.url === '/api/webui/settings') {
                json(response, 200, publicWebUI());
            } else if (request.method === 'POST' && request.url === '/api/webui/settings') {
                const { port: nextPort, logLevel, bindAddress: nextBind = webui.get().bindAddress ?? defaultBindAddress } =
                    await readConfig(request);
                if (session.aborted) throw new WebUIError('登录已失效，请重新登录', 401);
                if (!isIPv4(nextBind)) throw new WebUIError('监听地址须为 IPv4 地址，例如 0.0.0.0 或 127.0.0.1');
                if (!validPort(nextPort) || nextPort === mediaPort) {
                    throw new WebUIError('WebUI 端口须在 1024–65535 且与媒体端口不同');
                }
                if (!logLevels.includes(logLevel)) throw new WebUIError('日志级别无效');
                await webui.save({ port: nextPort, bindAddress: nextBind, logLevel, messageIdPort });
                logs.add('INFO', 'WebUI', nextPort === port && nextBind === bindAddress ? '已保存通用设置'
                    : `已保存通用设置，监听配置 ${nextBind}:${nextPort} 将在下次启动时生效`);
                json(response, 200, publicWebUI());
            } else if (request.url === '/api/onebot/logs') {
                if (request.method === 'GET') {
                    logs.stream(response, session);
                } else if (request.method === 'POST') {
                    logs.clear();
                    json(response, 200, { ok: true });
                } else {
                    response.writeHead(405, { Allow: 'GET, POST' }).end();
                }
            } else if (await serveMedia(request, response, images) ||
                (mediaPrefix && await serveMedia(request, response, images, mediaPrefix))) {
                return;
            } else if (request.method === 'GET' && request.url === '/api/overview/resources') {
                json(response, 200, await hostResources());
            } else if (request.method === 'GET' && request.url === '/api/messages') {
                json(response, 200, inbox.snapshot().map(session => ({
                    ...session, active: active.has(session.pid),
                })));
            } else if (request.method === 'GET' && request.url === '/api/processes') {
                json(response, 200, await discover());
            } else if (request.method === 'GET' && request.url === '/api/onebot/config') {
                json(response, 200, { ...await onebot.get(), localPort: port });
            } else if (request.method === 'GET' && request.url === '/api/onebot/status') {
                const reverseStates = reverse.status(client => new Map(client.status().map(
                    ({ selfId, state }) => [selfId, state])));
                json(response, 200, [...bindings.keys()].map(selfId => {
                    const reverseEndpoints = Object.fromEntries(Object.entries(reverseStates)
                        .map(([id, states]) => [id, states.get(selfId)]));
                    const httpPostEndpoints = httpPost.status(client => client.status(selfId));
                    const reverseValues = Object.values(reverseEndpoints);
                    const httpValues = Object.values(httpPostEndpoints);
                    const forwardEndpoints = forward.status(client => client.count(selfId));
                    const forwardConnections = Object.values(forwardEndpoints).reduce((sum, count) => sum + count, 0);
                    return { selfId, reverseEndpoints, httpPostEndpoints, forwardEndpoints, forwardConnections,
                        state: ['connected', 'connecting'].find(value => reverseValues.includes(value)) ?? 'unconfigured',
                        httpPost: ['failed', 'delivered', 'pending'].find(value => httpValues.includes(value)) ?? 'unconfigured' };
                }));
            } else if (request.method === 'POST' && request.url === '/api/onebot/config') {
                const change = await readConfig(request);
                if (session.aborted) throw new WebUIError('登录已失效，请重新登录', 401);
                const config = await onebot.save(change);
                logs.add('INFO', 'OneBot', '已保存连接配置');
                updateEndpoints(await onebot.getEndpoint());
                json(response, 200, { ...config, localPort: port });
            } else if (request.method === 'POST') {
                const action = /^\/api\/processes\/(\d+)\/(start|stop|unload)$/.exec(request.url);
                const pid = Number(action?.[1]);
                if (!action) {
                    response.writeHead(404).end();
                    return;
                }
                if (!validPid(pid)) {
                    json(response, 400, { error: '无效的进程或操作' });
                    return;
                }
                if (action[2] === 'start') {
                    if (!(await discover()).some(instance => instance.pid === pid)) {
                        json(response, 404, { error: '找不到这个 QQ 进程，请刷新列表' });
                        return;
                    }
                    await start(pid);
                } else {
                    const session = await active.get(pid);
                    const unload = action[2] === 'unload';
                    if (unload && !session) {
                        json(response, 409, { error: '该实例已结束监听，请刷新列表' });
                        return;
                    }
                    await session?.close({ verify: unload });
                    if (unload) logs.add('INFO', 'Session', `PID ${pid} · 已卸载监听`);
                }
                json(response, 200, { ok: true });
            } else {
                response.writeHead(404).end();
            }
        } catch (error) {
            if (error instanceof WebUIError) {
                json(response, error.status, { error: error.message });
                return;
            }
            if (error instanceof OneBotConfigError) {
                json(response, 400, { error: error.message });
                return;
            }
            logs.add('ERROR', 'WebUI', '管理请求处理失败' + (error.code ? ' · ' + error.code : ''));
            json(response, 500, { error: '操作失败，请查看终端日志' });
        }
    });
    server.on('upgrade', (request, socket, head) => {
        if (!localOneBot(request)) {
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            return;
        }
        const id = /^\/onebot\/ws\/([a-f0-9-]{36})(?=\/|\?|$)/.exec(request.url)?.[1] ?? 'default';
        const endpoint = forward.get(id);
        if (endpoint) endpoint.upgrade(request, socket, head);
        else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    });
    const mediaServer = mediaPort === undefined ? undefined : createServer(async (request, response) => {
        try {
            if (!await serveMedia(request, response, images) &&
                !(mediaPrefix && await serveMedia(request, response, images, mediaPrefix))) response.writeHead(404).end();
        } catch {
            logs.add('ERROR', 'Media', '读取已发布的媒体失败');
            response.writeHead(500).end();
        }
    });
    try {
        const ready = once(server, 'listening');
        server.listen(port, bindAddress);
        try {
            await ready;
        } catch (error) {
            if (error.code === 'EADDRNOTAVAIL') {
                throw new Error(`本机无法监听 ${bindAddress}，请用 --bind 127.0.0.1 启动并修改通用设置`);
            }
            if (error.code !== 'EADDRINUSE') throw error;
            throw new Error(`${bindAddress}:${port} 已被占用，请用 --port 指定可用端口`);
        }
        if (mediaServer) {
            const mediaReady = once(mediaServer, 'listening');
            mediaServer.listen(mediaPort, mediaBind ?? '127.0.0.1');
            await mediaReady;
        }
        if (resetPassword) await auth.reset();
        const name = messageIdPort === defaultPort ? 'message-ids.jsonl' : `message-ids-${messageIdPort}.jsonl`;
        ids = await openMessageIds(fileURLToPath(new URL('../../data/' + name, import.meta.url)));
        updateEndpoints(await onebot.getEndpoint());
        if (!webui.get().licenseNoticeShown) {
            writeTerminal('INFO', 'License', 'MiaoKo 非商业有限再分发许可 1.0。商业使用须事先获得权利人的书面许可，使用及再分发条款详见 LICENSE。');
            await webui.save({ licenseNoticeShown: true });
        }
        const address = bindAddress === '0.0.0.0' ? '127.0.0.1' : bindAddress;
        writeTerminal('INFO', 'WebUI', `管理面板已就绪  http://${address}:${port}/`);
        if (bindAddress === '0.0.0.0') {
            const addresses = Object.values(networkInterfaces()).flat()
                .filter(entry => !entry.internal && isPrivateAddress(entry.address)).map(entry => entry.address);
            for (const ip of new Set(addresses)) writeTerminal('INFO', 'WebUI', `网络访问  http://${ip}:${port}/`);
        }
        if (publicOrigin) writeTerminal('INFO', 'WebUI', 'HTTPS 反代地址  ' + publicOrigin.origin + '/');
        if (auth.code()) {
            if (process.stdout.isTTY) writeTerminal('INFO', 'Auth', '请在 WebUI 输入一次性初始化码并设置密码  ' + auth.code());
            else writeTerminal('WARN', 'Auth', '请在交互终端启动 MiaoKo 以获取一次性初始化码');
        }
        try {
            const running = requested.length ? requested : (await discover()).map(instance => instance.pid);
            const initial = requested.length || running.length === 1 ? [...new Set(running)] : [];
            logs.add('INFO', 'QQ', !running.length ? '等待桌面 QQ 上线' : initial.length
                ? `正在接入 ${initial.length} 个 QQ 实例` : `已发现 ${running.length} 个 QQ 实例，请在管理面板中选择监听`);
            await Promise.all(initial.map(start));
        } catch {
            logs.add('ERROR', 'QQ', '启动时无法完成 QQ 接入，请检查运行环境并在「QQ 实例」中重试');
        }
        await once(process, 'SIGINT');
    } finally {
        shuttingDown = true;
        auth.close();
        logs.close();
        const mediaClosed = mediaServer?.listening ? new Promise(resolve => mediaServer.close(resolve)) : undefined;
        const closed = server.listening ? new Promise(resolve => server.close(resolve)) : undefined;
        reverse.close();
        forward.close();
        httpPost.close();
        await Promise.allSettled([...active.values()].map(async session => (await session).close()));
        await Promise.all([closed, mediaClosed]);
        await Promise.all(publications.values());
        await ids?.close();
    }
}
