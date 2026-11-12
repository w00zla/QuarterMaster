// The port of the singleuser server: `QM_PORT` (exactly that one) or the first free one of the product range.
import { createServer } from 'node:net';

export const PORT_FIRST = 28460;
export const PORT_LAST = 28469;

/** Whether a listener on 127.0.0.1:port can be opened right now (tried for real, then closed again). */
export const canListen = (port: number) => new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
});

/**
 * `QM_PORT` if set: exactly that port, an error when it is invalid or taken. Else the first free port of
 * 28460–28469; an error naming the range when none is.
 */
export async function choosePort(env: Record<string, string | undefined>, free: (port: number) => Promise<boolean> = canListen): Promise<number> {
  if (env.QM_PORT) {
    const port = Number(env.QM_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`QM_PORT must be a port number (1-65535), got "${env.QM_PORT}"`);
    if (!(await free(port))) throw new Error(`Port ${port} (QM_PORT) is already in use on 127.0.0.1`);
    return port;
  }
  for (let port = PORT_FIRST; port <= PORT_LAST; port++) if (await free(port)) return port;
  throw new Error(`No free port on 127.0.0.1 in ${PORT_FIRST}-${PORT_LAST}: is Quartermaster already running? Set QM_PORT to use another`);
}
