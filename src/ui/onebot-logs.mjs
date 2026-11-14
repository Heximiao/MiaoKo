const timeFormat = new Intl.DateTimeFormat('zh-CN', { timeStyle: 'medium', hourCycle: 'h23' });
const FOLLOW_DISTANCE = 64;

export function setupOneBotLogs(onEntries) {
    const element = name => document.getElementById('logs-' + name);
    const [status, count, search, follow, wrap, download, clear, error, scroll, rows, empty] =
        ['status', 'count', 'search', 'follow', 'wrap', 'export', 'clear', 'error', 'scroll', 'rows', 'empty'].map(element);
    const levelButtons = [...element('levels').querySelectorAll('button')];
    const levels = new Set(levelButtons.map(button => button.dataset.level));
    let entries = [];
    let limit = 1000;
    let stream;
    let connected = false;
    let clearing = false;
    let query = '';

    function matches(entry) {
        return levels.has(entry.level) && (!query ||
            `${entry.level} ${entry.module} ${entry.message}`.toLowerCase().includes(query));
    }

    function makeRow(entry) {
        const row = document.createElement('tr');
        row.dataset.id = entry.id;
        row.dataset.level = entry.level;
        const values = [timeFormat.format(entry.time), entry.level, entry.module, entry.message];
        for (const [index, text] of values.entries()) {
            const cell = document.createElement('td');
            const content = document.createElement('span');
            content.className = ['log-time', 'log-level', 'log-module', 'log-message'][index];
            content.textContent = text;
            if (index === 3) content.title = text;
            cell.append(content);
            row.append(cell);
        }
        return row;
    }

    function shouldFollow() {
        return follow.getAttribute('aria-pressed') === 'true' &&
            scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop <= FOLLOW_DISTANCE;
    }

    function updateSummary() {
        const visible = rows.childElementCount;
        count.textContent = `${entries.length} / ${limit} 条${visible === entries.length ? '' : ` · 显示 ${visible} 条`}`;
        empty.hidden = visible > 0;
        empty.textContent = entries.length ? '没有符合筛选条件的日志' : '暂无日志';
        download.disabled = visible === 0;
        clear.disabled = clearing || !connected || entries.length === 0;
    }

    function render() {
        const followLatest = shouldFollow();
        rows.replaceChildren(...entries.filter(matches).map(makeRow));
        updateSummary();
        if (followLatest) scroll.scrollTop = scroll.scrollHeight;
    }

    function updateConnection(state, label) {
        connected = state === 'connected';
        status.dataset.state = state;
        status.textContent = label;
        updateSummary();
    }

    search.addEventListener('input', () => {
        query = search.value.trim().toLowerCase();
        render();
    });
    for (const button of levelButtons) {
        button.addEventListener('click', () => {
            const level = button.dataset.level;
            if (levels.has(level)) levels.delete(level);
            else levels.add(level);
            button.setAttribute('aria-pressed', String(levels.has(level)));
            render();
        });
    }
    follow.addEventListener('click', () => {
        follow.setAttribute('aria-pressed', String(follow.getAttribute('aria-pressed') !== 'true'));
    });
    wrap.addEventListener('click', () => {
        const followLatest = shouldFollow();
        const enabled = wrap.getAttribute('aria-pressed') !== 'true';
        wrap.setAttribute('aria-pressed', String(enabled));
        scroll.classList.toggle('no-wrap', !enabled);
        if (followLatest) scroll.scrollTop = scroll.scrollHeight;
    });
    download.addEventListener('click', () => {
        const lines = entries.filter(matches).map(entry =>
            `${new Date(entry.time).toISOString()} ${entry.level} [${entry.module}] ${entry.message}`);
        const url = URL.createObjectURL(new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'miaoko-onebot.log';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    clear.addEventListener('click', async () => {
        clearing = true;
        error.hidden = true;
        updateSummary();
        try {
            const response = await fetch('/api/onebot/logs', { method: 'POST' });
            if (!response.ok) throw new Error('无法清空日志，请稍后重试。');
        } catch {
            error.textContent = '无法清空日志，请稍后重试。';
            error.hidden = false;
        } finally {
            clearing = false;
            updateSummary();
        }
    });

    return visible => {
        if (!visible) {
            stream?.close();
            stream = undefined;
            return;
        }
        if (stream) return;
        updateConnection('pending', '正在连接');
        stream = new EventSource('/api/onebot/logs');
        stream.addEventListener('open', () => updateConnection('connected', '实时'));
        stream.addEventListener('error', () => updateConnection('offline', '正在重连'));
        stream.addEventListener('snapshot', event => {
            ({ limit, entries } = JSON.parse(event.data));
            onEntries(entries);
            render();
        });
        stream.addEventListener('entry', event => {
            const followLatest = shouldFollow();
            const entry = JSON.parse(event.data);
            entries.push(entry);
            let removed;
            if (entries.length > limit) {
                removed = entries.shift();
                if (rows.firstElementChild?.dataset.id === String(removed.id)) rows.firstElementChild.remove();
            }
            if (entry.level === 'WARN' || entry.level === 'ERROR' ||
                removed?.level === 'WARN' || removed?.level === 'ERROR') onEntries(entries);
            if (matches(entry)) rows.append(makeRow(entry));
            updateSummary();
            if (followLatest) scroll.scrollTop = scroll.scrollHeight;
        });
    };
}
