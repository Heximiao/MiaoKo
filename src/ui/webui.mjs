import { createQqAvatar } from './qq-avatar.mjs';

const byId = id => document.getElementById(id);

export function jsonPost(data = {}) {
    return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) };
}

function feedback(element, message = '', error = false) {
    element.textContent = message;
    element.dataset.error = String(error);
    element.hidden = !message;
}

function setupPasswordFields(form) {
    for (const button of form.querySelectorAll('[data-password-toggle]')) {
        const input = byId(button.getAttribute('aria-controls'));
        const fieldLabel = input.labels[0].textContent.trim();
        function show(visible) {
            input.type = visible ? 'text' : 'password';
            const action = visible ? '隐藏' : '显示';
            button.textContent = action;
            button.setAttribute('aria-label', action + fieldLabel);
            button.setAttribute('aria-pressed', String(visible));
        }
        show(false);
        button.onclick = () => show(input.type === 'password');
        form.addEventListener('reset', () => show(false));
    }

    const { password, confirmPassword } = form.elements;
    if (!confirmPassword) return;
    const status = byId(confirmPassword.getAttribute('aria-describedby'));
    function update(hasConfirmation) {
        const mismatch = hasConfirmation && password.value !== confirmPassword.value;
        const message = mismatch ? '两次输入的密码不一致' : hasConfirmation ? '两次输入的密码一致' : '';
        if (status.textContent !== message) status.textContent = message;
        status.toggleAttribute('data-mismatch', mismatch);
        if (mismatch) confirmPassword.setAttribute('aria-invalid', 'true');
        else confirmPassword.removeAttribute('aria-invalid');
        confirmPassword.setCustomValidity(mismatch ? message : '');
    }
    for (const input of [password, confirmPassword]) {
        input.addEventListener('input', () => update(confirmPassword.value !== ''));
        input.addEventListener('change', () => update(confirmPassword.value !== ''));
    }
    form.addEventListener('reset', () => update(false));
}

export async function enterWebUI(api, showParticles) {
    const view = byId('login-view');
    const forms = { verify: byId('verify-form'), setup: byId('setup-form'), login: byId('login-form') };
    setupPasswordFields(forms.login);
    setupPasswordFields(forms.setup);
    const error = byId('login-error');
    const help = byId('password-help');
    byId('forgot-password').onclick = () => help.showModal();

    function showStep(step) {
        const [title, description] = {
            verify: ['验证初始化码', '输入 MiaoKo 启动终端中显示的一次性初始化码。'],
            setup: ['设置管理员凭据', '设置用户名，并输入两遍 8–256 个字符的密码。'],
            login: ['登录控制台', '输入 MiaoKo 管理员用户名和密码。'],
        }[step];
        byId('login-title').textContent = title;
        byId('login-description').textContent = description;
        for (const [name, form] of Object.entries(forms)) form.hidden = name !== step;
        feedback(error);
        view.hidden = false;
        showParticles(true);
        forms[step].querySelector('input').focus();
    }

    async function checkStatus() {
        const status = await api('/api/auth/status');
        if (status.authenticated) return true;
        showStep(status.setupVerified ? 'setup' : status.setup ? 'verify' : 'login');
        return false;
    }

    try {
        if (await checkStatus()) return true;
    } catch {
        view.hidden = false;
        showParticles(true);
        feedback(error, '无法连接管理服务，请确认 MiaoKo 已启动后刷新页面。', true);
        return false;
    }

    return new Promise(resolve => {
        function enter() {
            view.hidden = true;
            resolve(true);
        }
        for (const [step, form] of Object.entries(forms)) {
            const button = form.querySelector('[type=submit]');
            form.onsubmit = async event => {
                event.preventDefault();
                button.disabled = true;
                feedback(error);
                try {
                    const data = Object.fromEntries(new FormData(form));
                    if (step === 'verify') data.setupCode = data.setupCode.trim();
                    if (step === 'setup') confirmPassword(data);
                    await api('/api/auth/' + step, jsonPost(data));
                    form.reset();
                    if (step === 'verify') showStep('setup');
                    else enter();
                } catch (failure) {
                    if (failure.status === 409 && await checkStatus().catch(() => false)) {
                        enter();
                    } else {
                        feedback(error, failure.message, true);
                    }
                } finally {
                    button.disabled = false;
                }
            };
        }
    });
}

