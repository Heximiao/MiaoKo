export function setupParticles(canvas) {
    const context = canvas.getContext('2d');
    if (!context) return () => {};
    const motion = matchMedia('(prefers-reduced-motion: reduce)');
    const range = 85;
    let width;
    let height;
    let points = [];
    let visible = false;
    let frame;
    let previous;

    function resize() {
        width = canvas.clientWidth;
        height = canvas.clientHeight;
        const scale = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        context.setTransform(scale, 0, 0, scale, 0, 0);
        const count = Math.max(18, Math.min(150, Math.round(width * height / 13500)));
        points = Array.from({ length: count }, () => {
            const angle = Math.random() * Math.PI * 2;
            const speed = 28 + Math.random() * 20;
            const radius = 2.6 + Math.random() * 1.5;
            return { x: radius + Math.random() * Math.max(0, width - 2 * radius),
                y: radius + Math.random() * Math.max(0, height - 2 * radius),
                vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed, radius };
        });
    }

    function draw(now) {
        const elapsed = previous === undefined ? 0 : Math.min((now - previous) / 1000, 0.05);
        previous = now;
        context.clearRect(0, 0, width, height);
        for (const point of points) {
            point.x += point.vx * elapsed;
            point.y += point.vy * elapsed;
            const { radius } = point;
            const right = Math.max(radius, width - radius);
            const bottom = Math.max(radius, height - radius);
            if (point.x <= radius) point.vx = Math.abs(point.vx);
            else if (point.x >= right) point.vx = -Math.abs(point.vx);
            if (point.y <= radius) point.vy = Math.abs(point.vy);
            else if (point.y >= bottom) point.vy = -Math.abs(point.vy);
            point.x = Math.max(radius, Math.min(right, point.x));
            point.y = Math.max(radius, Math.min(bottom, point.y));
        }
        context.lineWidth = 1;
        context.strokeStyle = '#5595dc';
        context.globalAlpha = 0.34;
        for (const [index, point] of points.entries()) {
            for (let next = index + 1; next < points.length; next++) {
                const other = points[next];
                const dx = point.x - other.x;
                const dy = point.y - other.y;
                const squared = dx * dx + dy * dy;
                if (squared >= range * range) continue;
                context.beginPath();
                context.moveTo(point.x, point.y);
                context.lineTo(other.x, other.y);
                context.stroke();
            }
        }
        context.globalAlpha = 0.48;
        context.fillStyle = '#5595dc';
        context.beginPath();
        for (const point of points) {
            context.moveTo(point.x + point.radius, point.y);
            context.arc(point.x, point.y, point.radius, 0, Math.PI * 2);
        }
        context.fill();
        frame = requestAnimationFrame(draw);
    }

    function update() {
        const enabled = visible && !motion.matches;
        canvas.hidden = !enabled;
        if (enabled && !document.hidden) {
            if (frame !== undefined) return;
            resize();
            frame = requestAnimationFrame(draw);
        } else {
            cancelAnimationFrame(frame);
            frame = undefined;
            previous = undefined;
        }
    }

    window.addEventListener('resize', () => { if (frame !== undefined) resize(); });
    motion.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return show => { visible = show; update(); };
}
