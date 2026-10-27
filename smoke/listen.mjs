/**
 * Binds a smoke server to an ephemeral loopback port that `fetch` will reach.
 *
 * The Fetch Standard refuses a request to a "bad port" (its port blocking step),
 * and Node's and Deno's `fetch` both enforce the list. An operating system
 * whose ephemeral range was configured to start low (a Windows range can be
 * set down to 1024) can hand
 * `listen(0)` one of those ports, and the request then fails with `bad port`
 * before the server sees it. Such a port is released and another is drawn.
 */

// The Fetch Standard's bad-port list, the entries an ephemeral range can reach (>= 1024).
const FETCH_BLOCKED_PORTS = new Set([
    1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const MAX_DRAWS = 8;

/** Listens on `host` and resolves the bound port, never one `fetch` blocks. */
export async function listenForFetch(server, host = "127.0.0.1") {
    for (let draw = 0; draw < MAX_DRAWS; draw++) {
        await new Promise((resolve) => server.listen(0, host, resolve));
        const { port } = server.address();
        if (!FETCH_BLOCKED_PORTS.has(port)) return port;
        await new Promise((resolve) => server.close(() => resolve()));
    }
    throw new Error(`listenForFetch: ${MAX_DRAWS} draws all landed on fetch-blocked ports`);
}