function confirmPassword(data) {
    if (data.password !== data.confirmPassword) throw new Error('两次输入的密码不一致');
}

export function setupGeneralSettings(api) {
    const form = byId('webui-settings-form');
    const passwordForm = byId('webui-password-form');
    setupPasswordFields(passwordForm);
    const message = byId('webui-feedback');
    const save = form.querySelector('[type=submit]');
    const currentAddress = byId('webui-address');

    function show(settings) {
        form.elements.bindAddress.value = settings.savedBindAddress;
        form.elements.port.value = settings.savedPort;
        form.elements.logLevel.value = settings.logLevel;
        currentAddress.textContent = `${location.origin}/`;
        byId('webui-bind-status').textContent = `${settings.bindAddress}:${settings.port}`;
        const nextAddress = settings.bindOverride ? settings.bindAddress : settings.savedBindAddress;
        const nextPort = settings.portOverride ? settings.port : settings.savedPort;
        const restart = nextAddress !== settings.bindAddress || nextPort !== settings.port
            ? `下次启动将监听 ${nextAddress}:${nextPort}。`
            : '监听设置在重启 MiaoKo 后生效。';
        const media = settings.mediaShared ? ' 同一端口发布的媒体地址也需要调整。' : '';
        const overrides = [settings.bindOverride && '--bind', settings.portOverride && '--port'].filter(Boolean);
        const override = overrides.length
            ? ` 启动参数 ${overrides.join(' 和 ')} 会覆盖保存值。移除参数后将监听 ${settings.savedBindAddress}:${settings.savedPort}。`
            : '';
        const loopback = nextAddress === '0.0.0.0' || nextAddress === '127.0.0.1';
        const proxy = location.protocol === 'https:' && (nextPort !== settings.port || !loopback)
            ? ' HTTPS 反代的上游需要使用回环监听及对应端口。' : '';
        byId('webui-restart').textContent = restart + override + proxy + media;
    }

    byId('webui-copy-address').onclick = async () => {
        try {
            await navigator.clipboard.writeText(currentAddress.textContent);
            feedback(message, '地址已复制');
        } catch {
            feedback(message, '复制失败，请手动复制当前地址。', true);
        }
    };
    form.onsubmit = async event => {
        event.preventDefault();
        save.disabled = true;
        try {
            const data = { bindAddress: form.elements.bindAddress.value.trim(), port: form.elements.port.valueAsNumber,
                logLevel: form.elements.logLevel.value };
            show(await api('/api/webui/settings', jsonPost(data)));
            feedback(message, '已保存');
        } catch (error) {
            feedback(message, error.message, true);
        } finally {
            save.disabled = false;
        }
    };
    passwordForm.onsubmit = async event => {
        event.preventDefault();
        const submit = event.submitter;
        submit.disabled = true;
        try {
            const data = Object.fromEntries(new FormData(passwordForm));
            confirmPassword(data);
            await api('/api/auth/password', jsonPost(data));
            passwordForm.reset();
            location.reload();
        } catch (error) {
            feedback(byId('webui-password-feedback'), error.message, true);
        } finally {
            submit.disabled = false;
        }
    };

    return async () => {
        save.disabled = true;
        feedback(message);
        try {
            show(await api('/api/webui/settings'));
            save.disabled = false;
        } catch (error) {
            feedback(message, error.message, true);
        }
    };
}

