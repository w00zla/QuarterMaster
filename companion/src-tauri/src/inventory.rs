//! The freight manager's warehouse (freight elevator terminal): read by sc-ohseearr's warehouse reader
//! (`sc_ohseearr_warehouse::WarehouseReader`: the layout detector, the grid fit, the hovered tile and its tooltip;
//! it keeps the last strong fit as the prior of the next reads). This module only adapts its neutral output to the
//! companion's payload (`Grid`), which the frontend, the events and the debug recordings use.
//!
//! Mapping (reader → `Grid`): `Warehouse::tiles` → `tiles` (`quality.value` → `quality`, `quality.ambiguous` →
//! `qualityAmbiguous`, `quality.raw` → `qualityText`, `count.value` → `count`, `count.ambiguous` →
//! `countUncertain`, `count.raw` → `badgeText`, "(under the tooltip)" for the hovered tile whose badge the tooltip
//! covers); `Warehouse::tooltip` → `tooltip` (`name.text` → `name`, `name_rect`'s top left → `x`/`y`, the values of
//! `quality` and `scu`); the diagnostics' `cells` (kind "badge"/"quality") and `layout` (`cols`, `rows`, `pitchX`,
//! `pitchY`, `weight` → `fitWeight`). No layout: no grid. The loc keys of the tooltip's name are not used yet.

use serde::Serialize;

use sc_ohseearr_sc::Reading;
use sc_ohseearr_warehouse::{CellKind, Warehouse, WarehouseDiagnostics};

use crate::ocr::{Rect, TextBox};

/// One tile as a frame shows it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tile {
    /// The whole tile in frame pixels
    pub rect: Rect,
    /// Grid column (0 = leftmost) and row (0 = topmost in this frame; the scroll offset is unknown)
    pub col: u32,
    pub row: u32,
    /// None: no quality text (an item, or the text hidden or cut off)
    pub quality: Option<u32>,
    /// `true` when the OCR text could also be read as another quality ("1000" = 100Q or 1000)
    pub quality_ambiguous: bool,
    /// The badge's count; None when the badge could not be read
    pub count: Option<u32>,
    /// The badge read "X" without digits (taken as 1)
    pub count_uncertain: bool,
    /// Whether this is the hovered tile the tooltip belongs to
    pub hovered: bool,
    pub quality_text: String,
    pub badge_text: String,
}

/// The tooltip of the hovered tile.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tooltip {
    /// The title (the item's name)
    pub name: String,
    /// The chip's quality (materials)
    pub quality: Option<u32>,
    /// The stack's amount in SCU (materials in SCU; "0.001" for one piece of an item material)
    pub scu: Option<String>,
    /// The title's top left corner in frame pixels
    pub x: f32,
    pub y: f32,
    /// The area its texts cover
    pub rect: Rect,
}

/// What a tile's sub-area read (for the debug view).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cell {
    pub row: u32,
    pub col: u32,
    /// "badge" or "quality"
    pub kind: &'static str,
    pub rect: Rect,
    pub text: String,
    pub score: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Grid {
    pub tiles: Vec<Tile>,
    pub tooltip: Option<Tooltip>,
    pub cells: Vec<Cell>,
    /// The tiles' left edges per column and tops per row, the pitch, the fit's weight
    pub cols: Vec<f32>,
    pub rows: Vec<f32>,
    pub pitch_x: f32,
    pub pitch_y: f32,
    pub fit_weight: u32,
}

/// The reader's reading as the companion's grid (None: no grid in the frame) and the text boxes for the debug
/// view (the layout detector's anchors as "[badge]" and "[quality]", the tooltip's lines as read).
pub fn to_legacy(reading: Reading<Warehouse, WarehouseDiagnostics>) -> (Option<Grid>, Vec<TextBox>) {
    let Reading { output, diagnostics } = reading;
    let WarehouseDiagnostics { boxes, cells, layout } = diagnostics;
    let Some(layout) = layout else { return (None, boxes) };
    let tiles = output
        .tiles
        .into_iter()
        .map(|t| {
            let badge_text = if t.hovered && t.badge_covered && t.count.value.is_none() { "(under the tooltip)".to_string() } else { t.count.raw };
            Tile {
                rect: t.rect,
                col: t.col,
                row: t.row,
                quality: t.quality.value,
                quality_ambiguous: t.quality.ambiguous,
                count: t.count.value,
                count_uncertain: t.count.ambiguous,
                hovered: t.hovered,
                quality_text: t.quality.raw,
                badge_text,
            }
        })
        .collect();
    let tooltip = output.tooltip.map(|t| Tooltip { name: t.name.text, quality: t.quality.value, scu: t.scu.value, x: t.name_rect.x0, y: t.name_rect.y0, rect: t.rect });
    let cells = cells
        .into_iter()
        .map(|c| Cell {
            row: c.row,
            col: c.col,
            kind: match c.kind {
                CellKind::Badge => "badge",
                CellKind::Quality => "quality",
            },
            rect: c.rect,
            text: c.text,
            score: c.score,
        })
        .collect();
    let grid = Grid { tiles, tooltip, cells, cols: layout.cols, rows: layout.rows, pitch_x: layout.pitch_x, pitch_y: layout.pitch_y, fit_weight: layout.weight };
    (Some(grid), boxes)
}
