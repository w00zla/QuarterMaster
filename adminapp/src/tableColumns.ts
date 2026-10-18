// Resizable, sortable column state for the grid-based tables (taken from
// BindSight). Widths and the sort choice persist per table in localStorage.
import { computed, onScopeDispose, ref, toValue, watch, type MaybeRefOrGetter } from "vue";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

export interface ColumnSpec {
  key: string;
  label: string;
  // Default width in px; for the filler column (see fillerKey) its minimum
  width: number;
  sortable?: boolean;
  // Icon in front of the label (an Icon name).
  icon?: string;
  // Warning text after the label, in the warn colour — or, with `dim`, a
  // plain fact in the dim colour.
  note?: string;
  dim?: boolean;
  // Help text behind an info icon after the label
  help?: string;
  // Always its default width: no grip, nothing stored (action columns)
  fixed?: boolean;
  // A separator line before the column, over the full row height
  sep?: boolean;
}

const MIN_WIDTH = 40;

// Natural ordering: "button2" < "button10", case-insensitive.
export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

interface Stored {
  widths?: Record<string, number>;
  sort?: SortState;
}

function load(storageKey: string): Stored {
  try {
    return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Stored;
  } catch {
    return {};
  }
}

const GAP = 12;
// A row's padding left plus right (.row in ui.css)
const ROW_PADDING = 32;

// The filler column takes the space left over: the last column that is not fixed. Every column
// before it resizes itself; the filler has no grip and keeps its default width as minimum.
export function fillerKey(columns: ColumnSpec[]): string | undefined {
  return [...columns].reverse().find((c) => !c.fixed)?.key;
}

// `columns` may be reactive (a getter or ref): columns that appear later
// start at their default width, or the stored one if the key was seen before.
export function useTableColumns(storageKey: string, columns: MaybeRefOrGetter<ColumnSpec[]>, defaultSort: SortState) {
  const stored = load(storageKey);
  const widths = ref<Record<string, number>>({});
  const cols = computed(() => toValue(columns));
  watch(
    cols,
    (list) => {
      for (const c of list) {
        if (widths.value[c.key] !== undefined) continue;
        const w = c.fixed ? undefined : stored.widths?.[c.key];
        widths.value[c.key] = typeof w === "number" && w >= MIN_WIDTH ? w : c.width;
      }
    },
    { immediate: true },
  );
  const storedSort = cols.value.some((c) => c.key === stored.sort?.key) ? stored.sort! : defaultSort;
  const sort = ref<SortState>({ ...storedSort });

  const filler = computed(() => fillerKey(cols.value));

  // The width the rows have (the table element, measured; null until a table is bound via `observe`)
  const room = ref<number | null>(null);
  let observer: ResizeObserver | null = null;
  let observed: Element | null = null;
  /** Bind the `.table` element (`:ref="cols.observe"`): the columns then always fit its width. */
  function observe(el: unknown) {
    const next = el instanceof HTMLElement ? el : null;
    if (next === observed) return;
    observer?.disconnect();
    observed = next;
    room.value = null;
    if (!next) return;
    observer = new ResizeObserver(() => (room.value = next.clientWidth - ROW_PADDING));
    observer.observe(next);
  }
  onScopeDispose(() => observer?.disconnect());

  // The widths shown: the chosen ones, or, where they do not fit, the resizable columns shrunk in
  // proportion (fixed columns and the filler at its minimum stay): the right columns never leave the view
  const shown = computed(() => {
    const list = cols.value;
    const out: Record<string, number> = {};
    for (const c of list) out[c.key] = c.key === filler.value ? c.width : (widths.value[c.key] ?? c.width);
    if (room.value === null) return out;
    const over = list.reduce((sum, c) => sum + out[c.key]!, 0) + GAP * (list.length - 1) - room.value;
    const resizable = list.filter((c) => !c.fixed && c.key !== filler.value);
    const sum = resizable.reduce((s, c) => s + out[c.key]!, 0);
    if (over <= 0 || !sum) return out;
    const factor = Math.max(0, (sum - over) / sum);
    for (const c of resizable) out[c.key] = Math.max(MIN_WIDTH, Math.floor(out[c.key]! * factor));
    return out;
  });
  const template = computed(() =>
    cols.value.map((c) => (c.key === filler.value ? `minmax(${c.width}px, 1fr)` : `${shown.value[c.key]}px`)).join(" "),
  );
  // All columns (the filler at its minimum) plus gaps: the row width below which the table scrolls
  // horizontally (only when even the smallest widths do not fit).
  const minWidth = computed(
    () => cols.value.reduce((sum, c) => sum + shown.value[c.key]!, 0) + GAP * (cols.value.length - 1),
  );

  function toggleSort(key: string) {
    sort.value = sort.value.key === key ? { key, dir: sort.value.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
  }

  function startResize(key: string, e: MouseEvent) {
    // Resizing starts from what is shown (shrunk columns keep their shown widths from now on)
    for (const c of cols.value) if (!c.fixed && c.key !== filler.value) widths.value[c.key] = shown.value[c.key]!;
    const startX = e.clientX;
    const startWidth = widths.value[key];
    if (startWidth === undefined) return;
    // Growing first takes the free room (the filler down to its minimum), then, like Excel, narrows the
    // resizable columns to its right, the nearest first, down to MIN_WIDTH: every column stays in view.
    // Computed from the widths at the start, so dragging back gives the neighbours their width again.
    const free = room.value === null ? Infinity : Math.max(0, room.value - minWidth.value);
    const index = cols.value.findIndex((c) => c.key === key);
    const neighbours = cols.value.slice(index + 1).filter((c) => !c.fixed && c.key !== filler.value)
      .map((c) => ({ key: c.key, start: widths.value[c.key]! }));
    const spare = neighbours.reduce((s, n) => s + Math.max(0, n.start - MIN_WIDTH), 0);
    const move = (ev: MouseEvent) => {
      const width = Math.min(startWidth + free + spare, Math.max(MIN_WIDTH, Math.round(startWidth + ev.clientX - startX)));
      let take = Math.max(0, width - startWidth - free);
      for (const n of neighbours) {
        const cut = Math.min(take, Math.max(0, n.start - MIN_WIDTH));
        widths.value[n.key] = n.start - cut;
        take -= cut;
      }
      widths.value[key] = width;
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      document.body.style.cursor = "";
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  function resetWidth(key: string) {
    const c = cols.value.find((x) => x.key === key);
    if (c) widths.value[key] = c.width;
  }

  watch(
    [widths, sort],
    () => {
      try {
        localStorage.setItem(storageKey, JSON.stringify({ widths: widths.value, sort: sort.value } satisfies Stored));
      } catch {
        // localStorage unavailable: widths simply do not persist.
      }
    },
    { deep: true },
  );

  return { widths, template, minWidth, sort, toggleSort, startResize, resetWidth, observe };
}

// Stable sort by the current column; `valueOf` yields the cell value for a
// column key, `tieBreak` orders rows whose values compare equal.
export function sortRows<T>(
  rows: T[],
  sort: SortState,
  valueOf: (row: T, key: string) => string | number,
  tieBreak: (a: T, b: T) => number = () => 0,
): T[] {
  const dir = sort.dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const va = valueOf(a, sort.key);
    const vb = valueOf(b, sort.key);
    const c = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va), String(vb));
    return c * dir || tieBreak(a, b);
  });
}