export function setupQuickPoke(api, onAccountChange) {
    const form = byId('quick-poke-form');
    const { mode, groupId, userId, count, interval } = form.elements;
    const selfId = byId('quick-actions-account');
    const accountAvatar = byId('quick-actions-account-avatar');
    const send = form.querySelector('[type=submit]');
    const message = byId('quick-poke-feedback');
    let accountsKey;
    let preferredAccount = '';
    let accountChosen = false;
    let sending = false;

    function updateForm() {
        const group = mode.value === 'group';
        byId('quick-poke-group').hidden = !group;
        groupId.disabled = !group || sending;
        selfId.disabled = selfId.options.length < 2;
        mode.disabled = userId.disabled = count.disabled = interval.disabled = sending;
        send.disabled = sending || !selfId.value;
    }

    mode.onchange = updateForm;
    function accountChanged() {
        accountAvatar.replaceChildren(...(selfId.value ? [createQqAvatar(selfId.value)] : []));
        accountAvatar.hidden = !selfId.value;
        updateForm();
        onAccountChange();
    }

    selfId.onchange = () => {
        preferredAccount = selfId.value;
        accountChosen = true;
        accountChanged();
    };
    form.onsubmit = async event => {
        event.preventDefault();
        if (send.disabled) return;
        const data = { selfId: selfId.value, userId: userId.value, count: count.valueAsNumber,
            intervalMs: Math.round(interval.valueAsNumber * 1000) };
        if (mode.value === 'group') data.groupId = groupId.value;
        sending = true;
        updateForm();
        feedback(message, `正在发送 ${data.count} 次戳一戳…`);
        try {
            const { sent, error } = await api('/api/webui/quick-poke', jsonPost(data));
            feedback(message, error ? `已确认 ${sent}/${data.count} 次。 ${error}` : `已发送 ${sent} 次戳一戳`, Boolean(error));
        } catch (error) {
            feedback(message, error.message, true);
        } finally {
            sending = false;
            updateForm();
        }
    };

    function selectPreferred() {
        selfId.value = [...selfId.options].some(option => option.value === preferredAccount) ? preferredAccount : '';
        accountChanged();
    }

    return {
        showAccounts(sessions) {
            const accounts = [...new Set(sessions.filter(session => session.canPoke).map(session => session.selfId))];
            const key = accounts.join(',');
            if (key === accountsKey) return;
            accountsKey = key;
            selfId.replaceChildren(
                new Option(accounts.length ? '请选择发送账号' : '请先在「QQ 实例」开始监听', ''),
                ...accounts.map(account => new Option('QQ ' + account, account)),
            );
            if (!accountChosen && !preferredAccount && accounts.length === 1) preferredAccount = accounts[0];
            selectPreferred();
        },
    };
}

function conversationRow(target, action, handle) {
    const name = target.name || target.id;
    const kind = target.kind === 'group' ? '群聊' : '私聊';
    const info = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = name;
    const detail = document.createElement('small');
    detail.textContent = kind + ' · ' + target.id;
    info.append(title, detail);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'sticker-conversation-row';
    button.append(createQqAvatar(target.id, target.kind), info, document.createTextNode(action));
    button.setAttribute('aria-label', action + ' ' + kind + ' ' + name);
    button.onclick = handle;
    return button;
}

function matchingConversations(directory, query) {
    if (!query) return [];
    const matches = directory.filter(entry => [entry.id, entry.name, entry.nickname].some(value =>
        typeof value === 'string' && value.toLocaleLowerCase().includes(query)));
    return matches.sort((a, b) => Number(b.id === query) - Number(a.id === query));
}

function conversationResults(results, entries, action, choose) {
    results.replaceChildren(...entries.slice(0, 10).map(entry => {
        const item = document.createElement('li');
        item.append(conversationRow(entry, action, () => choose(entry)));
        return item;
    }));
    results.hidden = entries.length === 0;
}

