export function getLoginInfo(_params, account) {
    return { user_id: Number(account), nickname: account };
}

export function getStatus() {
    return { online: true, good: true };
}

export function getVersionInfo() {
    return { app_name: 'MiaoKo', app_version: '0.1.1', protocol_version: 'v11' };
}
