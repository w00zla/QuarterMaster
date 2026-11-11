//! The server's start protocol (docs/singleuser.md "The start protocol"): the stable lines it prints on stdout beside its
//! log lines. Everything that is not one of them is a log line.

/// A loading step, in the order the server takes them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Database,
    Migrations,
    LanguagePack,
    Listen,
}

impl Step {
    /// The segment the step lights on the splash (1 to 4).
    pub fn number(self) -> u8 {
        match self {
            Step::Database => 1,
            Step::Migrations => 2,
            Step::LanguagePack => 3,
            Step::Listen => 4,
        }
    }
}

/// How many segments the splash shows.
pub const STEPS: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    Step(Step),
    /// The server listens; the origin is `http://127.0.0.1:<port>` and nothing else.
    Ready(String),
    /// The start failed; the code as the server printed it.
    Fatal(String),
    /// Not a protocol line: goes to the log file.
    Log,
}

/// `http://127.0.0.1:<port>`, a port of 1 to 65535 without a leading zero: the only origin the window is ever sent to.
pub fn local_origin(text: &str) -> Option<u16> {
    let port = text.strip_prefix("http://127.0.0.1:")?;
    if port.is_empty() || port.starts_with('0') || !port.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

/// Reads one stdout line. A protocol word with a value the protocol does not know (a new step, an origin that is not
/// local) is `Fatal("internal")` for `QM_READY` (the window must not go anywhere else) and a log line for `QM_STEP`.
pub fn parse_line(line: &str) -> Line {
    let line = line.trim_end_matches(['\r', '\n']);
    if let Some(step) = line.strip_prefix("QM_STEP ") {
        return match step {
            "database" => Line::Step(Step::Database),
            "migrations" => Line::Step(Step::Migrations),
            "languagePack" => Line::Step(Step::LanguagePack),
            "listen" => Line::Step(Step::Listen),
            _ => Line::Log,
        };
    }
    if let Some(origin) = line.strip_prefix("QM_READY ") {
        return match local_origin(origin) {
            Some(_) => Line::Ready(origin.to_string()),
            None => Line::Fatal("internal".into()),
        };
    }
    if let Some(code) = line.strip_prefix("QM_FATAL ") {
        return Line::Fatal(code.trim().to_string());
    }
    Line::Log
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_in_order() {
        let steps: Vec<Line> = ["QM_STEP database", "QM_STEP migrations", "QM_STEP languagePack", "QM_STEP listen"].iter().map(|l| parse_line(l)).collect();
        assert_eq!(steps, [Line::Step(Step::Database), Line::Step(Step::Migrations), Line::Step(Step::LanguagePack), Line::Step(Step::Listen)]);
        assert_eq!([Step::Database, Step::Migrations, Step::LanguagePack, Step::Listen].map(Step::number), [1, 2, 3, STEPS]);
    }

    #[test]
    fn ready_takes_the_local_origin_only() {
        assert_eq!(parse_line("QM_READY http://127.0.0.1:28460"), Line::Ready("http://127.0.0.1:28460".into()));
        assert_eq!(parse_line("QM_READY http://127.0.0.1:28460\r\n"), Line::Ready("http://127.0.0.1:28460".into()));
        for bad in [
            "QM_READY http://example.com:28460",
            "QM_READY https://127.0.0.1:28460",
            "QM_READY http://127.0.0.1:28460/x",
            "QM_READY http://127.0.0.1:28460@example.com",
            "QM_READY http://127.0.0.1:",
            "QM_READY http://127.0.0.1:0",
            "QM_READY http://127.0.0.1:99999",
            "QM_READY http://127.0.0.1:028460",
            "QM_READY http://localhost:28460",
        ] {
            assert_eq!(parse_line(bad), Line::Fatal("internal".into()), "{bad}");
        }
    }

    #[test]
    fn fatal_carries_the_code() {
        for code in ["portsBusy", "locked", "database", "config", "internal", "somethingNew"] {
            assert_eq!(parse_line(&format!("QM_FATAL {code}")), Line::Fatal(code.into()));
        }
    }

    #[test]
    fn everything_else_is_a_log_line() {
        for line in [
            "",
            "open database: 812 ms",
            "listening on http://127.0.0.1:28460 (started in 2100 ms)",
            "QM_STEP",
            "QM_STEP somethingNew",
            " QM_READY http://127.0.0.1:28460",
            "QM_READY",
            "QM_FATAL",
            "xQM_FATAL locked",
        ] {
            assert_eq!(parse_line(line), Line::Log, "{line:?}");
        }
    }
}
