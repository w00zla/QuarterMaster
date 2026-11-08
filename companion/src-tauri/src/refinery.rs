//! The refinery terminal's work order overview: read by sc-ohseearr's refinery reader
//! (`sc_ohseearr_refinery::RefineryReader`: the station and every work order panel side by side, found by the
//! terminal's texts in the player's language, which it takes by loc key from the frame's `Locale`). This module
//! only adapts its neutral output to the companion's payload (`Overview`, `Read`), which the frontend
//! (`refinery.ts` matches the names against the catalog), the events and the debug recordings use.
//!
//! Mapping (reader → companion): `Refinery::screen` → `Read` (`Overview` with the orders, `Terminal`, `Nothing`);
//! `station.text` → `station`; per work order `status`, `time_remaining.value` → `seconds`; per row
//! `material.text` → `name`, `quality.value`, `yield_cscu.value`; `covered` as is. The loc keys of the names are not
//! used yet.

use serde::Serialize;

use sc_ohseearr_refinery::{Refinery, Screen};

pub use sc_ohseearr_refinery::Status;

/// The work orders of one terminal as one frame shows them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    /// The terminal's title, e.g. "CRU-L1 AMBITIOUS DREAM STATION"
    pub station: Option<String>,
    /// Left to right
    pub orders: Vec<Order>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Order {
    pub status: Status,
    /// Processing: the time remaining
    pub seconds: Option<u32>,
    pub rows: Vec<Row>,
    /// The "Work Order Accepted" message lies over the panel: rows may be missing or misread
    pub covered: bool,
}

/// One table row. Quality 0–1000, yield in cSCU; `None` where nothing could be read.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub name: String,
    pub quality: Option<u32>,
    pub yield_cscu: Option<u32>,
}

/// What a full read of a frame found.
#[derive(Debug, PartialEq, Eq)]
pub enum Read {
    Overview(Overview),
    /// A refinery terminal, but no work order panel (its start page, a quote, a message over it)
    Terminal,
    Nothing,
}

/// The reader's output as the companion's read.
pub fn to_legacy(refinery: Refinery) -> Read {
    match refinery.screen {
        Screen::Overview => Read::Overview(Overview {
            station: refinery.station.map(|s| s.text),
            orders: refinery
                .orders
                .into_iter()
                .map(|o| Order {
                    status: o.status,
                    seconds: o.time_remaining.value,
                    rows: o.rows.into_iter().map(|r| Row { name: r.material.text, quality: r.quality.value, yield_cscu: r.yield_cscu.value }).collect(),
                    covered: o.covered,
                })
                .collect(),
        }),
        Screen::Terminal => Read::Terminal,
        Screen::Nothing => Read::Nothing,
    }
}
