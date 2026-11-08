//! The OCR comes from sc-ohseearr (`../sc-ohseearr`, a sibling checkout, path dependency): its engine
//! (`sc-ohseearr-core`) with the model packages `paddle-det-tiny` (PP-OCRv6 tiny detector) and `sc-rec-latin` (our
//! recognizer: cut to Latin, fine-tuned on the game's font; trained in sc-ohseearr's `training/`), all compiled in (the
//! Windows release is a bare exe). The readers on top of it are sc-ohseearr's (`inventory.rs`,
//! `components.rs` and `refinery.rs` adapt their output); the warehouse reader brings its own layout detector
//! (`sc-warehouse-layout`). docs/companion.md "OCR".

pub use sc_ohseearr_core::{resize, FilterType, Ocr, Rect, TextBox, Timings};

/// The compiled-in detector and recognizer, on the CPU or the GPU (an error when DirectML does not work).
/// `threads`: ONNX Runtime's intra-op threads on the CPU (the game runs at the same time, so few). ONNX Runtime's
/// memory arena keeps the largest run's memory (without it the reads took 30 % longer): `ocrwatch` drops the
/// `Ocr` and the readers when the scan stops.
pub fn load(threads: usize, gpu: bool) -> Result<Ocr, String> {
    Ok(Ocr::new(&sc_ohseearr_model_paddle_det_tiny::package(), &sc_ohseearr_model_sc_rec_latin::package(), threads, gpu)?)
}
