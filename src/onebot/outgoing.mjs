export function createOutgoingClients(createClient) {
    const clients = new Map();
    const accounts = new Set();
    const matches = (owner, account) => owner === undefined || owner === account;

    return {
        update(endpoints) {
            const ids = new Set(endpoints.map(endpoint => endpoint.id));
            for (const [id, { client }] of clients) {
                if (ids.has(id)) continue;
                client.close();
                clients.delete(id);
            }
            for (const endpoint of endpoints) {
                const current = clients.get(endpoint.id);
                const client = current?.client ?? createClient(endpoint.id);
                const owner = endpoint.selfId;
                for (const account of accounts) {
                    if (current && matches(current.owner, account) && !matches(owner, account)) client.detach(account);
                }
                client.update(endpoint);
                clients.set(endpoint.id, { client, owner });
                for (const account of accounts) {
                    if (matches(owner, account) && (!current || !matches(current.owner, account))) client.attach?.(account);
                }
            }
        },
        attach(account) {
            accounts.add(account);
            for (const { client, owner } of clients.values()) if (matches(owner, account)) client.attach?.(account);
        },
        detach(account) {
            accounts.delete(account);
            for (const { client, owner } of clients.values()) if (matches(owner, account)) client.detach(account);
        },
        publish(account, event) {
            for (const { client, owner } of clients.values()) if (matches(owner, account)) client.publish(account, event);
        },
        get(id) {
            return clients.get(id)?.client;
        },
        status(read) {
            return Object.fromEntries([...clients].map(([id, { client }]) => [id, read(client)]));
        },
        close() {
            for (const { client } of clients.values()) client.close();
            clients.clear();
            accounts.clear();
        },
    };
}
