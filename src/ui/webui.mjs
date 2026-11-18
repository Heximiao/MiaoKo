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
    const { mode, groupId, userId, count } = form.elements;
    const selfId = byId('quick-actions-account');
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
        mode.disabled = userId.disabled = count.disabled = sending;
        send.disabled = sending || !selfId.value;
    }

    mode.onchange = updateForm;
    selfId.onchange = () => {
        preferredAccount = selfId.value;
        accountChosen = true;
        updateForm();
        onAccountChange();
    };
    form.onsubmit = async event => {
        event.preventDefault();
        if (send.disabled) return;
        const data = { selfId: selfId.value, userId: userId.value, count: count.valueAsNumber };
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
        updateForm();
        onAccountChange();
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

export function setupStickerSummary(api) {
    const form = byId('sticker-summary-form');
    const { enabled, summary, scope, targets, limit } = form.elements;
    const field = byId('sticker-summary-field');
    const targetField = byId('sticker-summary-targets');
    const targetLabel = byId('sticker-summary-target-label');
    const remaining = byId('sticker-summary-remaining');
    const reset = byId('sticker-summary-reset');
    const account = byId('quick-actions-account');
    const message = byId('sticker-summary-feedback');
    const save = form.querySelector('[type=submit]');
    const path = '/api/webui/sticker-summary';
    let saved;
    let loadedAccount;
    let loading;
    let busy = false;
    let refreshing = false;

    function updateFields() {
        field.hidden = !enabled.checked;
        enabled.disabled = save.disabled = reset.disabled = busy || !saved || loadedAccount !== account.value;
        summary.disabled = scope.disabled = limit.disabled = busy || !enabled.checked;
        targetField.hidden = scope.value === 'all';
        targetLabel.textContent = scope.value === 'private' ? '私聊 QQ 号' : '群号';
        targets.disabled = summary.disabled || targetField.hidden;
        targets.required = !targets.disabled && Boolean(summary.value.trim());
    }

    function show(settings) {
        saved = settings;
        enabled.checked = saved.enabled;
        summary.value = saved.summary;
        scope.value = saved.scope;
        targets.value = saved.targets.join(', ');
        limit.value = saved.limit ?? '';
        showRemaining(saved.remaining);
    }

    function showRemaining(count) {
        remaining.hidden = !saved?.enabled || !saved.summary || count === null;
        if (remaining.hidden) return;
        const label = count === 0 ? '次数已用完，当前使用 QQ 默认摘要。' : `剩余 ${count} 次。`;
        if (remaining.textContent !== label) remaining.textContent = label;
    }

    async function persist(data, label) {
        if (save.disabled) return;
        const selfId = loadedAccount;
        busy = true;
        updateFields();
        try {
            const result = await api(path, jsonPost({ ...data, selfId }));
            if (account.value === selfId) {
                loading = undefined;
                loadedAccount = selfId;
                show(result);
                feedback(message, label);
            }
        } catch (error) {
            if (account.value === selfId) feedback(message, error.message, true);
        } finally {
            busy = false;
            updateFields();
        }
    }

    enabled.onchange = scope.onchange = updateFields;
    summary.oninput = updateFields;
    form.onsubmit = event => {
        event.preventDefault();
        if (!saved) return;
        if (!enabled.checked) {
            void persist({ ...saved, enabled: false }, '已保存');
            return;
        }
        const selectedTargets = targets.value.split(/[\s,，]+/).filter(Boolean);
        void persist({ enabled: true, summary: summary.value, scope: scope.value,
            targets: scope.value === 'all' ? [] : selectedTargets, limit: limit.value ? limit.valueAsNumber : null }, '已保存');
    };
    reset.onclick = () => persist({ enabled: false, summary: '' }, '已恢复 QQ 默认摘要');

    return {
        async load() {
            const selfId = account.value;
            if (loadedAccount === selfId || loading?.selfId === selfId) return;
            loadedAccount = undefined;
            saved = undefined;
            enabled.checked = false;
            remaining.hidden = true;
            updateFields();
            feedback(message, selfId ? '' : '请先选择发送账号');
            loading = undefined;
            if (!selfId) return;
            const request = { selfId };
            loading = request;
            try {
                const data = await api(path + '?self_id=' + selfId);
                if (loading !== request || account.value !== selfId) return;
                loadedAccount = selfId;
                show(data);
            } catch (error) {
                if (loading === request) feedback(message, error.message, true);
            } finally {
                if (loading === request) {
                    loading = undefined;
                    updateFields();
                }
            }
        },
        async refreshRemaining() {
            const current = saved;
            const selfId = loadedAccount;
            if (busy || refreshing || selfId !== account.value || !current?.enabled || !current.summary ||
                current.limit === null) return;
            refreshing = true;
            try {
                const data = await api(path + '?self_id=' + selfId);
                if (saved === current && !busy) showRemaining(data.remaining);
            } catch {
                // Keep the last count until the next refresh.
            } finally {
                refreshing = false;
            }
        },
    };
}
