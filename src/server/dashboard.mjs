import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { isIPv4, isIPv6 } from 'node:net';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { cpus, freemem, networkInterfaces, totalmem } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { backgroundPython, startCapture } from '../qq/hook/capture-session.mjs';
import { createInbox } from '../qq/inbox.mjs';
import { createOneBotConfig, getBoundEndpoints, serverEndpointPath, generalDefaults, OneBotConfigError } from '../onebot/config.mjs';
import { createActions } from '../onebot/actions/index.mjs';
import { createReplyRecords } from '../onebot/reply-records.mjs';
import { openMessageIds } from '../onebot/message-ids.mjs';
import { toOneBotRecord, withWavRecordUrls } from '../onebot/message.mjs';
import { toOneBotNotice, toOneBotRequest } from '../onebot/notice.mjs';
import { createOutgoingClients } from '../onebot/outgoing.mjs';
import { createReverseWs } from '../onebot/reverse-ws.mjs';
import { createForwardWs } from '../onebot/forward-ws.mjs';
import { handleOneBotHttp, oneBotHttpAction } from '../onebot/http.mjs';
import { createHttpPost } from '../onebot/http-post.mjs';
import { ActionError, qqId } from '../onebot/actions/shared.mjs';
import { InvalidImage, MAX_IMAGE_BYTES, MAX_TOTAL_BYTES, prepareMedia } from '../qq/actions/messages/image-files.mjs';
import { createReceivedImages, mediaBaseUrl, serveMedia } from './received-images.mjs';
import { createOneBotLogs, describeOneBotEvent, writeTerminal } from './onebot-logs.mjs';
import { createOneBotListeners, oneBotListeners } from './onebot-listeners.mjs';
import { createSendQueue } from './send-queue.mjs';
import { createWebUIAuth } from './webui-auth.mjs';
import { defaultBindAddress, defaultPort, logLevels, openStickerSummarySettings, openWebUISettings,
    validPort, WebUIError } from './webui-settings.mjs';

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
        return JSON.parse((await exec(backgroundPython(python), [capture, '--list'], { windowsHide: true })).stdout);
    }

    const inbox = createInbox();
    const retryWarnings = new Set();
    const logs = createOneBotLogs(({ level, module, message, detailsOnly }) => {
        if (detailsOnly) return;
        if (['Event', 'Notice', 'Action', 'HTTP'].includes(module) && level === 'SUCCESS') return;
        if (logLevels.indexOf(level === 'SUCCESS' ? 'INFO' : level) <
            logLevels.indexOf(webui.get().logLevel ?? 'INFO')) return;
        const safeMessage = message.replace(/\bQQ (\d+)(\d{4})\b/g, 'QQ ****$2');
        writeTerminal(level === 'SUCCESS' ? 'INFO' : level, module, safeMessage);
    });
    const auth = createWebUIAuth(webui, source => logs.add('WARN', 'Auth',
        source ? `来源 ${source} 登录失败次数过多，已暂时限速` : '远程登录失败次数过多，已暂时限速'));
    const onebot = createOneBotConfig(fileURLToPath(new URL('../../data/onebot.json', import.meta.url)));
    const stickerSummaryPath = fileURLToPath(new URL('../../data/sticker-summary.json', import.meta.url));
    const stickerSummary = await openStickerSummarySettings(stickerSummaryPath);
    const stickerHooks = new Map();
    const active = new Map();
    const manuallyStopped = new Set();
    const timedCaptures = new Set();
    const autoRetryAt = new Map();
    let discoveryTimer;
    let discoveryStatus;
    const bindings = new Map();
    const runningPokes = new Set();
    const enqueueSend = createSendQueue();
    const memberLists = new Map();
    const listingGroupFiles = new Set();
    const host = '127.0.0.1:' + port;
    const localOneBot = request => request.socket.remoteAddress === '127.0.0.1' && request.headers.host === host;
    let settingsUpdate = Promise.resolve();
    function saveSettings(session, save) {
        const operation = settingsUpdate.then(() => {
            if (session.aborted || shuttingDown) throw new WebUIError('登录已失效，请重新登录', 401);
            return save();
        });
        settingsUpdate = operation.catch(() => {});
        return operation;
    }
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
        if (type === 'get-group-member-list') {
            const key = account + ':' + params.group + ':' + params.noCache;
            const current = memberLists.get(key);
            if (current) return current;
            const pending = request(account, type, params);
            memberLists.set(key, pending);
            try {
                return await pending;
            } finally {
                memberLists.delete(key);
            }
        }
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

    function sendWithMedia(account, segments, send, cleanupError = '图片暂存清理失败') {
        return enqueueSend(account, async () => {
            if (shuttingDown) throw new ActionError(1500, 'MiaoKo is shutting down');
            let prepared;
            let outcome;
            try {
                if (segments) prepared = await prepareMedia(join(mediaRoot, 'outgoing'), segments);
                outcome = await send(prepared?.segments);
                return outcome;
            } catch (error) {
                if (error instanceof InvalidImage) throw new ActionError(1400, error.message);
                throw error;
            } finally {
                await prepared?.close({ uncertain: outcome?.status === 'unknown' }).catch(() =>
                    logs.add('WARN', 'Media', cleanupError));
            }
        });
    }

    const dispatch = createActions({
        ids: { get: (...args) => ids.get(...args), resolve: (...args) => ids.resolve(...args) },
        accounts: () => [...bindings.keys()],
        request: requestOneBot,
        images,
        pendingRequests,
        formatRecord: format,
        replyRecords,
        uploadGroupAlbum(account, { group, albumId, albumName, file }) {
            return sendWithMedia(account, [{ type: 'image', data: { file } }], ([{ data }]) => {
                const { path, md5, fileName, size } = data;
                return request(account, 'upload-group-album', { group, albumId, albumName, path, md5, fileName, size });
            });
        },
        sendForwardBatch(account, params) {
            const segments = params.nodes?.flatMap(node => node.segments);
            return sendWithMedia(account, segments, prepared => {
                if (params.nodes) {
                    let offset = 0;
                    const nodes = params.nodes.map(({ segments, ...node }) => {
                        const start = offset;
                        offset += segments.length;
                        return { ...node, segments: prepared.slice(start, offset) };
                    });
                    params = { ...params, nodes };
                }
                return request(account, 'send-forward-message', params);
            }, '转发媒体暂存清理失败');
        },
        sendMessage(account, kind, peer, segments) {
            return sendWithMedia(account, segments, prepared =>
                request(account, 'send-message', { kind, peer, segments: prepared }));
        },
        async readMessage(account, reference) {
            const result = await request(account, 'get-message', { reference });
            if (result.status === 'ok') {
                const { seq, parentId } = reference;
                return format(account, result.message, { seq, parentId });
            }
        },
    });
    function loggedDispatch(transport, handle = dispatch) {
        return Object.assign(async (packet, account) => {
            const started = performance.now();
            const result = await handle(packet, account);
            const action = typeof packet?.action === 'string' && /^[a-z_]{1,80}$/.test(packet.action)
                ? packet.action : '无效动作';
            const candidate = account ?? packet?.params?.self_id;
            const identity = typeof candidate === 'string' || typeof candidate === 'number' ? String(candidate) : '';
            const owner = /^[1-9]\d{4,11}$/.test(identity) ? ` · QQ ${identity}` : '';
            const error = result.retcode !== 0 && result.message ? ` · ${result.message.slice(0, 240)}` : '';
            logs.add(result.retcode === 0 ? 'SUCCESS' : 'WARN', 'Action',
                `${transport}${owner} · ${action} · retcode ${result.retcode} · ${Math.round(performance.now() - started)} ms${error}`,
                { detailsOnly: action === 'send_like' && result.retcode !== 0 });
            return result;
        }, { supports: dispatch.supports });
    }
    const httpDispatch = loggedDispatch('HTTP');
    const webUIDispatch = loggedDispatch('WebUI');
    const quickPokeDispatch = loggedDispatch('WebUI', async ({ params }, account) => {
        const outcome = await request(account, 'send-poke-batch', params);
        return {
            retcode: outcome.status === 'ok' ? 0 : outcome.status === 'unknown' ? 1501 : 1500,
            sent: outcome.sent ?? 0, failedAt: outcome.failedAt, message: outcome.error,
        };
    });
    const reverse = createOutgoingClients(id => createReverseWs({
        dispatch: loggedDispatch('反向 WS'),
        formatEvent(event, endpointUrl) {
            if (mediaUrl) return withWavRecordUrls(event, baseUrl);
            if (!endpointUrl || !['0.0.0.0', '127.0.0.1'].includes(bindAddress)) return event;
            const { hostname } = new URL(endpointUrl);
            return ['localhost', '127.0.0.1', '[::1]'].includes(hostname)
                ? withWavRecordUrls(event, baseUrl) : event;
        },
        onState(account, state, detail) {
            const labels = { connecting: '正在连接反向 WebSocket', connected: '反向 WebSocket 已连接',
                retrying: '反向 WebSocket 已断开，等待重连', invalid: '收到无效的 OneBot JSON 请求' };
            const key = id + ':' + account;
            const repeatedRetry = state === 'retrying' && retryWarnings.has(key);
            if (state === 'retrying') retryWarnings.add(key);
            else if (state === 'connected') retryWarnings.delete(key);
            logs.add(repeatedRetry ? 'DEBUG' : state === 'retrying' || state === 'invalid' ? 'WARN'
                : state === 'connected' ? 'SUCCESS' : 'DEBUG',
                'WebSocket', `QQ ${account} · 端点 ${id} · ${labels[state]}${detail ? ` · ${detail}` : ''}`);
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
    let dashboardForwardIds = new Set();

    const oneBotServers = createOneBotListeners({
        reservedPorts: () => [port, webui.get().port ?? defaultPort, mediaPort],
        async handleHttp(entry, request, response) {
            const authority = request.socket.localAddress + ':' + entry.port;
            if (request.headers.host !== authority) return json(response, 403, { error: 'Forbidden' });
            if (!ids || shuttingDown) return json(response, 503, { error: 'MiaoKo 正在启动或停止' });
            try {
                const url = new URL(request.url, 'http://' + authority);
                const action = oneBotHttpAction(request, url, dispatch, entry.path === '/' ? '' : entry.path);
                await serveOneBotHttp(request, url, response, action, entry.endpoint, authority);
            } catch {
                if (!response.headersSent) json(response, 500, { error: 'OneBot 请求处理失败' });
                else response.end();
            }
        },
        handleUpgrade(entry, request, socket, head) {
            const authority = request.socket.localAddress + ':' + entry.port;
            if (request.headers.host !== authority) {
                socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
                return;
            }
            forward.get(entry.id)?.upgrade(request, socket, head,
                { host: authority, basePath: entry.path === '/' ? '' : entry.path });
        },
        onFailure: message => logs.add('ERROR', 'OneBot', message),
    });

    async function serveOneBotHttp(request, url, response, action, endpoint, authority) {
        if (!action || !endpoint?.httpEnabled) {
            json(response, 404, { status: 'failed', retcode: 1404, data: null, message: 'OneBot HTTP endpoint not found' });
            return;
        }
        const { status, body } = await handleOneBotHttp({ request, url, action, dispatch: httpDispatch,
            host: authority, accessToken: endpoint.httpAccessToken, selfId: endpoint.selfId });
        json(response, status, body);
    }

    function updateEndpoints(config) {
        const next = { ...generalDefaults, ...config };
        if (!next.statusEnabled || next.statusTrigger !== general.statusTrigger ||
            next.statusCooldown !== general.statusCooldown) statusReplies.clear();
        general = next;
        const reverseEndpoints = getBoundEndpoints(config, 'reverse');
        const forwardEndpoints = getBoundEndpoints(config, 'forward');
        dashboardForwardIds = new Set(forwardEndpoints.filter(endpoint => endpoint.forwardWsPort === undefined)
            .map(endpoint => endpoint.id));
        reportSelf = forwardEndpoints.some(endpoint => endpoint.forwardWsEnabled && endpoint.forwardWsReportSelf) ||
            reverseEndpoints.some(endpoint => endpoint.reverseWsEnabled &&
                endpoint.reverseWsReportSelf && endpoint.reverseWsRole !== 'Api');
        reverse.update(reverseEndpoints);
        forward.update(forwardEndpoints);
        httpPost.update(getBoundEndpoints(config, 'http-post'));
    }

    async function watchStickerSummary(account, pid) {
        const hook = stickerHooks.get(pid);
        if (shuttingDown || !hook || !stickerSummary.get(account).summary ||
            hook.state === 'ready' || hook.state === 'pending' || !bindings.get(account)?.get(pid)) return;
        hook.state = 'pending';
        try {
            const session = await active.get(pid);
            const outcome = await session?.request(account, 'watch-sticker-summary', { settingsPath: stickerSummaryPath });
            if (outcome?.status !== 'ok') throw new Error(outcome?.error ?? 'QQ 监听已结束');
            hook.state = 'ready';
            if (stickerHooks.get(pid) === hook) logs.add('INFO', 'QQ', `PID ${pid} · 表情包摘要监听已就绪`);
        } catch (error) {
            hook.state = 'failed';
            if (stickerHooks.get(pid) === hook) {
                logs.add('WARN', 'QQ', `PID ${pid} · 表情包摘要接入失败 · ${error.message}`);
            }
        }
    }

    function bind(account, pid, duplex) {
        if (seconds !== undefined) timedCaptures.add(pid);
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
        if (processes?.delete(pid)) {
            stickerHooks.delete(pid);
            logs.add('INFO', 'Session', `QQ ${account} · PID ${pid} 已停止监听`);
        }
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
                if (!bindings.get(account)?.get(pid)) return;
                // The capture worker retries the notice action until QQ's action queue exists.
                stickerHooks.set(pid, { state: 'waiting' });
                void watchStickerSummary(account, pid);
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

    async function autoListen() {
        if (shuttingDown) return;
        function status(message, level = 'INFO') {
            if (message === discoveryStatus) return;
            discoveryStatus = message;
            if (message) logs.add(level, 'QQ', message);
        }
        try {
            const instances = await discover();
            if (shuttingDown) return;
            const pids = new Set(instances.map(({ pid }) => pid));
            for (const entries of [manuallyStopped, timedCaptures, autoRetryAt]) {
                for (const pid of entries.keys()) if (!pids.has(pid) && !active.has(pid)) entries.delete(pid);
            }
            const online = instances.filter(({ selfId }) => selfId);
            if (!online.length && !active.size) {
                status('等待桌面 QQ 上线');
            } else if (online.length > 1 && online.some(({ pid }) => !active.has(pid))) {
                status(`已发现 ${online.length} 个已登录的 QQ 实例，请在管理面板中选择监听`);
            } else {
                status(undefined);
                const pid = online[0]?.pid;
                if (online.length === 1 && !active.has(pid) && !manuallyStopped.has(pid) &&
                    !timedCaptures.has(pid) && Date.now() >= (autoRetryAt.get(pid) ?? 0)) {
                    autoRetryAt.set(pid, Date.now() + 15000);
                    logs.add('INFO', 'QQ', `正在接入 QQ 实例 · PID ${pid}`);
                    await start(pid);
                }
            }
        } catch {
            if (!shuttingDown) status('暂时无法检测或接入桌面 QQ，将自动重试', 'WARN');
        } finally {
            if (!shuttingDown) discoveryTimer = setTimeout(autoListen, 3000);
        }
    }

    function json(response, status, data) {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        response.end(JSON.stringify(data));
    }

    async function readConfig(request, limit = 8192) {
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

    async function quickForward({ selfId, groupId, target = { kind: 'group', id: groupId }, nodes }, session) {
        if (session.aborted || shuttingDown) throw new WebUIError('登录已失效，请重新登录', 401);
        if (typeof selfId !== 'string' || !/^[1-9]\d{4,11}$/.test(selfId)) {
            throw new WebUIError('请选择有效的发送账号');
        }
        if (![...(bindings.get(selfId)?.values() ?? [])].some(Boolean)) {
            throw new WebUIError('发送账号未就绪，请在「QQ 实例」开始监听', 409);
        }
        if (!['group', 'private'].includes(target?.kind) ||
            typeof target.id !== 'string' || !/^[1-9]\d{4,11}$/.test(target.id)) {
            throw new WebUIError('请选择目标群聊或私聊');
        }
        if (!Array.isArray(nodes) || !nodes.length || nodes.length > 50) throw new WebUIError('请添加 1–50 个节点');
        let imageBytes = 0;
        const drafts = nodes.map((node, index) => {
            if (typeof node?.content !== 'string' ||
                (node.nickname !== undefined && typeof node.nickname !== 'string') ||
                (node.avatar !== undefined && typeof node.avatar !== 'string')) {
                throw new WebUIError(`请检查节点 ${index + 1} 的昵称、头像和内容`);
            }
            const images = node.images === undefined ? [] : node.images;
            if (!Array.isArray(images) || images.length > 4) throw new WebUIError(`节点 ${index + 1} 最多添加 4 张图片`);
            const content = node.content.trim() ? [{ type: 'text', data: { text: node.content } }] : [];
            for (const image of images) {
                if (typeof image !== 'string' || image.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
                    image.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
                    throw new WebUIError(`节点 ${index + 1} 的图片无效或超过 5 MiB`);
                }
                const padding = image.endsWith('==') ? 2 : image.endsWith('=') ? 1 : 0;
                const bytes = image.length / 4 * 3 - padding;
                if (bytes > MAX_IMAGE_BYTES || (imageBytes += bytes) > MAX_TOTAL_BYTES) {
                    throw new WebUIError('单张图片最多 5 MiB，整条转发的图片合计最多 10 MiB');
                }
                content.push({ type: 'image', data: { file: 'base64://' + image } });
            }
            if (!content.length) throw new WebUIError(`请为节点 ${index + 1} 填写正文或添加图片`);
            return { previewName: node.nickname?.trim(), avatar: node.avatar?.trim(), content };
        });
        const nicknames = new Map();
        const messages = [];
        for (const { avatar, content, previewName } of drafts) {
            if (session.aborted || shuttingDown) throw new WebUIError('登录已失效，请重新登录', 401);
            const user = /^[1-9]\d{4,11}$/.test(avatar ?? '') ? avatar : selfId;
            if (!nicknames.has(user)) {
                const result = await dispatch({ action: 'get_stranger_info', params: { user_id: user } }, selfId);
                nicknames.set(user, result.data?.nickname?.trim() || user);
            }
            const nickname = nicknames.get(user);
            messages.push({ type: 'node', data: { user_id: selfId, nickname,
                preview_name: previewName || nickname, avatar, content } });
        }
        if (session.aborted || shuttingDown) throw new WebUIError('登录已失效，请重新登录', 401);
        const group = target.kind === 'group';
        const result = await webUIDispatch({ action: group ? 'send_group_forward_msg' : 'send_private_forward_msg',
            params: { [group ? 'group_id' : 'user_id']: target.id, messages } }, selfId);
        if (result.retcode === 0) return { messageId: result.data.message_id };
        if (result.retcode === 1501) throw new WebUIError('QQ 未确认发送结果，请先查看目标会话', 504);
        throw new WebUIError(result.message ?? '合并转发失败', result.retcode < 1500 ? 400 : 502);
    }

    async function quickPoke({ selfId, userId, groupId, count, intervalMs = 500 }, session) {
        let account, user, group;
        try {
            account = qqId(selfId, '发送账号');
            user = qqId(userId, '目标 QQ 号');
            if (groupId !== undefined) group = qqId(groupId, '群号');
        } catch (error) {
            if (!(error instanceof ActionError)) throw error;
            throw new WebUIError(error.message.replace('Invalid ', '') + '无效');
        }
        if (!Number.isInteger(count) || count < 1 || count > 10) throw new WebUIError('次数须为 1–10 的整数');
        if (!Number.isInteger(intervalMs) || intervalMs < 100 || intervalMs > 2000 || intervalMs % 100 !== 0) {
            throw new WebUIError('发送间隔须为 0.1–2 秒，步长为 0.1 秒');
        }
        if (session.aborted || shuttingDown) throw new WebUIError('登录已失效，请重新登录', 401);
        if (![...(bindings.get(account)?.values() ?? [])].some(Boolean)) {
            throw new WebUIError('发送账号未就绪，请在「QQ 实例」开始监听', 409);
        }
        if (runningPokes.has(account)) throw new WebUIError('该账号正在执行戳一戳，请稍后再试', 409);

        const cancelPath = join(mediaRoot, '..', `quick-poke-${randomUUID()}.cancel`);
        const packet = {
            action: 'send_poke',
            params: { ...(group ? { group } : { user }), target: user, count, intervalMs, cancelPath },
        };
        let cancellation;
        const cancel = () => {
            cancellation = writeFile(cancelPath, '').catch(() =>
                logs.add('WARN', 'WebUI', '无法取消戳一戳批次'));
        };
        runningPokes.add(account);
        session.addEventListener('abort', cancel, { once: true });
        try {
            const { sent, retcode, failedAt, message } = await quickPokeDispatch(packet, account);
            if (retcode === 0) return { sent };
            const reason = retcode === 1501 ? 'QQ 未确认戳一戳' : '戳一戳失败';
            const error = reason + (message ? `（${message}）` : '');
            return { sent, error: failedAt ? `第 ${failedAt} 次：${error}` : error };
        } finally {
            session.removeEventListener('abort', cancel);
            runningPokes.delete(account);
            if (cancellation) {
                await cancellation;
                await unlink(cancelPath).catch(() => {});
            }
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
                const endpoint = getBoundEndpoints(config, 'http')
                    .find(entry => entry.id === httpId && entry.httpPort === undefined);
                await serveOneBotHttp(request, url, response, action, endpoint, host);
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
                    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://q4.qlogo.cn https://p.qlogo.cn data:; " +
                        "frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
                response.end(asset.body);
                return;
            }
            // Explicitly published OneBot media URLs are capabilities used by clients without a WebUI session.
            if (mediaPort === undefined && localOneBot(request) &&
                await serveMedia(request, response, images, mediaPrefix, !mediaUrl)) return;
            if (!session) {
                json(response, 401, { error: '请先登录管理面板' });
                return;
            }
            if (request.method === 'POST' && request.url === '/api/auth/logout') {
                await auth.logout(request, response, proxied);
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
                await saveSettings(session, async () => {
                    const config = await onebot.getEndpoint();
                    if (oneBotListeners(config).some(entry => entry.port === nextPort)) {
                        throw new WebUIError(`端口 ${nextPort} 已分配给 OneBot 端点`);
                    }
                    await webui.save({ port: nextPort, bindAddress: nextBind, logLevel, messageIdPort });
                });
                logs.add('INFO', 'WebUI', nextPort === port && nextBind === bindAddress ? '已保存通用设置'
                    : `已保存通用设置，监听配置 ${nextBind}:${nextPort} 将在下次启动时生效`);
                json(response, 200, publicWebUI());
            } else if (request.method === 'POST' && request.url === '/api/webui/quick-poke') {
                json(response, 200, await quickPoke(await readConfig(request), session));
            } else if (request.method === 'POST' && request.url === '/api/webui/quick-forward') {
                json(response, 200, await quickForward(await readConfig(request, 15 * 1024 * 1024), session));
            } else if (['/api/webui/conversations', '/api/webui/sticker-summary/conversations'].includes(url.pathname) &&
                request.method === 'GET') {
                const account = url.searchParams.get('self_id');
                if (!/^[1-9]\d{4,11}$/.test(account ?? '')) throw new WebUIError('请选择有效的发送账号');
                if (![...(bindings.get(account)?.values() ?? [])].some(Boolean)) {
                    throw new WebUIError('请先在「QQ 实例」开始监听该账号', 409);
                }
                const [friends, groups] = await Promise.all([
                    dispatch({ action: 'get_friend_list' }, account),
                    dispatch({ action: 'get_group_list' }, account),
                ]);
                if (friends.retcode && groups.retcode) throw new WebUIError('QQ 好友和群聊列表暂时无法读取', 502);
                const conversations = [
                    ...(friends.data ?? []).map(friend => ({
                        kind: 'private', id: String(friend.user_id), name: friend.remark || friend.nickname,
                        nickname: friend.nickname,
                    })),
                    ...(groups.data ?? []).map(group => ({
                        kind: 'group', id: String(group.group_id), name: group.group_name,
                    })),
                ];
                json(response, 200, { conversations, incomplete: Boolean(friends.retcode || groups.retcode) });
            } else if (url.pathname === '/api/webui/sticker-summary' && ['GET', 'POST'].includes(request.method)) {
                const input = request.method === 'POST' ? await readConfig(request) : null;
                const account = input?.selfId ?? url.searchParams.get('self_id');
                if (typeof account !== 'string' || !/^[1-9]\d{4,11}$/.test(account)) {
                    throw new WebUIError('请选择有效的发送账号');
                }
                if (input) {
                    await saveSettings(session, () => stickerSummary.save(account, input));
                    for (const pid of bindings.get(account)?.keys() ?? []) void watchStickerSummary(account, pid);
                }
                json(response, 200, await stickerSummary.view(account));
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
                    canPoke: bindings.get(session.selfId)?.get(session.pid) === true,
                })));
            } else if (request.method === 'GET' && request.url === '/api/processes') {
                json(response, 200, await discover());
            } else if (request.method === 'GET' && request.url === '/api/onebot/config') {
                json(response, 200, { ...await onebot.get(), localPort: port, listenerErrors: oneBotServers.errors() });
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
                const config = await saveSettings(session, () => onebot.save(change, async next => {
                    const listenerChange = await oneBotServers.prepare(next);
                    return {
                        rollback: listenerChange.rollback,
                        commit() {
                            updateEndpoints(next);
                            listenerChange.commit();
                        },
                    };
                }));
                logs.add('INFO', 'OneBot', '已保存连接配置');
                json(response, 200, { ...config, localPort: port, listenerErrors: oneBotServers.errors() });
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
                    manuallyStopped.delete(pid);
                    await start(pid);
                } else {
                    const unload = action[2] === 'unload';
                    const pending = active.get(pid);
                    if (unload && !pending) {
                        json(response, 409, { error: '该实例已结束监听，请刷新列表' });
                        return;
                    }
                    manuallyStopped.add(pid);
                    const session = await pending;
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
        const endpoint = dashboardForwardIds.has(id) && forward.get(id);
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
        const initialConfig = await onebot.getEndpoint();
        const listeners = await oneBotServers.prepare(initialConfig, true);
        updateEndpoints(initialConfig);
        listeners.commit();
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
        if (requested.length) {
            const initial = [...new Set(requested)];
            logs.add('INFO', 'QQ', `正在接入 ${initial.length} 个 QQ 实例`);
            void Promise.all(initial.map(start)).catch(() => {
                if (!shuttingDown) logs.add('ERROR', 'QQ', '启动时无法完成 QQ 接入，请在「QQ 实例」中重试');
            });
        } else {
            void autoListen();
        }
        await once(process, 'SIGINT');
    } finally {
        shuttingDown = true;
        clearTimeout(discoveryTimer);
        await auth.close();
        await settingsUpdate;
        logs.close();
        const mediaClosed = mediaServer?.listening ? new Promise(resolve => mediaServer.close(resolve)) : undefined;
        const closed = server.listening ? new Promise(resolve => server.close(resolve)) : undefined;
        reverse.close();
        forward.close();
        const oneBotClosed = oneBotServers.close();
        httpPost.close();
        await Promise.allSettled([...active.values()].map(async session => (await session).close()));
        await Promise.all([closed, mediaClosed, oneBotClosed]);
        await Promise.all(publications.values());
        await ids?.close();
    }
}
