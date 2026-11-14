import { setupParticles } from './particles.mjs';
import { createQqAvatar } from './qq-avatar.mjs';
import { setupOneBotSettings } from '/onebot-settings.mjs';
import { setupOneBotLogs } from '/onebot-logs.mjs';
import { enterWebUI, setupGeneralSettings, jsonPost } from '/webui.mjs';

const ui = Object.fromEntries(
    ['discover', 'processes', 'title', 'status', 'toggle', 'unload', 'unload-dialog', 'unload-description', 'error', 'messages',
        'show-overview', 'show-instances', 'show-onebot', 'show-settings', 'show-logs', 'overview-view', 'instances-view',
        'onebot-view', 'settings-view', 'logs-view', 'page-label', 'service-status', 'onebot-status', 'overview-alerts',
        'overview-sessions', 'overview-host-info', 'overview-host-refresh', 'overview-cpu', 'overview-cpu-value',
        'overview-memory', 'overview-memory-value', 'overview-memory-detail', 'overview-pid',
        'overview-rss', 'overview-heap', 'overview-external']
        .map(id => [id, document.getElementById(id)]),
);
const states = {
    starting: '正在确认账号',
    receiving: '监听中',
    stopped: '已停止',
    error: '接入失败，查看终端',
    'account-unresolved': '无法确认登录账号',
    'account-changed': '账号已变化，请重新开始监听',
};
const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium' });
const pages = { overview: '总览', instances: 'QQ 实例', onebot: 'OneBot 配置', settings: '通用设置', logs: '日志' };
let discovered = [];
let sessions = [];
let page;
let discovering = false;
let selected;
let operating = false;
let refreshing = false;
let refreshingOneBot = false;
let sidebarKey;
let messageKey;
let overviewSessionsKey;
const oneBotSettings = setupOneBotSettings(api);
const showParticles = setupParticles(document.getElementById('overview-particles'));
const showOneBotLogs = setupOneBotLogs(renderOverviewAlerts);
const loadGeneralSettings = setupGeneralSettings(api);
let signedIn = false;

async function api(path, options) {
    const response = await fetch(path, { cache: 'no-store', ...options });
    const data = await response.json();
    if (!response.ok) {
        if (signedIn && response.status === 401 && path !== '/api/auth/password') location.reload();
        const error = new Error(data.error ?? '操作失败');
        error.status = response.status;
        throw error;
    }
    return data;
}

function showError(message = '') {
    ui.error.hidden = !message;
    ui.error.textContent = message;
}

function setText(element, value) {
    if (element.textContent !== value) element.textContent = value;
}

function showService(connected) {
    ui['service-status'].dataset.state = connected ? 'connected' : 'offline';
    setText(ui['service-status'], connected ? '服务已连接' : '服务未连接');
}

function renderInstance({ pid, selfId, state, available }) {
    const button = document.createElement('button');
    button.type = 'button';
    const avatar = createQqAvatar(selfId);
    const info = document.createElement('span');
    const name = document.createElement('strong');
    name.textContent = selfId ? 'QQ ' + selfId : '账号未识别';
    const detail = document.createElement('small');
    detail.textContent = 'PID ' + pid + ' · ' + (states[state] ?? (available ? '可接入' : '未运行'));
    info.append(name, detail);
    button.append(avatar, info);
    button.dataset.state = state ?? '';
    button.setAttribute('aria-pressed', String(pid === selected));
    button.onclick = () => { selected = pid; showError(); render(); };
    return button;
}

function render() {
    const available = new Map(discovered.map(({ pid, selfId }) => [pid, selfId]));
    const pids = [...new Set([...available.keys(), ...sessions.map(session => session.pid)])];
    if (!pids.includes(selected)) selected = pids[0];
    const session = sessions.find(entry => entry.pid === selected);
    const sidebar = pids.map(pid => {
        const entry = sessions.find(item => item.pid === pid);
        const detected = available.get(pid);
        const selfId = entry?.active ? entry.selfId ?? detected : detected ?? entry?.selfId;
        const switched = !entry?.active && detected && entry?.selfId && detected !== entry.selfId;
        return { pid, selfId, state: switched ? undefined : entry?.state, available: available.has(pid) };
    });
    const nextSidebarKey = JSON.stringify([selected, sidebar]);
    if (sidebarKey !== nextSidebarKey) {
        sidebarKey = nextSidebarKey;
        ui.processes.replaceChildren(...(sidebar.length ? sidebar.map(renderInstance) :
            [emptyState('未发现 QQ 实例')]));
    }
    const identity = sidebar.find(entry => entry.pid === selected);
    const current = identity?.selfId && session?.selfId && identity.selfId !== session.selfId
        ? undefined : session;
    setText(ui.title, identity?.selfId ? 'QQ ' + identity.selfId : selected ? 'PID ' + selected : '收信记录');
    setText(ui.status, current
        ? [states[current.state] ?? current.state, current.messages.length + ' 条', current.error]
            .filter(Boolean).join(' · ')
        : selected ? '等待开始监听' : '打开 QQ 后点击「刷新实例」');
    ui.toggle.hidden = !selected;
    setText(ui.toggle, session?.active ? '停止监听' : '开始监听');
    ui.toggle.classList.toggle('primary', !session?.active);
    ui.toggle.disabled = operating || (!session?.active && !available.has(selected));
    ui.unload.hidden = !session?.active;
    ui.unload.disabled = operating;
    const messages = current?.messages ?? [];
    const nextMessageKey = JSON.stringify([selected, messages]);
    if (messageKey !== nextMessageKey) {
        messageKey = nextMessageKey;
        ui.messages.replaceChildren(...(messages.length ? messages.map(renderMessage) :
            [emptyState('暂无消息')]));
    }
}

