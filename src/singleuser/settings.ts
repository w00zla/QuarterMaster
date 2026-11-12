// The singleuser settings store: `<data folder>/settings.json` (docs/singleuser.md "Settings"). The environment may
// override a value for development and tests; an overridden value is reported as such and never written to the file.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';

/** Unknown keys are dropped (zod's default); a missing key takes its default. */
const settingsSchema = z.object({
  /** The Star Citizen channel folder (the one with Data.p4k), null = not set. */
  gameDir: z.string().min(1).nullable().default(null),
  /** The automatic update of app and data. */
  autoUpdate: z.boolean().default(true),
  /** The user's own UEX key (plain text in the settings file); null = none: then no UEX request is ever made. */
  uexKey: z.string().transform((s) => s.trim()).transform((s) => (s === '' ? null : s)).nullable().default(null),
  /** Minutes between two UEX pulls. */
  uexIntervalMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).default(15),
});

export type Settings = z.infer<typeof settingsSchema>;
export type SettingKey = keyof Settings;

export const settingsFile = (data: string) => join(data, 'settings.json');

export interface SettingsStore {
  /** The effective values: the environment's override where there is one, else the file's. */
  get(): Settings;
  /** Which values the environment overrides. */
  overridden(): Record<SettingKey, boolean>;
  /** Stores values in the file (atomically) and returns the effective settings. Overridden keys must not be passed. */
  update(patch: Partial<Settings>): Settings;
}

/**
 * Reads the file once. A missing file is the defaults; a broken one (not JSON, wrong types) is the defaults and one
 * logged warning. `QM_GAME_DIR` overrides `gameDir`; `QM_AUTO_UPDATE=0` overrides `autoUpdate` to off (anything else
 * leaves it to the file); `QM_UEX_KEY` overrides `uexKey` (trimmed; empty = not overridden).
 */
export function createSettingsStore(file: string, env: Record<string, string | undefined>, log: (message: string) => void): SettingsStore {
  let stored: Settings = settingsSchema.parse({});
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log(`settings: ${file} cannot be read, using the defaults (${(err as Error).message})`);
  }
  if (text !== null) {
    try {
      stored = settingsSchema.parse(JSON.parse(text));
    } catch (err) {
      log(`settings: ${file} is broken, using the defaults (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`);
    }
  }

  const overrides: Partial<Settings> = {};
  if (env.QM_GAME_DIR) overrides.gameDir = env.QM_GAME_DIR;
  if (env.QM_AUTO_UPDATE === '0') overrides.autoUpdate = false;
  if (env.QM_UEX_KEY?.trim()) overrides.uexKey = env.QM_UEX_KEY.trim();

  return {
    get: () => ({ ...stored, ...overrides }),
    overridden: () => ({
      gameDir: 'gameDir' in overrides, autoUpdate: 'autoUpdate' in overrides, uexKey: 'uexKey' in overrides, uexIntervalMinutes: false,
    }),
    update(patch) {
      const next = settingsSchema.parse({ ...stored, ...patch });
      mkdirSync(dirname(file), { recursive: true });
      const temp = `${file}.tmp`;
      writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`);
      renameSync(temp, file);
      stored = next;
      return { ...stored, ...overrides };
    },
  };
}
