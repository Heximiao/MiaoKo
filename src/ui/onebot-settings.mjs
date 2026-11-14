import { createQqAvatar } from './qq-avatar.mjs';

const endpointTypes = {
    http: { name: 'httpName', configured: 'httpConfigured', title: 'HTTP API', enabled: 'httpEnabled', token: 'httpAccessToken', hasToken: 'hasHttpAccessToken',
        description: '通过 HTTP 调用 OneBot 动作。' },
    'http-post': { name: 'httpPostName', title: 'HTTP 客户端', enabled: 'httpPostEnabled', url: 'httpPostUrl',
        description: '通过 HTTP POST 向下游推送消息和通知。', placeholder: 'http://127.0.0.1:8080/events' },
    forward: { name: 'forwardWsName', configured: 'forwardWsConfigured',
        format: 'forwardWsFormat', self: 'forwardWsReportSelf', title: 'WebSocket 服务端', enabled: 'forwardWsEnabled', token: 'forwardWsAccessToken',
        hasToken: 'hasForwardWsAccessToken',
        description: '下游主动连接 MiaoKo。/ 收发合一，/api 和 /event 分开使用。' },
    reverse: { name: 'reverseWsName', format: 'reverseWsFormat', self: 'reverseWsReportSelf', title: 'WebSocket 客户端', enabled: 'reverseWsEnabled', url: 'reverseWsUrl',
        token: 'reverseWsAccessToken', hasToken: 'hasReverseWsAccessToken',
        description: 'MiaoKo 为每个监听账号主动连接下游。', placeholder: 'ws://127.0.0.1:6199/ws' },
};

