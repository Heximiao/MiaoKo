import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { WebUIError } from './webui-settings.mjs';

const deriveKey = promisify(scrypt);
const cookie = 'miaoko_session';
const setupCookie = 'miaoko_setup';
const sessionSeconds = 48 * 60 * 60;
const retryMs = 60_000;
const randomToken = () => randomBytes(24).toString('base64url');

function equal(a, b) {
    const first = Buffer.from(a);
    const second = Buffer.from(b);
    return first.length === second.length && timingSafeEqual(first, second);
}

function validatePassword(password) {
    if (typeof password !== 'string' || password.length < 8 || password.length > 256 ||
        !password.trim()) throw new WebUIError('管理密码须为 8–256 个字符');
}

function readCookie(request, name) {
    return request.headers.cookie?.split(';').map(part => part.trim())
        .find(part => part.startsWith(name + '='))?.slice(name.length + 1);
}

function setCookie(response, name, value, maxAge, secure) {
    response.appendHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Strict` +
        (secure ? '; Secure' : '') + (maxAge === undefined ? '' : `; Max-Age=${maxAge}`));
}

export function createWebUIAuth(settings, onRateLimit) {
    let code = settings.get().password ? undefined : randomToken();
    let setupGrant;
    const attempts = new Map();
    const remoteAttempts = Symbol('remote attempts');
    let busy = false;
    const sessions = new Map();

    function sessionId(request) {
        return readCookie(request, cookie);
    }

    const verified = (request, secure = false) => Boolean(setupGrant && setupGrant.secure === secure &&
        equal(readCookie(request, setupCookie) ?? '', setupGrant.id));

    function revoke(id) {
        const session = sessions.get(id);
        if (!session) return;
        sessions.delete(id);
        clearTimeout(session.timer);
        session.controller.abort();
    }

    function revokeAll() {
        for (const id of sessions.keys()) revoke(id);
    }

    function session(request, secure = false) {
        const current = sessions.get(sessionId(request));
        return current?.secure === secure ? current.controller.signal : undefined;
    }

    async function verify(input, expected, source, correctUsername) {
        const now = Date.now();
        for (const [key, bucket] of attempts) {
            if (bucket.until <= now) attempts.delete(key);
        }
        const local = source === '127.0.0.1';
        const sourceBucket = attempts.get(source);
        const remoteBucket = attempts.get(remoteAttempts);
        if ((sourceBucket?.count >= 5) || (!local && (remoteBucket?.count >= 30 ||
            (!sourceBucket && attempts.size >= 2048)))) {
            throw new WebUIError('尝试次数过多，请稍后重试', 429);
        }
        const validLength = typeof input === 'string' && input.length <= 256;
        let valid = false;
        if (validLength && expected) {
            if (expected === code) valid = equal(input, expected);
            else {
                const [salt, hash] = expected.split(':');
                valid = equal(await deriveKey(input, Buffer.from(salt, 'hex'), 64), Buffer.from(hash, 'hex'));
            }
        }
        if (!valid || !correctUsername) {
            for (const [key, limit] of [[source, 5], ...(!local ? [[remoteAttempts, 30]] : [])]) {
                const bucket = attempts.get(key) ?? { count: 0, until: now + retryMs };
                bucket.count++;
                attempts.set(key, bucket);
                if (bucket.count === limit) onRateLimit?.(key === remoteAttempts ? undefined : key);
            }
            throw new WebUIError('凭据错误，请检查后重试', 401);
        }
        attempts.delete(source);
    }

    async function authenticate(request, response, operation, { username, password, confirmPassword, currentPassword, setupCode },
        { source = '127.0.0.1', secure = false } = {}) {
        if (busy) throw new WebUIError('已有登录操作正在处理，请稍后重试', 429);
        busy = true;
        try {
            const stored = settings.get().password;
            if (operation === 'verify') {
                if (stored) throw new WebUIError('初始化已完成，请登录', 409);
                if (!code) throw new WebUIError('初始化码已使用。请在已验证的浏览器中继续，或重启 MiaoKo 获取新码', 409);
                await verify(setupCode, code, source, true);
                setupGrant = { id: randomToken(), secure };
                code = undefined;
                setCookie(response, setupCookie, setupGrant.id, undefined, secure);
                return;
            }
            if (operation === 'setup') {
                if (stored) throw new WebUIError('初始化已完成，请登录', 409);
                if (!verified(request, secure)) throw new WebUIError('请先验证一次性初始化码', 409);
                if (typeof username !== 'string' || username.length > 64 || !username.trim() ||
                    /[\u0000-\u001f\u007f]/.test(username)) throw new WebUIError('用户名须为 1–64 个字符');
                username = username.trim();
            }
            if (operation === 'login' && !stored) throw new WebUIError('请先初始化管理密码', 409);
            if (operation !== 'login') {
                validatePassword(password);
                if (password !== confirmPassword) throw new WebUIError('两次输入的密码不一致');
            }
            if (operation !== 'setup') await verify(operation === 'login' ? password : currentPassword, stored, source,
                operation !== 'login' || (typeof username === 'string' && username.trim() === (settings.get().username ?? 'admin')));
            if (operation === 'change' && !session(request, secure)) {
                throw new WebUIError('登录已失效，请重新登录', 401);
            }
            if (operation !== 'login') {
                const salt = randomBytes(16);
                const hash = await deriveKey(password, salt, 64);
                if (operation === 'change' && !session(request, secure)) {
                    throw new WebUIError('登录已失效，请重新登录', 401);
                }
                await settings.save({ password: salt.toString('hex') + ':' + hash.toString('hex'),
                    ...(operation === 'setup' && { username }) });
                code = undefined;
                setupGrant = undefined;
                revokeAll();
                if (operation === 'setup') setCookie(response, setupCookie, '', 0, secure);
            }
            if (operation === 'change') {
                setCookie(response, cookie, '', 0, secure);
                return;
            }
            revoke(sessionId(request));
            if (sessions.size >= 64) revoke(sessions.keys().next().value);
            const id = randomToken();
            const controller = new AbortController();
            const timer = setTimeout(() => revoke(id), sessionSeconds * 1000).unref();
            sessions.set(id, { controller, timer, secure });
            setCookie(response, cookie, id, sessionSeconds, secure);
        } finally {
            busy = false;
        }
    }

    return {
        code: () => code,
        setupRequired: () => !settings.get().password,
        verified,
        async reset() {
            await settings.save({ password: undefined });
            code = randomToken();
            setupGrant = undefined;
            revokeAll();
        },
        session,
        authenticate,
        logout(request, response, secure = false) {
            if (session(request, secure)) revoke(sessionId(request));
            setCookie(response, cookie, '', 0, secure);
        },
        close: revokeAll,
    };
}
