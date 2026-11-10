// Where the singleuser variant keeps its files. Pure: the environment, the platform and the home folder are passed in.
import { join, posix, win32 } from 'node:path';

/**
 * The data folder: `QM_DATA_DIR` if set, else `%LOCALAPPDATA%\QuarterMaster\singleuser` on Windows and
 * `${XDG_DATA_HOME:-~/.local/share}/quartermaster/singleuser` elsewhere. Does not create it.
 */
export function dataDir(env: Record<string, string | undefined>, platform: string, home: string): string {
  if (env.QM_DATA_DIR) return env.QM_DATA_DIR;
  if (platform === 'win32') {
    return win32.join(env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local'), 'QuarterMaster', 'singleuser');
  }
  return posix.join(env.XDG_DATA_HOME || posix.join(home, '.local', 'share'), 'quartermaster', 'singleuser');
}

/** The PGlite database folder inside the data folder. */
export const dbDir = (data: string) => join(data, 'db');

/** The thumbnails: `QM_THUMBS_DIR` if set, else `thumbs` in the data folder (it may be missing: no thumbnails then). */
export const thumbsDir = (env: Record<string, string | undefined>, data: string) => env.QM_THUMBS_DIR || join(data, 'thumbs');
