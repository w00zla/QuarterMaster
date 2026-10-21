// Pulls the third-party data into ext.snapshot at start and then every 15 minutes (today: UEX).
import { connect } from '../db/client.ts';
import { pullUex } from './uex.ts';

const INTERVAL_MS = 15 * 60 * 1000;

const token = process.env.UEX_TOKEN;
if (!token) throw new Error('UEX_TOKEN is not set');

const { db, close } = connect(process.env.DATABASE_URL);

let running: Promise<void> = pullUex(db, token);
const timer = setInterval(() => {
  running = running.then(() => pullUex(db, token));
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
