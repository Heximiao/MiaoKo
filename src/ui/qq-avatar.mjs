export function createQqAvatar(selfId, kind = 'private') {
    const avatar = document.createElement('span');
    avatar.className = 'instance-avatar';
    avatar.textContent = kind === 'group' ? '群' : 'QQ';
    avatar.setAttribute('aria-hidden', 'true');
    if (/^[1-9]\d{4,11}$/.test(selfId)) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = kind === 'group' ? `https://p.qlogo.cn/gh/${selfId}/${selfId}/100/`
            : `https://q4.qlogo.cn/headimg_dl?dst_uin=${selfId}&spec=100`;
        avatar.append(image);
    }
    return avatar;
}
