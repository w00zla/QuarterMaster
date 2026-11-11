//! The shell's own texts: German when the system language is German, else English. The loading steps' texts come from
//! the bundle (`startTexts`), so the splash words them as the web app does.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    De,
    En,
}

impl Lang {
    /// From a locale name as the system reports it (`de-DE`, `de_AT.UTF-8`, `en-US`).
    pub fn from_locale(locale: Option<&str>) -> Lang {
        match locale {
            Some(l) if l.len() >= 2 && l[..2].eq_ignore_ascii_case("de") && l[2..].chars().next().is_none_or(|c| !c.is_ascii_alphabetic()) => Lang::De,
            _ => Lang::En,
        }
    }

    pub fn system() -> Lang {
        Lang::from_locale(sys_locale::get_locale().as_deref())
    }

    fn pick(self, de: &'static str, en: &'static str) -> &'static str {
        match self {
            Lang::De => de,
            Lang::En => en,
        }
    }

    /// The sentence for a `QM_FATAL` code; any code the shell does not know is the general one.
    pub fn fatal(self, code: &str) -> &'static str {
        match code {
            "portsBusy" => self.pick("Kein freier Anschluss.", "No free port."),
            "locked" => self.pick("Quartermaster läuft bereits.", "Quartermaster is already running."),
            "database" => self.pick("Datenbank lässt sich nicht öffnen.", "The database cannot be opened."),
            _ => self.pick("Start fehlgeschlagen.", "Start failed."),
        }
    }

    /// The server ended while the app was running.
    pub fn stopped(self) -> &'static str {
        self.pick("Der Server wurde unerwartet beendet.", "The server stopped unexpectedly.")
    }

    pub fn quit(self) -> &'static str {
        self.pick("Beenden", "Quit")
    }

    /// The settings window's title (the taskbar's name for it; the window has no frame).
    pub fn settings_title(self) -> &'static str {
        self.pick("Quartermaster – Einstellungen", "Quartermaster – Settings")
    }

    pub fn installing_update(self) -> &'static str {
        self.pick("Update wird installiert …", "Installing update …")
    }

    /// A newer version exists, but this installation has no updater (a bare executable, a package of the distribution).
    pub fn cannot_update(self, version: &str) -> String {
        match self {
            Lang::De => format!("Version {version} ist verfügbar. Diese Installation kann sich nicht selbst aktualisieren."),
            Lang::En => format!("Version {version} is available. This installation cannot update itself."),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn german_only_for_german_locales() {
        for de in ["de", "de-DE", "de_AT.UTF-8", "DE-ch"] {
            assert_eq!(Lang::from_locale(Some(de)), Lang::De, "{de}");
        }
        for en in ["en-US", "fr-FR", "den", "d", ""] {
            assert_eq!(Lang::from_locale(Some(en)), Lang::En, "{en}");
        }
        assert_eq!(Lang::from_locale(None), Lang::En);
    }

    #[test]
    fn fatal_texts_per_code() {
        assert_eq!(Lang::De.fatal("portsBusy"), "Kein freier Anschluss.");
        assert_eq!(Lang::En.fatal("portsBusy"), "No free port.");
        assert_eq!(Lang::De.fatal("locked"), "Quartermaster läuft bereits.");
        assert_eq!(Lang::En.fatal("locked"), "Quartermaster is already running.");
        assert_eq!(Lang::De.fatal("database"), "Datenbank lässt sich nicht öffnen.");
        assert_eq!(Lang::En.fatal("database"), "The database cannot be opened.");
        for other in ["config", "internal", "somethingNew", ""] {
            assert_eq!(Lang::De.fatal(other), "Start fehlgeschlagen.");
            assert_eq!(Lang::En.fatal(other), "Start failed.");
        }
    }
}
