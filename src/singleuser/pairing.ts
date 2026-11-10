// The pairing file: how the companion app finds the local server and the game folder (docs/singleuser.md "Pairing").
// No token: the local API is open by decision. Written when the server listens, rewritten when the game folder
// setting changes, removed on a clean exit; after a crash a stale file stays (the companion then gets "refused").
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, posix, win32 } from 'node:path';
import { z } from 'zod';

export const pairingSchema = z.object({
  format: z.literal(1),
  /** `http://127.0.0.1:<port>` */
  origin: z.string().min(1),
  /** The game folder setting, null = not set. */
  gameDir: z.string().min(1).nullable(),
});

export type Pairing = z.infer<typeof pairingSchema>;

/**
 * `QM_PAIRING_FILE` if set (development, tests), else `%LOCALAPPDATA%\QuarterMaster\pairing.json` on Windows and
 * `${XDG_DATA_HOME:-~/.local/share}/quartermaster/pairing.json` elsewhere. Pure; does not create anything.
 */
export function pairingFile(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (env.QM_PAIRING_FILE) return env.QM_PAIRING_FILE;
  if (platform === 'win32') return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'QuarterMaster', 'pairing.json');
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'quartermaster', 'pairing.json');
}

/** Writes the file atomically (temp file, rename), creating its folder. */
export function writePairing(file: string, content: { origin: string; gameDir: string | null }): void {
  const pairing: Pairing = { format: 1, origin: content.origin, gameDir: content.gameDir };
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  writeFileSync(temp, `${JSON.stringify(pairing, null, 2)}\n`);
  renameSync(temp, file);
}

/** Deletes the file; no error when it is not there. */
export function removePairing(file: string): void {
  rmSync(file, { force: true });
}

/** Reads the file back; null when it is missing, unreadable or not a pairing file. */
export function readPairing(file: string): Pairing | null {
  try {
    const parsed = pairingSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
