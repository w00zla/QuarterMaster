// The readable game version, formed from the build manifest (`build_manifest.id`) next to Data.p4k.

/**
 * `Branch` without its `sc-alpha-` prefix, a dot, then `RequestedP4ChangeNum`:
 * `sc-alpha-4.10.2` + 12913470 -> `4.10.2.12913470`. Takes the whole manifest (its `Data` object).
 * Throws an error naming what is missing.
 */
export function gameLabel(manifest: unknown): string {
  const data = (manifest as { Data?: Record<string, unknown> } | null | undefined)?.Data;
  const branch = typeof data?.Branch === 'string' ? data.Branch.trim() : '';
  const change = String(data?.RequestedP4ChangeNum ?? '').trim();
  const missing = [!branch && 'Branch', !/^\d+$/.test(change) && 'RequestedP4ChangeNum'].filter(Boolean);
  if (missing.length) throw new Error(`Cannot form the game label: build manifest Data lacks a valid ${missing.join(' and ')}`);
  return `${branch.replace(/^sc-alpha-/, '')}.${change}`;
}
