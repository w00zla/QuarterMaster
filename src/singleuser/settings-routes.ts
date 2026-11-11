// The singleuser settings routes (docs/singleuser.md "Settings"): the settings with the game folder's state and the
// language pack's, and the change of them. The pack is the one read at start; a changed game folder does not re-read it.
import { z } from 'zod';
import type { GameFolderState, LanguagePackState, LocalSettingsState } from '../webapp/api-types.ts';
import type { ApiApp } from '../webapp/app.ts';
import { checkGameFolder, describeGameFolder, type LanguagePack } from './game-folder.ts';
import type { SettingsStore } from './settings.ts';

/** What was read at start: the game folder it was read for (null = none) and the pack (null = nothing was read). */
export interface LoadedPack {
  gameDir: string | null;
  pack: LanguagePack | null;
  /** The pack's texts are stored as a localization source and in effect (the start's sync did that). */
  active: boolean;
}

const NORMAL_ENGLISH = new Set(['noUserCfg', 'noLanguage', 'builtInEnglish']);

/** The API's view of a loaded pack; `pending` = the game folder is no longer the one it was read for. */
export function languagePackState(loaded: LoadedPack, gameDir: string | null): LanguagePackState {
  const pending = loaded.gameDir !== gameDir;
  const { pack } = loaded;
  if (pack === null) return { state: 'none', pending };
  if (pack.texts !== null) return { state: 'loaded', language: pack.language ?? undefined, texts: pack.texts.size, active: loaded.active, pending };
  const problem = pack.problem!;
  return { state: NORMAL_ENGLISH.has(problem) ? 'none' : 'problem', ...(pack.language ? { language: pack.language } : {}), problem, pending };
}

const updateSchema = z.strictObject({
  gameDir: z.string().min(1).nullable().optional(),
  autoUpdate: z.boolean().optional(),
});

export interface SettingsRoutesDeps {
  store: SettingsStore;
  loaded: LoadedPack;
  /** Called after the game folder setting changed (the pairing file is rewritten). */
  onGameDirChange: (gameDir: string | null) => void;
}

export function mountSettingsRoutes(deps: SettingsRoutesDeps): (api: ApiApp) => void {
  const { store, loaded } = deps;
  let gameFolder: GameFolderState = describeGameFolder(store.get().gameDir);
  const state = (): LocalSettingsState => {
    const settings = store.get();
    return { ...settings, overridden: store.overridden(), gameFolder, languagePack: languagePackState(loaded, settings.gameDir) };
  };

  return (api) => {
    api.get('/local/settings', (c) => c.json(state()));

    api.put('/local/settings', async (c) => {
      const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'invalid settings' }, 400);
      const patch = parsed.data;
      const overridden = store.overridden();
      const locked = (Object.keys(patch) as (keyof typeof overridden)[]).filter((k) => patch[k] !== undefined && overridden[k]);
      if (locked.length > 0) return c.json({ error: 'overridden', keys: locked }, 409);
      if (typeof patch.gameDir === 'string') {
        const check = checkGameFolder(patch.gameDir);
        if (!check.ok) return c.json({ error: 'gameFolderInvalid', problem: check.problem }, 422);
      }
      const before = store.get().gameDir;
      const next = store.update({
        ...(patch.gameDir !== undefined ? { gameDir: patch.gameDir } : {}),
        ...(patch.autoUpdate !== undefined ? { autoUpdate: patch.autoUpdate } : {}),
      });
      if (patch.gameDir !== undefined) gameFolder = describeGameFolder(next.gameDir);
      if (next.gameDir !== before) deps.onGameDirChange(next.gameDir);
      return c.json(state());
    });
  };
}
