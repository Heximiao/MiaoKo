import { parseArgs } from 'node:util';
import { runDashboard } from '../src/server/dashboard.mjs';
import { writeTerminal } from '../src/server/onebot-logs.mjs';

const { values } = parseArgs({
    options: {
        pid: { type: 'string', multiple: true },
        seconds: { type: 'string' },
        port: { type: 'string' },
        bind: { type: 'string' },
        'public-url': { type: 'string' },
        'reset-password': { type: 'boolean' },
        'media-base-url': { type: 'string' },
        'media-port': { type: 'string' },
        'media-bind': { type: 'string' },
    },
});
try {
    await runDashboard({
        port: values.port === undefined ? undefined : Number(values.port),
        bind: values.bind,
        publicUrl: values['public-url'],
        resetPassword: values['reset-password'],
        seconds: values.seconds === undefined ? undefined : Number(values.seconds),
        requested: (values.pid ?? []).map(Number),
        mediaUrl: values['media-base-url'],
        mediaPort: values['media-port'] === undefined ? undefined : Number(values['media-port']),
        mediaBind: values['media-bind'],
    });
} catch (error) {
    writeTerminal('ERROR', 'MiaoKo', error.message);
    process.exitCode = 1;
}
