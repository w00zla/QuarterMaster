//! The character inventory ("Storage Access"): read by sc-ohseearr's gear-inventory reader
//! (`sc_ohseearr_gear_inventory::GearInventoryReader`: the page number and the UI scale it tells, which it keeps,
//! the tile under the cursor with its stack count, the hovered item's tooltip as text lines). This module only
//! adapts its neutral output to the companion's payload (`ComponentRead`), which the frontend (`components.ts`
//! matches the lines against the stat names), the events and the debug recordings use.
//!
//! Mapping (reader → `ComponentRead`): `page` as is; `cell` with `count.value` → `count`; `tooltip` with
//! `title.text` → `title`, `lines` and `rect` as is. The loc keys of the title are not used yet.

use serde::Serialize;

use sc_ohseearr_gear_inventory::{GearDiagnostics, GearInventory};
use sc_ohseearr_sc::Reading;

pub use sc_ohseearr_core::Line;
pub use sc_ohseearr_gear_inventory::Page;

use crate::ocr::{Rect, TextBox};

/// The hovered item's tooltip.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tooltip {
    /// The first line
    pub title: String,
    /// Every line below it, top to bottom
    pub lines: Vec<Line>,
    /// The area its texts cover (frame pixels)
    pub rect: Rect,
}

/// The hovered tile of the storage grid: its row in the page's content (0 = the first, also when
/// scrolled out of view), its first unit (0–3) and how many it spans, its area in frame pixels, and
/// the stack's count where the tile shows one ("2x"; None: a single piece).
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    pub span: u32,
    pub rect: Rect,
    pub count: Option<u32>,
}

/// What one frame of the inventory screen read.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComponentRead {
    pub tooltip: Option<Tooltip>,
    pub page: Option<Page>,
    /// The tile under the mouse cursor (None: no cursor, outside the grid, or no lit tile there)
    pub cell: Option<Cell>,
}

/// The reader's reading as the companion's read and the text boxes for the debug view (the page number's area,
/// the tooltip's, the count's).
pub fn to_legacy(reading: Reading<GearInventory, GearDiagnostics>) -> (ComponentRead, Vec<TextBox>) {
    let Reading { output, diagnostics } = reading;
    let read = ComponentRead {
        tooltip: output.tooltip.map(|t| Tooltip { title: t.title.text, lines: t.lines, rect: t.rect }),
        page: output.page,
        cell: output.cell.map(|c| Cell { row: c.row, col: c.col, span: c.span, rect: c.rect, count: c.count.value }),
    };
    (read, diagnostics.boxes)
}
