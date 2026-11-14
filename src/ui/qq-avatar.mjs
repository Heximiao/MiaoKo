export function createQqAvatar(selfId) {
    const avatar = document.createElement('span');
    avatar.className = 'instance-avatar';
    avatar.textContent = 'QQ';
    avatar.setAttribute('aria-hidden', 'true');
    if (/^[1-9]\d{4,11}$/.test(selfId)) {
        const image = document.createElement('img');
        image.alt = '';
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = `https://q4.qlogo.cn/headimg_dl?dst_uin=${selfId}&spec=100`;
        avatar.append(image);
    }
    return avatar;
}
