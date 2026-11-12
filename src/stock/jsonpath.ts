// The part of Postgres' jsonpath (lax mode) the base paths of `component-base.ts` use, evaluated over parsed
// JSON: `$`, `.key`, `[*]`, `[n]` and the filter `? (@.key… == "text")`, chained. Anything else does not
// parse (an error, never a silent miss). `pathQueryFirst` answers what `jsonb_path_query_first` answers.
//
// Lax mode as Postgres implements it (jsonpath_exec.c), as far as these steps go:
// - `.key` on an object: its member, nothing when it has none. On an array: the members of its elements
//   (unwrapped one level: an element that is an array itself yields nothing). On anything else: nothing.
// - `[*]` on an array: its elements; on anything else: the value itself (wrapped).
// - `[n]` on an array: the element, nothing beyond its end; on anything else: the value itself for 0.
// - a filter on an array tests its elements (one level), on anything else the value itself; the left side's
//   arrays are unwrapped one level, and the filter holds when any of its values is the string.

type Step =
  | { kind: 'key'; name: string }
  | { kind: 'all' }
  | { kind: 'index'; index: number }
  | { kind: 'filter'; keys: string[]; text: string };

const TOKENS: [RegExp, (m: RegExpExecArray) => Step][] = [
  [/\.([A-Za-z_]\w*)/y, (m) => ({ kind: 'key', name: m[1]! })],
  [/\[\*\]/y, () => ({ kind: 'all' })],
  [/\[(\d+)\]/y, (m) => ({ kind: 'index', index: Number(m[1]) })],
  [/\s*\?\s*\(\s*@((?:\.[A-Za-z_]\w*)+)\s*==\s*"([^"\\]*)"\s*\)/y, (m) => ({ kind: 'filter', keys: m[1]!.slice(1).split('.'), text: m[2]! })],
];

const parsed = new Map<string, Step[]>();

/** The steps of a path; throws on anything outside the subset above. */
export function parsePath(path: string): Step[] {
  const known = parsed.get(path);
  if (known) return known;
  if (!path.startsWith('$')) throw new Error(`jsonpath: must start with $: ${path}`);
  const steps: Step[] = [];
  let at = 1;
  while (at < path.length) {
    let step: Step | null = null;
    for (const [pattern, make] of TOKENS) {
      pattern.lastIndex = at;
      const m = pattern.exec(path);
      if (!m) continue;
      step = make(m);
      at = pattern.lastIndex;
      break;
    }
    if (!step) throw new Error(`jsonpath: unsupported at ${at}: ${path}`);
    steps.push(step);
  }
  parsed.set(path, steps);
  return steps;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const member = (v: unknown, name: string): unknown[] => (isObject(v) && Object.hasOwn(v, name) ? [v[name]] : []);
const key = (v: unknown, name: string): unknown[] => (Array.isArray(v) ? v.flatMap((e) => member(e, name)) : member(v, name));

function holds(v: unknown, keys: string[], text: string): boolean {
  let left: unknown[] = [v];
  for (const name of keys) left = left.flatMap((l) => key(l, name));
  return left.flatMap((l) => (Array.isArray(l) ? l : [l])).some((l) => l === text);
}

function apply(step: Step, v: unknown): unknown[] {
  switch (step.kind) {
    case 'key': return key(v, step.name);
    case 'all': return Array.isArray(v) ? v : [v];
    case 'index': return Array.isArray(v) ? (step.index < v.length ? [v[step.index]] : []) : step.index === 0 ? [v] : [];
    case 'filter': return (Array.isArray(v) ? v : [v]).filter((e) => holds(e, step.keys, step.text));
  }
}

/** The first value the path finds in `data` (may be null, an object or an array); undefined when it finds none. */
export function pathQueryFirst(data: unknown, path: string): unknown {
  let found: unknown[] = [data];
  for (const step of parsePath(path)) found = found.flatMap((v) => apply(step, v));
  return found[0];
}
