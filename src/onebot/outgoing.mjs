export function createOutgoingClients(createClient) {
    const clients = new Map();
    const accounts = new Set();

    return {
        update(endpoints) {
            const ids = new Set(endpoints.map(endpoint => endpoint.id));
            for (const [id, client] of clients) {
                if (ids.has(id)) continue;
                client.close();
                clients.delete(id);
            }
            for (const endpoint of endpoints) {
                let client = clients.get(endpoint.id);
                if (!client) {
                    client = createClient(endpoint.id);
                    clients.set(endpoint.id, client);
                    client.update(endpoint);
                    for (const account of accounts) client.attach?.(account);
                } else {
                    client.update(endpoint);
                }
            }
        },
        attach(account) {
            accounts.add(account);
            for (const client of clients.values()) client.attach?.(account);
        },
        detach(account) {
            accounts.delete(account);
            for (const client of clients.values()) client.detach(account);
        },
        publish(account, event) {
            for (const client of clients.values()) client.publish(account, event);
        },
        get(id) {
            return clients.get(id);
        },
        status(read) {
            return Object.fromEntries([...clients].map(([id, client]) => [id, read(client)]));
        },
        close() {
            for (const client of clients.values()) client.close();
            clients.clear();
            accounts.clear();
        },
    };
}
