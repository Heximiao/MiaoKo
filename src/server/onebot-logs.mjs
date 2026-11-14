const LIMIT = 1000;

export function writeTerminal(level, module, message) {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
    const output = level === 'ERROR' || level === 'WARN' ? process.stderr : process.stdout;
    const line = message.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    output.write(`${time} ${level.padEnd(5)} [${module}] ${line}\n`);
}

export function createOneBotLogs(onEntry) {
    const entries = [];
    const clients = new Set();
    let sequence = 0;

    function broadcast(event, data) {
        const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        for (const response of clients) {
            if (response.writableLength > 1024 * 1024) response.destroy();
            else response.write(frame);
        }
    }

    return {
        add(level, module, message) {
            const entry = { id: ++sequence, time: Date.now(), level, module,
                message: message.replace(/[\r\n\t]+/g, ' ').slice(0, 800) };
            entries.push(entry);
            if (entries.length > LIMIT) entries.shift();
            broadcast('entry', entry);
            onEntry?.(entry);
        },
        stream(response, signal) {
            response.writeHead(200, {
                'Content-Type': 'text/event-stream; charset=utf-8',
                'Cache-Control': 'no-store',
                'X-Content-Type-Options': 'nosniff',
            });
            const remove = () => {
                clients.delete(response);
                signal?.removeEventListener('abort', end);
            };
            const end = () => {
                remove();
                response.end();
            };
            signal?.addEventListener('abort', end, { once: true });
            response.on('close', remove);
            clients.add(response);
            response.write(`event: snapshot\ndata: ${JSON.stringify({ limit: LIMIT, entries })}\n\n`);
        },
        clear() {
            entries.length = 0;
            broadcast('snapshot', { limit: LIMIT, entries });
        },
        close() {
            for (const response of clients) response.end();
            clients.clear();
        },
    };
}

export function describeOneBotEvent(event, record) {
    const actor = event.user_id ?? '';
    if (event.post_type === 'request') {
        const request = event.request_type === 'friend' ? '好友申请'
            : event.sub_type === 'invite' ? '入群邀请' : '入群申请';
        return `${actor} · ${request}${event.group_id ? ' · 群 ' + event.group_id : ''}`;
    }
    if (event.post_type === 'notice') {
        const conversation = event.group_id ? `群 ${event.group_id} · ` : '私聊 · ';
        if (event.sub_type === 'poke') return `${conversation}${event.sender_id ?? actor} 戳了戳 ${event.target_id}`;
        if (event.sub_type === 'poke_recall') return `${conversation}${actor} 撤回了对 ${event.target_id} 的戳一戳`;
        if (event.notice_type === 'group_increase') return `${conversation}${actor} 加入群聊`;
        if (event.notice_type === 'group_decrease') return `${conversation}${actor} 离开群聊`;
        if (event.notice_type === 'group_ban') return `${conversation}${actor || '全群'} · ${event.duration
            ? '禁言 ' + event.duration + ' 秒' : '解除禁言'}`;
        if (event.notice_type === 'group_msg_emoji_like') {
            const action = event.is_add ? '贴表情' : '取消贴表情';
            const user = actor === event.self_id ? `自己（${actor}）` : actor;
            return `${conversation}${user} · ${action} #${event.message_id} · 表情 ${event.likes[0].emoji_id}`;
        }
        const operator = event.operator_id ? `（操作者 ${event.operator_id}）` : '';
        return `${conversation}撤回消息 #${event.message_id} · ${actor}${operator}`;
    }
    const label = (name, id) => name && name !== String(id) ? `${name} (${id})` : String(id);
    const conversation = event.group_id ? '群 ' + label(record.peerName, event.group_id) : '私聊';
    const segmentText = { image: '[图片]', reply: '[引用]', face: '[表情]', json: '[卡片]', forward: '[合并转发]',
        dice: '[骰子]', rps: '[包剪锤]', record: '[语音]', video: '[视频]', file: '[文件]' };
    const preview = event.message.map(({ type, data }) => {
        if (type === 'text') return data.text;
        if (type === 'at') return '@' + data.qq;
        return segmentText[type] ?? `[${type}]`;
    }).join('').replace(/\s+/g, ' ').trim();
    return `${conversation} · ${label(record.nickname, actor)} · #${event.message_id} ${preview}`.trim();
}