export function setupOneBotSettings(api) {
    const byId = id => document.getElementById(id);
    const ui = name => byId('onebot-' + name);
    const editor = ui('editor');
    const create = ui('create');
    const result = ui('result');
    const editorSave = ui('editor-save');
    const editorUrl = ui('editor-url');
    const editorError = ui('editor-result');
    const tabs = [...ui('tabs').querySelectorAll('[role="tab"]')];
    const token = ui('token');
    const clearToken = ui('clear-token');
    const secret = ui('http-post-secret');
    const clearSecret = ui('clear-http-post-secret');
    const generalFields = {
        statusEnabled: ui('status-enabled'), statusTrigger: ui('status-trigger'),
        statusCooldown: ui('status-cooldown'), statusSwallow: ui('status-swallow'),
    };
    const generalSave = ui('general-save');
    const nodes = ui('nodes');
    const nodeTemplate = ui('node-template');
    const cards = new Map();
    let renderedKind;
    let editingId;
    let settings;
    let loading = false;
    let saving = false;
    let active = 'general';
    let editing;
    let accounts = [];
    let accountsKey;

    function localAddress(kind, id) {
        const localHost = '127.0.0.1:' + settings.localPort;
        const wsAddress = 'ws://' + localHost + '/';
        const http = kind === 'http';
        const base = http ? 'http://' + localHost : wsAddress.slice(0, -1);
        return id && id !== 'default' ? base + '/onebot/' + (http ? 'http' : 'ws') + '/' + id
            : http ? base : wsAddress;
    }
    const hasToken = (spec, endpoint) => endpoint[spec.hasToken] ?? endpoint.hasAccessToken;
    const endpointLists = { http: 'httpEndpoints', forward: 'forwardWsEndpoints',
        reverse: 'reverseWsEndpoints', 'http-post': 'httpPostEndpoints' };

    function endpoints(kind) {
        if (!settings) return [];
        const spec = endpointTypes[kind];
        const configured = spec.url ? Boolean(settings[spec.url]) : settings[spec.configured] !== false;
        return settings[endpointLists[kind]] ?? (configured ? [{ ...settings, id: 'default' }] : []);
    }

    function statusFor(kind, endpoint) {
        if (!endpoint[endpointTypes[kind].enabled]) return ['offline', '已停用'];
        if (kind === 'reverse') {
            const states = accounts.map(account => account.reverseEndpoints?.[endpoint.id] ??
                (endpoint.id === 'default' && !account.reverseEndpoints ? account.state : undefined));
            const connected = states.filter(state => state === 'connected').length;
            if (connected) return ['connected', '已连接 ' + connected + ' 路'];
            if (states.includes('connecting')) return ['pending', '连接中'];
        } else if (kind === 'forward') {
            const count = accounts.reduce((total, account) => total + (account.forwardEndpoints?.[endpoint.id] ??
                (endpoint.id === 'default' && !account.forwardEndpoints ? account.forwardConnections ?? 0 : 0)), 0);
            if (count) return ['connected', '已连接 ' + count + ' 路'];
        } else if (kind === 'http-post') {
            const states = accounts.map(account => account.httpPostEndpoints?.[endpoint.id] ??
                (endpoint.id === 'default' && !account.httpPostEndpoints ? account.httpPost : undefined));
            if (states.includes('failed')) return ['offline', '回调失败'];
            if (states.includes('delivered')) return ['connected', '回调已送达'];
            return ['pending', '等待事件'];
        }
        return ['pending', '已启用'];
    }

    function renderEndpoint() {
        const kind = active;
        const spec = endpointTypes[kind];
        const entries = spec ? endpoints(kind) : [];
        generalSave.disabled = !settings || saving;
        create.hidden = !settings || !spec;
        create.disabled = saving;
        for (const count of ui('tabs').querySelectorAll('[data-count]')) {
            count.textContent = settings ? String(endpoints(count.dataset.count).length) : '';
        }
        if (renderedKind !== kind) {
            nodes.replaceChildren();
            cards.clear();
            renderedKind = kind;
        }
        if (!spec) return;
        ui('endpoint-description').textContent = spec.description;
        ui('node-empty').hidden = !settings || entries.length > 0;
        const ids = new Set(entries.map(endpoint => endpoint.id));
        for (const [id, card] of cards) {
            if (ids.has(id)) continue;
            card.remove();
            cards.delete(id);
        }
        for (const endpoint of entries) {
            const { id } = endpoint;
            let card = cards.get(id);
            if (!card) {
                card = nodeTemplate.content.firstElementChild.cloneNode(true);
                cards.set(id, card);
                nodes.append(card);
            }
            const field = key => card.querySelector('[data-node="' + key + '"]');
            const title = endpoint[spec.name] || spec.title;
            field('node-title').textContent = title;
            field('node-address').textContent = spec.url ? endpoint[spec.url] : localAddress(kind, id);
            const [state, label] = statusFor(kind, endpoint);
            field('node-state').dataset.state = state;
            field('node-state').textContent = label;
            field('node-auth').textContent = kind === 'http-post'
                ? endpoint.hasHttpPostSecret ? '已设置签名密钥' : '未设置签名密钥'
                : hasToken(spec, endpoint) ? '已设置访问令牌' : '未设置访问令牌';
            const toggle = field('node-enabled');
            if (!saving) toggle.checked = Boolean(endpoint[spec.enabled]);
            toggle.disabled = saving;
            toggle.setAttribute('aria-label', '启用 ' + title);
            toggle.onchange = () => updateEnabled(kind, id, toggle.checked);
            field('edit').disabled = saving;
            field('edit').onclick = () => openEditor(id);
            field('delete').disabled = saving;
            field('delete').onclick = () => removeEndpoint(kind, endpoint);
        }
    }

    function selectTab(selected) {
        active = selected.id.slice(4);
        for (const tab of tabs) {
            tab.setAttribute('aria-selected', String(tab === selected));
            tab.tabIndex = tab === selected ? 0 : -1;
        }
        byId('panel-general').hidden = active !== 'general';
        const panel = byId('panel-endpoint');
        panel.hidden = active === 'general';
        if (active !== 'general') panel.setAttribute('aria-labelledby', selected.id);
        result.textContent = '';
        renderEndpoint();
    }

    for (const [index, tab] of tabs.entries()) {
        tab.onclick = () => selectTab(tab);
        tab.onkeydown = event => {
            const next = { ArrowLeft: (index + tabs.length - 1) % tabs.length,
                ArrowRight: (index + 1) % tabs.length, Home: 0, End: tabs.length - 1 }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            selectTab(tabs[next]);
            tabs[next].focus();
        };
    }

    async function persist(change) {
        settings = await api('/api/onebot/config', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(change),
        });
    }

    function resetTokenVisibility() {
        token.type = 'password';
        ui('token-reveal').setAttribute('aria-pressed', 'false');
        ui('token-reveal').textContent = '显示';
    }

    clearToken.onchange = () => {
        token.disabled = clearToken.checked;
        ui('token-generate').disabled = clearToken.checked;
        ui('token-reveal').disabled = clearToken.checked;
        ui('token-copy').disabled = clearToken.checked || !token.value || !navigator.clipboard;
        if (clearToken.checked) resetTokenVisibility();
    };
    token.oninput = clearToken.onchange;
    ui('token-copy').onclick = async () => {
        try {
            await navigator.clipboard.writeText(token.value);
            ui('token-state').textContent = '已复制当前令牌';
        } catch {
            ui('token-state').textContent = '无法复制，请显示令牌后手动复制';
        }
    };
    ui('token-generate').onclick = () => {
        token.value = Array.from(crypto.getRandomValues(new Uint8Array(24)), byte =>
            byte.toString(16).padStart(2, '0')).join('');
        token.oninput();
        token.focus();
    };
    ui('token-reveal').onclick = () => {
        const reveal = token.type === 'password';
        token.type = reveal ? 'text' : 'password';
        ui('token-reveal').setAttribute('aria-pressed', String(reveal));
        ui('token-reveal').textContent = reveal ? '隐藏' : '显示';
    };

    function renderGeneral() {
        generalFields.statusEnabled.checked = Boolean(settings.statusEnabled);
        generalFields.statusTrigger.value = settings.statusTrigger ?? '#mk';
        generalFields.statusCooldown.value = settings.statusCooldown ?? 5;
        generalFields.statusSwallow.checked = Boolean(settings.statusSwallow);
    }

    ui('general-form').onsubmit = async event => {
        event.preventDefault();
        if (!settings || saving) return;
        saving = true;
        renderEndpoint();
        try {
            await persist({
                statusEnabled: generalFields.statusEnabled.checked,
                statusTrigger: generalFields.statusTrigger.value,
                statusCooldown: generalFields.statusCooldown.valueAsNumber,
                statusSwallow: generalFields.statusSwallow.checked,
            });
            renderGeneral();
            result.textContent = '通用设置已保存';
        } catch (error) {
            result.textContent = error.message;
        } finally {
            saving = false;
            renderEndpoint();
        }
    };

    async function removeEndpoint(kind, endpoint) {
        const spec = endpointTypes[kind];
        if (!settings || saving) return;
        if (!window.confirm('删除「' + (endpoint[spec.name] || spec.title) + '」？该端点将停止服务并清除配置。')) return;
        saving = true;
        renderEndpoint();
        try {
            await persist({ endpoint: { kind, id: endpoint.id, remove: true } });
            result.textContent = '端点已删除';
        } catch (error) {
            result.textContent = error.message;
        } finally {
            saving = false;
            renderEndpoint();
            if (active === kind) (create.hidden ? cards.values().next().value?.querySelector('[data-node="edit"]') : create)?.focus();
        }
    }
    clearSecret.onchange = () => { secret.disabled = clearSecret.checked; };
    async function updateEnabled(kind, id, checked) {
        if (!settings || saving) return;
        const spec = endpointTypes[kind];
        saving = true;
        renderEndpoint();
        result.textContent = '正在更新端点…';
        try {
            const change = { [spec.enabled]: checked };
            await persist({ endpoint: { kind, id, change } });
            if (active === kind) result.textContent = checked ? '端点已启用' : '端点已停用';
        } catch (error) {
            result.textContent = error.message;
        } finally {
            saving = false;
            renderEndpoint();
        }
    }

    function openEditor(id) {
        if (!settings || saving || !endpointTypes[active]) return;
        editing = active;
        editingId = id;
        const endpoint = endpoints(editing).find(entry => entry.id === id);
        const spec = endpointTypes[editing];
        const outgoing = Boolean(spec.url);
        ui('editor-title').textContent = (endpoint ? '编辑 ' : '新建 ') + spec.title;
        ui('editor-description').textContent = spec.description;
        ui('editor-enabled').checked = Boolean(endpoint?.[spec.enabled]);
        ui('editor-name').value = endpoint?.[spec.name] ?? '';
        const reverse = editing === 'reverse';
        ui('editor-retry-field').hidden = !reverse;
        ui('editor-retry').disabled = !reverse;
        ui('editor-retry').value = endpoint?.reverseWsRetryMs ?? 0;
        ui('editor-behavior').hidden = !spec.format;
        ui('editor-format').value = endpoint?.[spec.format] ?? 'array';
        ui('editor-self').checked = Boolean(endpoint?.[spec.self]);
        ui('editor-role-field').hidden = !reverse;
        ui('editor-role').value = endpoint?.reverseWsRole ?? 'Universal';
        ui('editor-local').hidden = outgoing;
        ui('editor-target').hidden = !outgoing;
        ui('editor-local-address').textContent = outgoing ? '' : endpoint ? localAddress(editing, endpoint.id) : '保存后生成独立地址';
        editorUrl.value = endpoint?.[spec.url] ?? '';
        editorUrl.placeholder = spec.placeholder ?? '';
        editorUrl.disabled = !outgoing;
        editorUrl.required = outgoing;
        ui('editor-token').hidden = !spec.token;
        token.value = '';
        token.disabled = !spec.token;
        clearToken.checked = false;
        clearToken.onchange();
        resetTokenVisibility();
        ui('clear-label').hidden = !spec.token || !hasToken(spec, endpoint ?? {});
        ui('token-state').textContent = hasToken(spec, endpoint ?? {}) ? '已保存令牌，留空保留原值' : '未设置令牌';
        ui('editor-signature').hidden = editing !== 'http-post';
        secret.value = '';
        secret.disabled = editing !== 'http-post';
        clearSecret.checked = false;
        ui('clear-http-post-label').hidden = !endpoint?.hasHttpPostSecret;
        ui('http-post-secret-state').textContent = endpoint?.hasHttpPostSecret
            ? '已保存签名密钥，留空保留原值' : '未设置签名密钥';
        editorError.hidden = true;
        editor.showModal();
        (outgoing ? editorUrl : ui('editor-enabled')).focus();
    }

    create.onclick = () => openEditor();
    for (const key of ['editor-close', 'editor-cancel']) ui(key).onclick = () => { if (!saving) editor.close(); };
    editor.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    editor.addEventListener('close', () => {
        token.value = '';
        secret.value = '';
    });
    ui('editor-form').onsubmit = async event => {
        event.preventDefault();
        if (saving) return;
        const spec = endpointTypes[editing];
        const change = { [spec.enabled]: ui('editor-enabled').checked, [spec.name]: ui('editor-name').value };
        if (spec.format) Object.assign(change, {
            [spec.format]: ui('editor-format').value, [spec.self]: ui('editor-self').checked,
        });
        if (editing === 'reverse') Object.assign(change, {
            reverseWsRetryMs: ui('editor-retry').valueAsNumber, reverseWsRole: ui('editor-role').value,
        });
        if (spec.url) change[spec.url] = editorUrl.value;
        if (spec.token && (clearToken.checked || token.value)) {
            change[spec.token] = clearToken.checked ? '' : token.value;
        }
        if (editing === 'http-post') {
            change.clearHttpPostSecret = clearSecret.checked;
            if (secret.value && !clearSecret.checked) change.httpPostSecret = secret.value;
        }
        saving = true;
        editorSave.disabled = true;
        editorError.hidden = true;
        let saved = false;
        try {
            await persist({ endpoint: { kind: editing, id: editingId, change } });
            saved = true;
            result.textContent = '端点已保存';
        } catch (error) {
            editorError.textContent = error.message;
            editorError.hidden = false;
        } finally {
            saving = false;
            editorSave.disabled = false;
            renderEndpoint();
            if (saved) {
                editor.close();
                const card = cards.get(editingId);
                (card?.querySelector('[data-node="edit"]') ?? create).focus();
            }
        }
    };

    async function load() {
        if (settings || loading) return;
        loading = true;
        result.textContent = '正在读取配置…';
        try {
            settings = await api('/api/onebot/config');
            renderGeneral();
            result.textContent = '';
            renderEndpoint();
        } catch (error) {
            result.textContent = error.message;
        } finally {
            loading = false;
        }
    }

    function showAccounts(entries) {
        const key = JSON.stringify(entries);
        if (key === accountsKey) return;
        accountsKey = key;
        accounts = entries;
        renderEndpoint();
        const container = ui('accounts');
        const rows = accounts.map(account => {
            const row = document.createElement('div');
            row.className = 'endpoint-account';
            const avatar = createQqAvatar(account.selfId);
            const info = document.createElement('div');
            const name = document.createElement('strong');
            name.textContent = account.selfId;
            const state = document.createElement('small');
            const reverse = { connected: '反向已连接', connecting: '反向连接中' }[account.state];
            const callback = { pending: '等待回调', delivered: '回调已送达', failed: '回调失败' }[account.httpPost];
            state.textContent = [reverse, account.forwardConnections && `正向 ${account.forwardConnections} 路`, callback]
                .filter(Boolean).join(' · ') || '监听中';
            info.append(name, state);
            row.append(avatar, info);
            return row;
        });
        if (!rows.length) {
            const empty = document.createElement('p');
            empty.className = 'empty';
            empty.textContent = '暂无监听账号';
            rows.push(empty);
        }
        container.replaceChildren(...rows);
    }

    return { load, showAccounts };
}
