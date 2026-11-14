import { parseArgs } from 'node:util';
import { sendGroupText } from '../src/qq/actions/messages/send-group.mjs';

try {
    const { values } = parseArgs({
        options: {
            group: { type: 'string' },
            text: { type: 'string' },
            pid: { type: 'string' },
            'bubble-from': { type: 'string' },
        },
    });
    const result = await sendGroupText({
        group: values.group, text: values.text, pid: values.pid, bubbleFrom: values['bubble-from'],
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.status === 'sent' ? 0 : 1;
} catch (error) {
    console.error(error.message);
    process.exitCode = 1;
}
