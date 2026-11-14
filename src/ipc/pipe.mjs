import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFrames } from './frames.mjs';

export async function openMessagePipe(onMessage, onError) {
    const path = '\\\\.\\pipe\\miaoko-' + randomUUID();
    const clients = new Set();
    const server = createServer(socket => {
        clients.add(socket);
        socket.once('close', () => clients.delete(socket));
        consume(socket, onMessage).catch(onError);
    });
    server.maxConnections = 1;
    const ready = once(server, 'listening');
    server.listen(path);
    await ready;
    server.on('error', onError);
    return {
        path,
        async close() {
            for (const socket of clients) {
                socket.destroy();
            }
            await new Promise((resolve, reject) => {
                server.close(error => error ? reject(error) : resolve());
            });
        },
    };
}

async function consume(socket, onMessage) {
    for await (const message of readFrames(socket)) {
        await onMessage(message);
    }
}
