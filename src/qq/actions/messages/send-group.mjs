import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { openMessagePipe } from '../../../ipc/pipe.mjs';

const python = fileURLToPath(new URL('../../../../.conda/python.exe', import.meta.url));
const script = fileURLToPath(new URL('./send_group.py', import.meta.url));

export async function sendGroupText({ group, text, pid, bubbleFrom }) {
    if (!/^[1-9]\d{4,11}$/.test(group ?? '') || typeof text !== 'string' || !text.trim() ||
        Buffer.byteLength(text) > 1024 || text.includes('\0') ||
        (pid !== undefined && (!/^[1-9]\d{0,9}$/.test(pid) || Number(pid) > 0xffffffff)) ||
        (bubbleFrom !== undefined && (typeof bubbleFrom !== 'string' || !/^[1-9]\d{0,19}$/.test(bubbleFrom)))) {
        throw new TypeError('Expected a group number, text, and optional PID and bubble message ID');
    }

    const pipe = await openMessagePipe(() => {}, error => console.error(error.message));
    try {
        const args = [script, '--group', String(group), '--pipe', pipe.path];
        if (pid !== undefined) args.push('--pid', String(pid));
        if (bubbleFrom !== undefined) args.push('--bubble-from', String(bubbleFrom));
        const child = spawn(python, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            windowsHide: true,
        });
        let output = '';
        let errors = '';
        child.stdout.setEncoding('utf8').on('data', data => { output += data; });
        child.stderr.setEncoding('utf8').on('data', data => { errors += data; });
        child.stdin.on('error', () => {});
        child.stdin.end(text, 'utf8');
        await once(child, 'close');
        if (!output.trim()) throw new Error(errors.trim() || 'QQ action did not return a result');
        return JSON.parse(output);
    } finally {
        await pipe.close();
    }
}
