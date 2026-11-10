// What the updater loads (docs/singleuser.md "Updating the data"): pure, no network, no files. The caller passes the
// installed tag, the app's schema version, the feed's newest tag and a function that returns a release's manifest.
import type { Manifest } from './manifest.ts';

/** How many releases the delta chain may span (steps back from the newest to the installed one). */
export const MAX_CHAIN = 10;

export type UpdatePlan =
  | { kind: 'upToDate'; tag: string }
  /** The full pack. `reason` is for the log. */
  | { kind: 'full'; manifest: Manifest; reason: 'nothingInstalled' | 'chainTooLong' | 'chainBroken' | 'chainNotSmaller' }
  /** The newest catalog and the thumbs updates of every release since the installed one; `manifests` oldest first (the last is the newest). `bytes`: the newest catalog plus all those updates. */
  | { kind: 'chain'; manifests: Manifest[]; bytes: number }
  /** The pack's catalog schema is not the app's: nothing is installed. `pack`: the pack's schema is newer or older than the app's. */
  | { kind: 'appTooOld'; manifest: Manifest; pack: 'newer' | 'older' };

export interface PlanInput {
  /** The tag of the installed pack, null = nothing installed. */
  installed: string | null;
  /** The snapshot schema version the app reads. */
  appSchemaVersion: number;
  /** The feed's newest (stable) tag. */
  newest: string;
  /** A release's manifest, null if there is none. May throw (network): the planner does not catch. */
  manifestOf: (tag: string) => Promise<Manifest | null>;
}

/** The feed names a release whose manifest is missing or is not that release's. */
export class FeedInconsistent extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FeedInconsistent';
  }
}

export async function planUpdate(input: PlanInput): Promise<UpdatePlan> {
  const { installed, appSchemaVersion, newest, manifestOf } = input;
  if (installed === newest) return { kind: 'upToDate', tag: newest };

  const head = await manifestOf(newest);
  if (!head) throw new FeedInconsistent(`The feed names ${newest}, which has no manifest`);
  if (head.tag !== newest) throw new FeedInconsistent(`The manifest of ${newest} is for ${head.tag}`);
  if (head.schemaVersion !== appSchemaVersion) {
    return { kind: 'appTooOld', manifest: head, pack: head.schemaVersion > appSchemaVersion ? 'newer' : 'older' };
  }
  if (installed === null) return { kind: 'full', manifest: head, reason: 'nothingInstalled' };

  // Walk back from the newest to the installed release, collecting the manifests (newest first)
  const walked: Manifest[] = [head];
  for (let current = head; current.previous !== installed;) {
    if (current.previous === null) return { kind: 'full', manifest: head, reason: 'chainBroken' };
    if (walked.length >= MAX_CHAIN) return { kind: 'full', manifest: head, reason: 'chainTooLong' };
    const previous = await manifestOf(current.previous);
    if (!previous || previous.tag !== current.previous) return { kind: 'full', manifest: head, reason: 'chainBroken' };
    walked.push(previous);
    current = previous;
  }

  const manifests = walked.reverse();
  const bytes = head.files.catalog.size + manifests.reduce((sum, m) => sum + m.files.thumbs.size, 0);
  if (bytes >= head.files.full.size) return { kind: 'full', manifest: head, reason: 'chainNotSmaller' };
  return { kind: 'chain', manifests, bytes };
}