export function setupQuickForward(api) {
    const form = byId('quick-forward-form');
    const account = byId('quick-actions-account');
    const fields = byId('quick-forward-fields');
    const nodes = byId('quick-forward-nodes');
    const template = byId('quick-forward-node');
    const add = byId('quick-forward-add');
    const search = form.elements.conversation;
    const results = byId('quick-forward-results');
    const searchStatus = byId('quick-forward-search-status');
    const selected = byId('quick-forward-target');
    const message = byId('quick-forward-feedback');
    const send = form.querySelector('[type=submit]');
    const imageLimit = 5 * 1024 * 1024;
    let target;
    let directory = { selfId: '', entries: [] };
    let sending = false;

    function update() {
        fields.disabled = sending || !account.value;
        send.disabled = fields.disabled || !target;
        add.disabled = nodes.children.length >= 50;
        for (const [index, node] of Array.from(nodes.children).entries()) {
            const label = `节点 ${index + 1}`;
            node.querySelector('legend').textContent = label;
            const remove = node.querySelector('.quick-forward-remove');
            remove.disabled = nodes.children.length === 1;
            remove.setAttribute('aria-label', '移除' + label);
        }
    }

    function renderSearch() {
        const query = search.value.trim().toLocaleLowerCase();
        const matches = matchingConversations(directory.entries, query);
        if (!directory.loading && /^[1-9]\d{4,11}$/.test(query) && !matches.some(entry => entry.id === query)) {
            matches.unshift({ kind: 'group', id: query }, { kind: 'private', id: query });
        }
        conversationResults(results, matches, '选择', entry => {
            search.value = '';
            setTarget(entry);
        });
        const status = directory.loading ? '正在读取 QQ 会话…' : directory.error ||
            (query && !matches.length ? '没有找到会话。' : '');
        searchStatus.textContent = status;
        searchStatus.hidden = !status;
    }

    function renderAvatar(node) {
        const input = node.querySelector('[name=avatar]');
        const preview = node.querySelector('.quick-forward-avatar');
        const choices = node.querySelector('.quick-forward-avatar-results');
        const query = input.value.trim();
        const isQqNumber = /^[1-9]\d{4,11}$/.test(query);
        const avatarId = isQqNumber ? query : query ? '' : directory.selfId;
        if (preview.dataset.qq !== avatarId) {
            preview.dataset.qq = avatarId;
            preview.replaceChildren(createQqAvatar(avatarId));
        }
        const matches = isQqNumber || query.includes('://') ? [] :
            matchingConversations(directory.entries, query.toLocaleLowerCase()).filter(entry => entry.kind === 'private');
        conversationResults(choices, matches, '使用头像', entry => {
            input.value = entry.id;
            input.focus();
            renderAvatar(node);
        });
    }

    function setTarget(entry) {
        target = entry;
        selected.replaceChildren(...(target ? [conversationRow(target, '更换', () => {
            setTarget(undefined);
            search.focus();
        })] : []));
        update();
        renderSearch();
    }

    async function loadDirectory() {
        const current = directory;
        if (!current.selfId || current.loading || Date.now() < (current.expires ?? 0)) return;
        current.loading = true;
        renderSearch();
        try {
            const { conversations, incomplete } = await api('/api/webui/conversations?self_id=' + current.selfId);
            current.entries = conversations;
            current.error = incomplete ? '部分 QQ 会话暂时无法读取，也可以直接输入号码。' : '';
            current.expires = Date.now() + (incomplete ? 5000 : 60000);
        } catch (error) {
            current.error = error.message + '，也可以直接输入号码。';
            current.expires = Date.now() + 5000;
        } finally {
            current.loading = false;
            if (current === directory) {
                renderSearch();
                for (const node of nodes.children) renderAvatar(node);
            }
        }
    }

    search.onfocus = () => void loadDirectory();
    search.oninput = () => {
        setTarget(undefined);
        void loadDirectory();
    };

    function addNode(focus = false) {
        const node = template.content.firstElementChild.cloneNode(true);
        node.querySelector('.quick-forward-remove').onclick = () => {
            node.remove();
            update();
            add.focus();
        };
        const avatar = node.querySelector('[name=avatar]');
        avatar.onfocus = () => void loadDirectory();
        avatar.oninput = () => {
            renderAvatar(node);
            void loadDirectory();
        };
        nodes.append(node);
        renderAvatar(node);
        update();
        if (focus) node.querySelector('[name=nickname]').focus();
    }

    add.onclick = () => addNode(true);
    form.onsubmit = async event => {
        event.preventDefault();
        if (send.disabled) return;
        const selfId = account.value;
        const destination = target;
        const draft = Array.from(nodes.children, node => ({
            nickname: node.querySelector('[name=nickname]').value.trim(),
            avatar: node.querySelector('[name=avatar]').value.trim(),
            content: node.querySelector('[name=content]').value,
            files: Array.from(node.querySelector('[name=images]').files),
        }));
        const files = draft.flatMap(node => node.files);
        if (draft.some(node => node.files.length > 4)) {
            feedback(message, '每个节点最多添加 4 张图片。', true);
            return;
        }
        if (files.some(file => !file.size || file.size > imageLimit) ||
            files.reduce((total, file) => total + file.size, 0) > imageLimit * 2) {
            feedback(message, '单张图片最多 5 MiB，整条转发的图片合计最多 10 MiB。', true);
            return;
        }
        sending = true;
        update();
        feedback(message, '正在发送合并转发…');
        try {
            const packed = await Promise.all(draft.map(async ({ files, ...node }) => ({
                ...node,
                images: await Promise.all(files.map(file => new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(reader.result.split(',')[1]);
                    reader.onerror = () => reject(new Error('无法读取图片 ' + file.name));
                    reader.readAsDataURL(file);
                }))),
            })));
            const { messageId } = await api('/api/webui/quick-forward',
                jsonPost({ selfId, target: { id: destination.id, kind: destination.kind }, nodes: packed }));
            feedback(message, `已发到${destination.kind === 'group' ? '群聊' : '私聊'} ${destination.name || destination.id}，共 ${packed.length} 个节点，消息 ID ${messageId}`);
        } catch (error) {
            feedback(message, error.message, true);
        } finally {
            sending = false;
            update();
        }
    };
    addNode();
    return () => {
        if (directory.selfId !== account.value) {
            directory = { selfId: account.value, entries: [] };
            search.value = '';
            setTarget(undefined);
            for (const node of nodes.children) renderAvatar(node);
        } else {
            update();
        }
    };
}

