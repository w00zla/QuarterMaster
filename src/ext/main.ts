// Pulls the third-party data into ext.snapshot at start and then every 15 minutes (today: UEX).
// Logs each pull's start, its endpoints and its end with the counts and the next pull's time.
import { connect } from '../db/client.ts';
import { pullUex, UEX_ENDPOINTS } from './uex.ts';

const INTERVAL_MS = 15 * 60 * 1000;

const token = process.env.UEX_TOKEN;
if (!token) throw new Error('UEX_TOKEN is not set');

const { db, close } = connect(process.env.DATABASE_URL);

// Local time, e.g. "2026-10-21 14:17:02" (the container runs in UTC)
const stamp = (d = new Date()) => d.toLocaleString('sv-SE');

async function pull() {
  const t0 = performance.now();
  console.log(`[${stamp()}] UEX pull started (${UEX_ENDPOINTS.length} endpoints)`);
  const r = await pullUex(db, token!);
  const took = ((performance.now() - t0) / 1000).toFixed(1);
  const next = stamp(new Date(Date.now() + INTERVAL_MS - (performance.now() - t0)));
  const line = `[${stamp()}] UEX pull done in ${took} s: ${r.inserted} changed, ${r.unchanged} unchanged, ${r.failed} failed; next pull ${next}`;
  if (r.failed) console.error(line);
  else console.log(line);
}

console.log(`[${stamp()}] ext: UEX pull at start, then every ${INTERVAL_MS / 60_000} minutes`);
let running: Promise<void> = pull();
const timer = setInterval(() => {
  running = running.then(pull);
}, INTERVAL_MS);

const shutdown = async () => {
  clearInterval(timer);
  await running;
  await close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGHUP', shutdown);
