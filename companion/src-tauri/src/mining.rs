//! The radar signature a ship's scan shows (the small plate above the heading tape, a pin icon and a number):
//! read by sc-ohseearr's mining HUD reader (`sc_ohseearr_mining_hud::MiningHudReader`). This module only adapts
//! its neutral output to the companion's payload (`SignatureRead`), which the frontend, the events, the
//! signature overlay's placing and the debug recordings use.
//!
//! Mapping (reader → companion): `signature.value` → `value`, `signature.raw` → `raw`, `signature.score` →
//! `score`, `rect` as is (the number's box in frame pixels, without the icon: where the signature overlay goes); the
//! diagnostics' `window` (where the reader looked) for the debug view.

use serde::Serialize;

use sc_ohseearr_mining_hud::MiningHud;

use crate::ocr::Rect;

/// What one frame shows of the radar signature.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureRead {
    /// The signature (1,000 and up); None: no plate in view, or its number could not be read
    pub value: Option<u32>,
    /// The text as the OCR read it (empty without a plate)
    pub raw: String,
    /// The OCR's confidence in the text (0–1)
    pub score: f32,
    /// The number's box in frame pixels, without the pin icon
    pub rect: Option<Rect>,
    /// Where the reader looked for the plate (frame pixels; the debug view)
    pub window: Option<Rect>,
}

pub fn to_legacy(hud: MiningHud, window: Option<Rect>) -> SignatureRead {
    SignatureRead { value: hud.signature.value, raw: hud.signature.raw, score: hud.signature.score, rect: hud.rect, window }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sc_ohseearr_sc::Field;

    #[test]
    fn the_readers_output_as_the_payload() {
        let rect = Rect { x0: 1910.0, y0: 510.0, x1: 1970.0, y1: 535.0 };
        let read = to_legacy(MiningHud { signature: Field::new(Some(42000), ", 42,000", 0.94, false), rect: Some(rect) }, None);
        assert_eq!(read, SignatureRead { value: Some(42000), raw: ", 42,000".into(), score: 0.94, rect: Some(rect), window: None });
        let json = serde_json::to_value(&read).unwrap();
        assert_eq!(json["value"], 42000);
        assert_eq!(json["rect"]["x0"], 1910.0);
        // No plate
        let none = to_legacy(MiningHud { signature: Field::none(), rect: None }, Some(rect));
        assert_eq!(none, SignatureRead { value: None, raw: String::new(), score: 0.0, rect: None, window: Some(rect) });
    }
}
