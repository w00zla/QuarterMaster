// The data pack's manifest (docs/singleuser.md "The data pack"): what a data release is made of and how it is checked.
import { z } from 'zod';

export const DATA_PACK_FORMAT = 1;

/** A refusal with a readable message; `code` tells the caller what kind it is. */
export class DataPackError extends Error {
  readonly code: 'invalid' | 'unknownFormat' | 'checksum' | 'incomplete';
  constructor(code: DataPackError['code'], message: string) {
    super(message);
    this.name = 'DataPackError';
    this.code = code;
  }
}

// The game label ("4.10.2.12913470") goes into file names and the tag
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const TAG = /^data-([A-Za-z0-9][A-Za-z0-9._+-]*)-([1-9][0-9]*)$/;

export const tagOf = (label: string, n: number) => `data-${label}-${n}`;
export const fullPackName = (label: string, n: number) => `quartermaster-data-${label}-${n}.zip`;
export const MANIFEST_NAME = 'manifest.json';
export const CATALOG_NAME = 'catalog.json.gz';
export const THUMBS_UPDATE_NAME = 'thumbs-update.zip';

/** True for a game label that is safe in file names and tags. */
export const isGameLabel = (label: string) => LABEL.test(label);

/** Splits a tag into the game label and the re-issue number; null if it is not a data tag. */
export function parseTag(tag: string): { label: string; n: number } | null {
  const m = TAG.exec(tag);
  return m ? { label: m[1]!, n: Number(m[2]) } : null;
}

const fileSchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
  size: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

export const manifestSchema = z.object({
  format: z.literal(DATA_PACK_FORMAT),
  tag: z.string().regex(TAG),
  // The predecessor's tag (the thumbnail chain), null for a first release
  previous: z.string().regex(TAG).nullable(),
  game: z.object({ label: z.string().regex(LABEL), build: z.number().int() }),
  schemaVersion: z.number().int(),
  files: z.object({
    full: fileSchema,
    catalog: fileSchema,
    // `count`: the pictures (files `<size>/<uuid>.<hash>.avif`) in thumbs-update.zip
    thumbs: fileSchema.extend({ count: z.number().int().nonnegative() }),
  }),
}).superRefine((m, ctx) => {
  const t = parseTag(m.tag);
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (!t || t.label !== m.game.label) return fail('tag and game label do not match');
  if (m.files.full.name !== fullPackName(t.label, t.n)) fail('files.full.name does not match the tag');
  if (m.files.catalog.name !== CATALOG_NAME) fail(`files.catalog.name must be ${CATALOG_NAME}`);
  if (m.files.thumbs.name !== THUMBS_UPDATE_NAME) fail(`files.thumbs.name must be ${THUMBS_UPDATE_NAME}`);
  if (m.previous === m.tag) fail('previous is the release itself');
});

export type Manifest = z.infer<typeof manifestSchema>;
export type ManifestFile = z.infer<typeof fileSchema>;

/**
 * `size` and `sha256` of `files.full` in the manifest inside the full pack: the archive cannot hold its own size and
 * hash, so the copy inside carries the name and these placeholders. The real values are in the standalone manifest,
 * and only the downloaded asset is checked against them. A full pack the user picked is checked by its entries' CRCs
 * and by `files.catalog` (the catalog is the one part the manifest also describes inside the archive).
 */
export const EMBEDDED_FULL = { size: 0, sha256: '0'.repeat(64) } as const;

/** Checks a parsed manifest: format first (a newer format may look different), then the rest. */
export function parseManifest(json: unknown): Manifest {
  const format = (json as { format?: unknown } | null)?.format;
  if (format !== DATA_PACK_FORMAT) {
    throw new DataPackError('unknownFormat', `This data pack has a format (${String(format)}) this app does not know`);
  }
  const parsed = manifestSchema.safeParse(json);
  if (!parsed.success) {
    throw new DataPackError('invalid', `The data pack's manifest is invalid: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
  }
  return parsed.data;
}