export function setupStickerSummary(api) {
    const form = byId('sticker-summary-form');
    const { summary, quickMode, scope, limit, conversation } = form.elements;
    const account = byId('quick-actions-account');
    const picker = byId('sticker-summary-targets');
    const selected = byId('sticker-summary-selected');
    const results = byId('sticker-summary-results');
    const searchStatus = byId('sticker-summary-search-status');
    const limitField = byId('sticker-summary-limit');
    const remaining = byId('sticker-summary-remaining');
    const reset = byId('sticker-summary-reset');
    const retry = byId('sticker-summary-retry');
    const message = byId('sticker-summary-feedback');
    const path = '/api/webui/sticker-summary';
    const states = new Map();
    const targetKey = target => target.kind + ':' + target.id;
    const draft = state => ({ ...state.settings, ...state.inFlight, ...state.pending });
    let current;

    function setStatus(state, label, error = false) {
        state.status = { label, error };
        if (state !== current) return;
        feedback(message, label, error);
        retry.hidden = !error || !state.pending;
    }

    function renderPicker(state) {
        if (!state?.settings || picker.hidden) return;
        const { targets } = draft(state);
        const directory = state.directory;
        const keys = new Set(targets.map(targetKey));
        selected.replaceChildren(...targets.map(target => {
            const entry = directory?.get(targetKey(target)) ?? target;
            return conversationRow(entry, '移除', () => {
                schedule({ targets: draft(state).targets.filter(item => targetKey(item) !== targetKey(target)) }, true);
            });
        }));

        const query = conversation.value.trim().toLocaleLowerCase();
        const matches = matchingConversations([...(directory?.values() ?? [])], query)
            .filter(entry => !keys.has(targetKey(entry)));
        conversationResults(results, matches, '添加', ({ id, kind }) => {
            conversation.value = '';
            schedule({ targets: [...draft(state).targets, { id, kind }] }, true);
            conversation.focus();
        });
        let label = '';
        if (state.directoryLoading) label = '正在读取 QQ 好友和群聊…';
        else if (state.directoryError) label = state.directoryError;
        else if (query && !matches.length) label = '没有找到可添加的会话。';
        else if (!targets.length && !query) label = '添加至少一个会话以应用摘要。';
        searchStatus.textContent = label;
        searchStatus.hidden = !label;
    }

    async function loadDirectory(state) {
        if (!state || state.directoryLoading || Date.now() < (state.directoryExpires ?? 0)) return;
        state.directoryLoading = true;
        state.directoryError = '';
        renderPicker(state);
        try {
            const { conversations, incomplete } = await api('/api/webui/conversations?self_id=' + state.selfId);
            state.directory = new Map(conversations.map(entry => [targetKey(entry), entry]));
            state.directoryExpires = Date.now() + (incomplete ? 5000 : 60000);
            if (incomplete) state.directoryError = '部分 QQ 会话暂时无法读取。';
        } catch (error) {
            state.directoryError = error.message;
        } finally {
            state.directoryLoading = false;
            if (state === current) renderPicker(state);
        }
    }

    function render() {
        const state = current;
        const settings = state?.settings ? draft(state) : null;
        summary.disabled = quickMode.disabled = scope.disabled = reset.disabled = !settings;
        if (summary.value.trim() !== (settings?.summary ?? '').trim()) summary.value = settings?.summary ?? '';
        quickMode.checked = Boolean(settings?.quickMode);
        scope.value = settings?.scope ?? 'all';
        limit.value = settings?.limit ?? '';
        limitField.hidden = quickMode.checked;
        limit.disabled = !settings || quickMode.checked;
        picker.hidden = scope.value !== 'selected';
        conversation.disabled = !settings || picker.hidden;
        renderRemaining(settings);
        renderPicker(state);
    }

    function renderRemaining(settings) {
        remaining.hidden = !settings?.summary || settings.quickMode || settings.remaining === null;
        if (!remaining.hidden) remaining.textContent = settings.remaining === 0
            ? '次数已用完，当前使用 QQ 默认摘要。' : '剩余 ' + settings.remaining + ' 次。';
    }

    async function persist(state) {
        if (!state || state.inFlight || !state.pending) return;
        clearTimeout(state.timer);
        const patch = state.pending;
        if (patch.summary !== undefined && new TextEncoder().encode(patch.summary).length > 160) {
            setStatus(state, '摘要长度不能超过 160 个 UTF-8 字节。', true);
            if (state === current) retry.hidden = true;
            return;
        }
        state.pending = null;
        state.inFlight = patch;
        setStatus(state, '正在保存…');
        try {
            state.settings = await api(path, jsonPost({ ...patch, selfId: state.selfId }));
        } catch (error) {
            state.pending = { ...patch, ...state.pending };
            setStatus(state, error.message, true);
            return;
        } finally {
            state.inFlight = null;
        }
        if (state === current) render();
        if (state.pending) void persist(state);
        else setStatus(state, '已自动保存');
    }

    function schedule(patch, immediate = false) {
        const state = current;
        if (!state?.settings || state.selfId !== account.value) return;
        state.pending = { ...state.pending, ...patch };
        state.version++;
        clearTimeout(state.timer);
        setStatus(state, '待保存…');
        if (!Object.hasOwn(patch, 'summary') && !Object.hasOwn(patch, 'limit')) render();
        if (immediate) void persist(state);
        else state.timer = setTimeout(() => void persist(state), 250);
    }

    form.onsubmit = event => {
        event.preventDefault();
        void persist(current);
    };
    summary.oninput = () => schedule({ summary: summary.value });
    summary.onchange = () => void persist(current);
    quickMode.onchange = () => schedule({ quickMode: quickMode.checked }, true);
    scope.onchange = () => {
        schedule({ scope: scope.value }, true);
        if (scope.value === 'selected') void loadDirectory(current);
    };
    limit.oninput = () => {
        if (limit.validity.valid) schedule({ limit: limit.value ? limit.valueAsNumber : null });
    };
    limit.onchange = () => void persist(current);
    conversation.oninput = () => renderPicker(current);
    conversation.onfocus = () => void loadDirectory(current);
    retry.onclick = () => void persist(current);
    reset.onclick = () => {
        schedule({ summary: '', quickMode: false, scope: 'all', targets: [], limit: null }, true);
        render();
    };

    return {
        async load() {
            const selfId = account.value;
            if (current?.selfId !== selfId) {
                void persist(current);
                if (selfId && !states.has(selfId)) states.set(selfId, { selfId, version: 0 });
                current = states.get(selfId);
                conversation.value = '';
                summary.value = '';
                render();
                feedback(message, selfId ? '' : '请先选择发送账号');
                retry.hidden = true;
            }
            const state = current;
            if (!state || state.loading) return;
            if (!state.settings) {
                state.loading = true;
                try {
                    state.settings = await api(path + '?self_id=' + selfId);
                } catch (error) {
                    setStatus(state, error.message, true);
                    return;
                } finally {
                    state.loading = false;
                }
            }
            if (state !== current) return;
            render();
            if (state.status) setStatus(state, state.status.label, state.status.error);
            if (scope.value === 'selected') void loadDirectory(state);
        },
        async refreshRemaining() {
            const state = current;
            if (!state?.settings?.summary || state.selfId !== account.value || state.pending || state.inFlight ||
                state.refreshing || (!state.settings.quickMode && state.settings.limit === null)) return;
            state.refreshing = true;
            const version = state.version;
            try {
                const data = await api(path + '?self_id=' + state.selfId);
                if (state.version !== version) return;
                const cleared = state.settings.quickMode && data.quickMode && !data.summary;
                state.settings = data;
                if (state === current) {
                    if (cleared) {
                        summary.value = '';
                        setStatus(state, '快速模式已用完，摘要已清空');
                    }
                    renderRemaining(data);
                }
            } catch {
                // Keep the last count until the next refresh.
            } finally {
                state.refreshing = false;
            }
        },
    };
}
