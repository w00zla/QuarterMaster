// Resizable, sortable column state for the grid-based tables (taken from
// BindSight). Widths and the sort choice persist per table in localStorage.
import { computed, ref, toValue, watch, type MaybeRefOrGetter } from "vue";

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
  const widthOf = (c: ColumnSpec) => (c.key === filler.value ? c.width : (widths.value[c.key] ?? c.width));
  const template = computed(() =>
    cols.value.map((c) => (c.key === filler.value ? `minmax(${c.width}px, 1fr)` : `${widthOf(c)}px`)).join(" "),
  );
  // All columns (the filler at its minimum) plus gaps: the row width below which the table scrolls horizontally.
  const minWidth = computed(
    () => cols.value.reduce((sum, c) => sum + widthOf(c), 0) + GAP * (cols.value.length - 1),
  );

  function toggleSort(key: string) {
    sort.value = sort.value.key === key ? { key, dir: sort.value.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
  }

  function startResize(key: string, e: MouseEvent) {
    const startX = e.clientX;
    const startWidth = widths.value[key];
    if (startWidth === undefined) return;
    const move = (ev: MouseEvent) => {
      widths.value[key] = Math.max(MIN_WIDTH, Math.round(startWidth + ev.clientX - startX));
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

  return { widths, template, minWidth, sort, toggleSort, startResize, resetWidth };
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
