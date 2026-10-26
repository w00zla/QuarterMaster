// Tooltips für Tabellenzellen: jede Zelle einer Datenzeile (`.table .data-row`) zeigt beim Hover ihren
// Text als `title`, damit auch abgeschnittener Text lesbar ist. Ausgenommen: Zellen mit eigener Info-Karte
// (die Namen), mit Buttons oder einem eigenen `title`. Gesetzt beim Hover, also immer der aktuelle Text.

const OWN = "autoTip";

function onOver(e: MouseEvent) {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const row = target.closest(".table .data-row");
  if (!row) return;
  let cell: Element | null = target;
  while (cell && cell.parentElement !== row) cell = cell.parentElement;
  if (!(cell instanceof HTMLElement)) return;
  const mine = cell.dataset[OWN] !== undefined;
  if (!mine && cell.hasAttribute("title")) return;
  if (cell.querySelector(".info-anchor, button, [title]")) return;
  const text = cell.textContent?.replace(/\s+/g, " ").trim() ?? "";
  if (text) {
    cell.title = text;
    cell.dataset[OWN] = "";
  } else if (mine) {
    cell.removeAttribute("title");
  }
}

export function installCellTips() {
  document.addEventListener("mouseover", onOver);
}
