// Lifecycle only: bind an ephemeral port, register it with the env, wait for /done, exit 0.
// Everything the suite talks to lives in app.ts.
import type { Server } from 'node:http';
import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_CAP_MS = 2_000;

function backoff(attempt: number): number {
  return Math.min(BACKOFF_CAP_MS, BACKOFF_START_MS * 2 ** Math.min(attempt, 8));
}
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RegisterRejected extends Error {}

// POST /register {"port": N}; 200 (or 409 = already registered) means we are in.
async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new RegisterRejected(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof RegisterRejected) throw err;
      // Network hiccup or env not ready yet: retry.
    }
    await pause(backoff(attempt));
  }
}

// Poll GET /done until the env answers {"done": true}.
async function waitUntilDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const payload = (await res.json()) as { done?: unknown };
        if (payload.done === true) return;
      }
    } catch {
      // Not done yet.
    }
    await pause(backoff(attempt));
  }
}

function listenEphemeral(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') reject(new Error('the server did not bind an ephemeral TCP port'));
      else resolve(addr.port);
    });
  });
}

async function main(): Promise<void> {
  const server = createApp();
  const port = await listenEphemeral(server);
  process.stdout.write(`[entry] listening on port ${port}\n`);
  await register(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