function emptyState(message) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = message;
    return empty;
}

function renderMessage(message) {
    const row = document.createElement('article');
    const meta = document.createElement('small');
    const date = new Date(Number(message.msgTime) * 1000);
    const time = Number.isFinite(date.getTime()) ? timeFormat.format(date) : '';
    const kind = message.chatType === 2 ? '群聊' : '私聊';
    meta.textContent = [time, kind + ' ' + (message.peerName || message.peerUin),
        message.nickname || message.senderUin].filter(Boolean).join(' · ');
    const body = document.createElement('p');
    const labels = { image: '[图片]', reply: '[引用]', face: '[表情]', json: '[卡片]', mface: '[商城表情]',
        forward: '[合并转发]', xml: '[卡片]', markdown: '[Markdown]', poke: '[戳一戳]',
        flashtransfer: '[QQ 闪传]', onlinefile: '[在线文件]',
        dice: '[骰子]', rps: '[包剪锤]', record: '[语音]', video: '[视频]', file: '[文件]' };
    body.textContent = message.segments?.map(segment => segment.text ?? labels[segment.type] ?? '').join('') ?? message.text;
    row.append(meta, body);
    return row;
}

async function discover() {
    if (discovering) return;
    discovering = true;
    ui.discover.disabled = true;
    try {
        discovered = await api('/api/processes');
        showError();
        render();
    } catch (error) {
        showError(error.message);
    } finally {
        discovering = false;
        ui.discover.disabled = false;
    }
}

async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
        sessions = await api('/api/messages');
        showService(true);
        renderOverviewSessions();
        render();
    } catch {
        showService(false);
        renderOverviewSessions(false);
        setText(ui.status, '本地接收服务未连接');
    } finally {
        refreshing = false;
    }
}

async function refreshOneBot() {
    if (refreshingOneBot || page !== 'onebot') return;
    refreshingOneBot = true;
    let connected = 0;
    let label;
    try {
        const accounts = await api('/api/onebot/status');
        oneBotSettings.showAccounts(accounts);
        connected = accounts.filter(account => account.state === 'connected').length;
        const connecting = accounts.filter(account => account.state === 'connecting').length;
        const forward = accounts.reduce((count, account) => count + (account.forwardConnections ?? 0), 0);
        const delivered = accounts.filter(account => account.httpPost === 'delivered').length;
        label = !accounts.length ? '等待 QQ 账号监听'
            : [connected && `反向 ${connected} 路`, connecting && `${connecting} 路连接中`,
                forward && `正向 ${forward} 路`, delivered && `回调 ${delivered} 路`].filter(Boolean).join(' · ') ||
                `${accounts.length} 个账号监听中`;
        connected += forward + delivered;
    } catch {
        label = '无法读取连接状态';
    } finally {
        refreshingOneBot = false;
    }
    ui['onebot-status'].dataset.state = connected ? 'connected' : 'pending';
    setText(ui['onebot-status'], label);
}

function navigate() {
    const hash = location.hash.slice(1);
    page = Object.hasOwn(pages, hash) ? hash : 'overview';
    for (const name of Object.keys(pages)) {
        ui[name + '-view'].hidden = name !== page;
        const link = ui['show-' + name];
        if (name === page) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
    setText(ui['page-label'], pages[page]);
    showParticles(page === 'overview');
    showOneBotLogs(page === 'logs' || page === 'overview');
    if (page === 'overview') void refreshHost();
    if (page === 'onebot') oneBotSettings.load();
    else if (page === 'settings') void loadGeneralSettings();
    else if (page !== 'logs') discover();
    refresh();
    refreshOneBot();
}

function renderOverviewAlerts(entries) {
    const alerts = entries.filter(entry => entry.level === 'WARN' || entry.level === 'ERROR').slice(-5).reverse();
    const rows = alerts.map(entry => {
        const row = document.createElement('li');
        row.dataset.level = entry.level;
        const time = document.createElement('time');
        const date = new Date(entry.time);
        time.dateTime = date.toISOString();
        time.textContent = timeFormat.format(date);
        const level = document.createElement('strong');
        level.textContent = entry.level;
        const message = document.createElement('span');
        message.textContent = '[' + entry.module + '] ' + entry.message;
        row.append(time, level, message);
        return row;
    });
    if (!rows.length) {
        const empty = document.createElement('li');
        empty.className = 'hint';
        empty.textContent = '暂无告警';
        rows.push(empty);
    }
    ui['overview-alerts'].replaceChildren(...rows);
}

function renderOverviewSessions(connected = true) {
    if (page !== 'overview') return;
    const online = connected ? sessions.filter(session => session.active && session.state === 'receiving' && session.selfId) : [];
    const accounts = [...new Map(online.map(session => [session.selfId, session])).values()];
    const key = JSON.stringify([connected, accounts.map(({ pid, selfId }) => [pid, selfId])]);
    if (key === overviewSessionsKey) return;
    overviewSessionsKey = key;
    const cards = accounts.map(({ pid, selfId }) => {
        const card = document.createElement('a');
        card.className = 'overview-session';
        card.href = '#instances';
        card.onclick = () => { selected = pid; render(); };
        const info = document.createElement('span');
        const name = document.createElement('strong');
        name.textContent = 'QQ ' + selfId;
        const detail = document.createElement('small');
        detail.textContent = 'PID ' + pid;
        const state = document.createElement('span');
        state.className = 'status-pill';
        state.dataset.state = 'connected';
        state.textContent = '监听中';
        info.append(name, detail);
        card.append(createQqAvatar(selfId), info, state);
        return card;
    });
    ui['overview-sessions'].replaceChildren(...(cards.length ? cards : [
        emptyState(connected ? '暂无在线会话' : '无法读取在线会话'),
    ]));
}

function formatBytes(bytes) {
    const unit = bytes >= 1024 ** 3 ? 'GB' : 'MB';
    return (bytes / (unit === 'GB' ? 1024 ** 3 : 1024 ** 2)).toFixed(1) + ' ' + unit;
}

function showUsage(key, percent) {
    const bar = ui['overview-' + key];
    if (percent === null) bar.removeAttribute('value');
    else bar.value = percent;
    setText(ui['overview-' + key + '-value'], percent === null ? '—' : percent.toFixed(1) + '%');
}

async function refreshHost() {
    const button = ui['overview-host-refresh'];
    if (button.disabled) return;
    button.disabled = true;
    button.textContent = '刷新中…';
    try {
        const host = await api('/api/overview/resources');
        setText(ui['overview-host-info'], [host.cpuModel, host.cpuCount + ' 个逻辑核心', 'Node ' + host.node]
            .filter(Boolean).join(' · '));
        showUsage('cpu', host.cpuPercent);
        const used = Math.max(0, host.totalMemory - host.freeMemory);
        showUsage('memory', host.totalMemory > 0 ? 100 * used / host.totalMemory : null);
        setText(ui['overview-memory-detail'], formatBytes(used) + ' / ' + formatBytes(host.totalMemory) +
            ' · 空闲 ' + formatBytes(host.freeMemory));
        setText(ui['overview-pid'], 'PID ' + host.pid);
        setText(ui['overview-rss'], formatBytes(host.memory.rss));
        setText(ui['overview-heap'], formatBytes(host.memory.heapUsed) + ' / ' + formatBytes(host.memory.heapTotal));
        setText(ui['overview-external'], formatBytes(host.memory.external));
    } catch {
        setText(ui['overview-host-info'], '无法读取资源，请重试');
    } finally {
        button.disabled = false;
        button.textContent = '刷新';
    }
}

ui['overview-host-refresh'].onclick = refreshHost;
ui.discover.onclick = discover;
async function operate(pid, action) {
    operating = true;
    showError();
    render();
    try {
        await api('/api/processes/' + pid + '/' + action, { method: 'POST' });
        await refresh();
    } catch (error) {
        showError(error.message);
    } finally {
        operating = false;
        render();
    }
}
ui.toggle.onclick = () => operate(selected,
    sessions.some(session => session.pid === selected && session.active) ? 'stop' : 'start');
const unloadDialog = ui['unload-dialog'];
let unloadPid;
ui.unload.onclick = () => {
    unloadPid = selected;
    unloadDialog.returnValue = '';
    ui['unload-description'].textContent = `确定要从 ${ui.title.textContent}（PID ${unloadPid}）卸载监听吗？`;
    unloadDialog.showModal();
};
unloadDialog.addEventListener('close', () => {
    if (unloadDialog.returnValue === 'unload') void operate(unloadPid, 'unload');
});
signedIn = await enterWebUI(api, showParticles);
if (signedIn) {
    document.getElementById('dashboard').hidden = false;
    document.getElementById('logout').onclick = async event => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
            await api('/api/auth/logout', jsonPost());
            location.reload();
        } catch {
            button.textContent = '退出失败，重试';
            button.disabled = false;
        }
    };
    window.addEventListener('hashchange', navigate);
    render();
    navigate();
    setInterval(() => { if (page === 'instances') refresh(); }, 250);
    setInterval(() => { if (page !== 'instances') refresh(); }, 2000);
    setInterval(refreshOneBot, 2000);
}
