// Ansicht A: Kopf (Auswahl bzw. Fortschritt), links Auswahl-Liste bzw. Worker und Durchsatz, rechts die
// Bildvorschau (Sixel/Kitty/iTerm2, sonst Halbblöcke), unten Log und Fehler, darunter die Tasten.
use std::collections::VecDeque;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

use anyhow::Result;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style, Stylize};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Gauge, Paragraph, Sparkline};
use ratatui::{DefaultTerminal, Frame};
use ratatui_image::picker::Picker;
use ratatui_image::protocol::StatefulProtocol;
use ratatui_image::{Resize, StatefulImage};
use sysinfo::System;

use crate::Args;
use crate::engine::{Engine, Kind, Level, PHASES, Scope, Selection};

const ACCENT: Color = Color::Cyan;
const OK: Color = Color::Green;
const WARN: Color = Color::Yellow;
const BAD: Color = Color::Red;
const DIM: Color = Color::DarkGray;

#[derive(PartialEq)]
enum Confirm {
    Start,
    Quit,
}

struct App {
    engine: Engine,
    picker: Picker,
    filter: String,
    scope: Scope,
    editing: bool,
    sel: Selection,
    selected: usize,
    confirm: Option<Confirm>,
    preview: Option<((PathBuf, Option<SystemTime>), StatefulProtocol)>,
    /// Position in der Render-Historie; None = immer das neueste
    history_pos: Option<usize>,
    errors_tab: bool,
    sys: Option<System>,
    cpu: VecDeque<u64>,
    rate: VecDeque<u64>,
    last_sample: Instant,
    was_running: bool,
    line: String,
    quit: bool,
}

pub fn run(engine: Engine, args: Args) -> Result<()> {
    let mut terminal = ratatui::init();
    // Grafikprotokoll und Zellgröße erfragen (nach dem Wechsel in den Alternate Screen); sonst Halbblöcke
    let mut picker = Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks());
    picker.set_background_color(Some(image::Rgba([22u8, 24, 28, 255])));
    let sel = engine.select(&args.filter, args.scope);
    let mut app = App {
        engine,
        picker,
        filter: args.filter,
        scope: args.scope,
        editing: false,
        sel,
        selected: 0,
        confirm: None,
        preview: None,
        history_pos: None,
        errors_tab: false,
        sys: System::new().ok(),
        cpu: VecDeque::new(),
        rate: VecDeque::new(),
        last_sample: Instant::now() - Duration::from_secs(10),
        was_running: false,
        line: args.line,
        quit: false,
    };
    let result = main_loop(&mut terminal, &mut app);
    app.engine.abort();
    ratatui::restore();
    result
}

fn main_loop(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.quit {
        app.engine.tick();
        let running = app.engine.running();
        if app.was_running && !running {
            // Lauf vorbei: Auswahl neu (Renders und Fehler haben sich geändert)
            app.refresh();
        }
        app.was_running = running;
        app.sample();
        terminal.draw(|f| draw(f, app))?;
        if event::poll(Duration::from_millis(100))? {
            if let Event::Key(k) = event::read()? {
                if k.kind == KeyEventKind::Press {
                    app.key(k.code, k.modifiers)?;
                }
            }
        }
    }
    Ok(())
}

impl App {
    fn refresh(&mut self) {
        self.sel = self.engine.select(&self.filter, self.scope);
        self.selected = self.selected.min(self.sel.todo.len().saturating_sub(1));
    }

    fn sample(&mut self) {
        if self.last_sample.elapsed() < Duration::from_secs(2) {
            return;
        }
        self.last_sample = Instant::now();
        if let Some(sys) = self.sys.as_mut() {
            sys.refresh_cpu_usage();
            push(&mut self.cpu, sys.global_cpu_usage().round() as u64);
        }
        if self.engine.running() {
            push(&mut self.rate, self.engine.rate(60.0).round() as u64);
        }
    }

    fn start(&mut self) -> Result<()> {
        if self.sel.todo.is_empty() {
            return Ok(());
        }
        self.engine.place_missing_icons(&self.filter);
        let line = format!("{} --filter \"{}\" --scope {}", self.line, self.filter, match self.scope {
            Scope::Missing => "missing",
            Scope::Failed => "failed",
            Scope::All => "all",
        });
        self.engine.start(&self.sel, line.trim(), &self.filter, self.scope)?;
        self.history_pos = None;
        self.rate.clear();
        Ok(())
    }

    fn key(&mut self, code: KeyCode, mods: KeyModifiers) -> Result<()> {
        if let Some(c) = self.confirm.take() {
            match (c, code) {
                (Confirm::Start, KeyCode::Enter) => self.start()?,
                (Confirm::Quit, KeyCode::Enter | KeyCode::Char('q')) => self.quit = true,
                _ => {}
            }
            return Ok(());
        }
        let running = self.engine.running();
        if self.editing {
            match code {
                KeyCode::Enter | KeyCode::Esc => self.editing = false,
                KeyCode::Backspace => {
                    self.filter.pop();
                }
                KeyCode::Char('u') if mods.contains(KeyModifiers::CONTROL) => self.filter.clear(),
                KeyCode::Char(c) => self.filter.push(c),
                _ => return Ok(()),
            }
            self.selected = 0;
            self.refresh();
            return Ok(());
        }
        let e = &mut self.engine;
        match code {
            KeyCode::Char('+') => e.max_renderers = (e.max_renderers + 1).min(16),
            KeyCode::Char('-') => e.max_renderers = e.max_renderers.saturating_sub(1).max(1),
            KeyCode::Char(']') => e.max_exporters = (e.max_exporters + 1).min(8),
            KeyCode::Char('[') => e.max_exporters = e.max_exporters.saturating_sub(1).max(1),
            KeyCode::Tab => self.errors_tab = !self.errors_tab,
            KeyCode::Left => {
                let n = e.history.len();
                if n > 0 {
                    self.history_pos = Some(self.history_pos.unwrap_or(n - 1).saturating_sub(1));
                }
            }
            KeyCode::Right => {
                if let Some(p) = self.history_pos {
                    self.history_pos = (p + 1 < e.history.len() - 1).then_some(p + 1);
                }
            }
            KeyCode::Char('p') if running => e.paused = !e.paused,
            KeyCode::Char('q') | KeyCode::Esc if running => self.confirm = Some(Confirm::Quit),
            KeyCode::Char('q') | KeyCode::Esc => self.quit = true,
            _ if running => {}
            KeyCode::Char('/') | KeyCode::Char('f') => self.editing = true,
            KeyCode::Char('u') => {
                self.scope = self.scope.next();
                self.selected = 0;
                self.refresh();
            }
            KeyCode::Char('x') => {
                self.filter.clear();
                self.refresh();
            }
            KeyCode::Up => self.selected = self.selected.saturating_sub(1),
            KeyCode::Down => self.selected = (self.selected + 1).min(self.sel.todo.len().saturating_sub(1)),
            KeyCode::PageUp => self.selected = self.selected.saturating_sub(20),
            KeyCode::PageDown => self.selected = (self.selected + 20).min(self.sel.todo.len().saturating_sub(1)),
            KeyCode::Home => self.selected = 0,
            KeyCode::End => self.selected = self.sel.todo.len().saturating_sub(1),
            KeyCode::Enter if !self.sel.todo.is_empty() => {
                if self.sel.overwrite > 0 {
                    self.confirm = Some(Confirm::Start);
                } else {
                    self.start()?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    /// Das Item der Vorschau: beim Lauf die Historie, sonst die Auswahl (mit Render), sonst das zuletzt gerenderte
    fn preview_target(&self) -> Option<usize> {
        let h = &self.engine.history;
        if let Some(p) = self.history_pos {
            return h.get(p).copied();
        }
        if !self.engine.running() {
            if let Some(&t) = self.sel.todo.get(self.selected) {
                if self.engine.has_render[t] {
                    return Some(t);
                }
            }
        }
        h.back().copied()
    }
}

fn push(q: &mut VecDeque<u64>, v: u64) {
    q.push_back(v);
    while q.len() > 120 {
        q.pop_front();
    }
}

fn fmt_dur(d: Duration) -> String {
    let s = d.as_secs();
    if s >= 3600 { format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60) } else { format!("{}:{:02}", s / 60, s % 60) }
}

fn num(n: usize) -> String {
    // Tausender mit Komma wie im Englischen
    let s = n.to_string();
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    out
}

fn boxed(title: impl Into<String>) -> Block<'static> {
    Block::bordered().border_style(Style::new().fg(DIM)).title(Span::styled(format!(" {} ", title.into()), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)))
}

fn draw(f: &mut Frame, app: &mut App) {
    let [head, middle, log, keys] = Layout::vertical([Constraint::Length(5), Constraint::Min(12), Constraint::Length(9), Constraint::Length(1)]).areas(f.area());
    let [left, right] = Layout::horizontal([Constraint::Min(50), Constraint::Length(48)]).areas(middle);
    draw_head(f, app, head);
    if app.engine.running() { draw_workers(f, app, left) } else { draw_list(f, app, left) }
    draw_preview(f, app, right);
    draw_log(f, app, log);
    draw_keys(f, app, keys);
}

fn draw_head(f: &mut Frame, app: &App, area: Rect) {
    let e = &app.engine;
    let workers = format!("Blender {} · Export {} · {} cores · Vulkan", e.max_renderers, e.max_exporters, e.cores);
    if let (true, Some(run)) = (e.running(), e.run.as_ref()) {
        let done = run.done();
        let pct = if run.total > 0 { done as f64 / run.total as f64 } else { 0.0 };
        let rate = e.rate(120.0);
        let eta = if rate > 0.1 { fmt_dur(Duration::from_secs_f64((run.total - done) as f64 / rate * 60.0)) } else { "–".into() };
        let mut l1 = vec![
            Span::styled(format!("{}/{}", num(done), num(run.total)), Style::new().fg(ACCENT).bold()),
            format!("  {:.1} %  ·  ok ", pct * 100.0).into(),
            Span::styled(num(run.ok), Style::new().fg(OK)),
            "  failed ".into(),
            Span::styled(num(run.failed), Style::new().fg(if run.failed > 0 { BAD } else { DIM })),
            format!("  ·  {} elapsed  ·  ETA ", fmt_dur(run.started.elapsed())).into(),
            Span::styled(eta, Style::new().fg(ACCENT)),
            format!("  ·  {rate:.0}/min  ·  {workers}").into(),
        ];
        if e.paused {
            l1.push(Span::styled("  PAUSED: starts nothing new", Style::new().fg(WARN).bold()));
        }
        let filter = format!("Filter: {}  ·  Scope: {}", if app.filter.is_empty() { "all" } else { &app.filter }, app.scope.label());
        let block = boxed("packshot · run");
        let inner = block.inner(area);
        f.render_widget(block, area);
        let [a, b, c] = Layout::vertical([Constraint::Length(1); 3]).areas(inner);
        f.render_widget(Paragraph::new(Line::from(l1)), a);
        f.render_widget(Gauge::default().ratio(pct.clamp(0.0, 1.0)).label("").gauge_style(Style::new().fg(if run.failed > 0 { WARN } else { OK }).bg(Color::Black)), b);
        f.render_widget(Paragraph::new(filter).fg(DIM), c);
        return;
    }

    let s = &app.sel;
    let cursor = if app.editing { "▏" } else { "" };
    let filter_style = if app.editing { Style::new().fg(Color::Black).bg(ACCENT) } else { Style::new().fg(ACCENT) };
    let l1 = Line::from(vec![
        "Filter ".fg(DIM),
        Span::styled(format!(" {}{cursor} ", if app.filter.is_empty() && !app.editing { "all" } else { &app.filter }), filter_style),
        "   Scope ".fg(DIM),
        Span::styled(format!(" {} ", app.scope.label()), if app.scope == Scope::All { Style::new().fg(Color::Black).bg(WARN) } else { Style::new().fg(ACCENT) }),
        format!("   {workers}").fg(DIM),
    ]);
    let mut l2 = vec![
        format!("{} matches: ", num(s.matched)).into(),
        Span::styled(format!("{} with render", num(s.existing)), Style::new().fg(OK)),
        format!(" · {} without · ", num(s.missing)).into(),
        Span::styled(format!("{} failed last time", num(s.failed)), Style::new().fg(if s.failed > 0 { BAD } else { DIM })),
        "  →  ".fg(DIM),
        Span::styled(format!("{} to render", num(s.todo.len())), Style::new().fg(ACCENT).bold()),
    ];
    if s.overwrite > 0 {
        l2.push(Span::styled(format!(", {} of them overwritten", num(s.overwrite)), Style::new().fg(WARN)));
    }
    let l3 = match (&app.confirm, app.engine.run.as_ref()) {
        (Some(Confirm::Start), _) => Line::from(Span::styled(
            format!(" {} existing renders will be overwritten.  Enter: go  ·  any other key: back ", num(s.overwrite)),
            Style::new().fg(Color::Black).bg(WARN).bold(),
        )),
        (_, Some(run)) => {
            let end = run.finished.map(|t| t.duration_since(run.started)).unwrap_or_default();
            Line::from(vec![
                Span::styled(if run.aborted { "Last run aborted: " } else { "Last run done: " }, Style::new().fg(DIM)),
                Span::styled(format!("{} ok", num(run.ok)), Style::new().fg(OK)),
                ", ".fg(DIM),
                Span::styled(format!("{} failed", num(run.failed)), Style::new().fg(if run.failed > 0 { BAD } else { DIM })),
                format!(" in {}", fmt_dur(end)).fg(DIM),
                if run.failed > 0 { "  ·  u to “failed last time” for a rerun".fg(DIM) } else { "".into() },
            ])
        }
        _ => Line::from(""),
    };
    let block = boxed("packshot · selection");
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(vec![l1, Line::from(l2), l3]), inner);
}

fn draw_list(f: &mut Frame, app: &mut App, area: Rect) {
    let block = boxed(&format!("To render · {}", num(app.sel.todo.len())));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let h = inner.height as usize;
    if app.sel.todo.is_empty() {
        let hint = match app.scope {
            Scope::Missing => "Nothing missing in the filter. u: change scope, / : change filter",
            Scope::Failed => "Nothing failed in the filter. u: change scope",
            Scope::All => "No matches. / : change filter, x: clear filter",
        };
        f.render_widget(Paragraph::new(hint).fg(DIM), inner);
        return;
    }
    let top = app.selected.saturating_sub(h.saturating_sub(1).min(h / 2)).min(app.sel.todo.len().saturating_sub(h));
    let e = &app.engine;
    let w = inner.width as usize;
    let lines: Vec<Line> = app.sel.todo[top..(top + h).min(app.sel.todo.len())]
        .iter()
        .enumerate()
        .map(|(i, &t)| {
            let tg = &e.targets[t];
            let (mark, color) = if e.failed_last(t) { ("✗", BAD) } else if e.has_render[t] { ("↻", WARN) } else { ("·", DIM) };
            let kind = format!("{}/{}", tg.kind, tg.sub_type);
            let ent_w = w.saturating_sub(4 + 34).clamp(20, 60);
            let mut line = Line::from(vec![
                Span::styled(format!(" {mark} "), Style::new().fg(color)),
                Span::raw(format!("{:<ent_w$.ent_w$} ", tg.entity)),
                Span::styled(format!("{:<28.28} ", kind), Style::new().fg(DIM)),
                Span::styled(tg.name().to_string(), Style::new().fg(DIM)),
            ]);
            if top + i == app.selected {
                line = line.style(Style::new().bg(Color::Rgb(31, 58, 74)));
            }
            line
        })
        .collect();
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_workers(f: &mut Frame, app: &App, area: Rect) {
    let e = &app.engine;
    let rows = e.workers.len() as u16 + 5;
    let [top, bottom] = Layout::vertical([Constraint::Length(rows.max(6)), Constraint::Min(5)]).areas(area);
    let block = boxed("Worker");
    let inner = block.inner(top);
    f.render_widget(block, top);
    let mut lines = vec![Line::from(format!("{:<4}{:<8}{:<44}{:>8}{:>9}", "id", "Phase", "Entity", "Block", "Time")).fg(DIM)];
    let mut ws: Vec<_> = e.workers.iter().collect();
    ws.sort_by_key(|w| (w.kind == Kind::Render, w.slot));
    for w in ws {
        let (phase, color) = if w.kind == Kind::Export { ("export", WARN) } else { ("render", ACCENT) };
        let current = w.current().map(|t| e.targets[t].entity.as_str()).unwrap_or("…");
        lines.push(Line::from(vec![
            Span::styled(format!("{:<4}", w.label()), Style::new().fg(color).bold()),
            Span::raw(format!("{phase:<8}")),
            Span::raw(format!("{current:<44.44}")),
            Span::styled(format!("{:>8}", format!("{}/{}", w.reported.len(), w.order.len())), Style::new().fg(DIM)),
            Span::raw(format!("{:>8.1}s", w.since.elapsed().as_secs_f64())),
        ]));
    }
    if let Some(run) = e.run.as_ref() {
        let (queued, ready) = run.waiting_blocks();
        let idle = e.workers.iter().filter(|w| w.kind == Kind::Render).count() < e.max_renderers && ready == 0 && queued > 0;
        lines.push(Line::from(vec![
            format!("Blocks: {queued} waiting for export · {ready} exported, waiting for Blender · {} exported", num(run.exported)).fg(DIM),
            if idle { Span::styled("  Blender waits for export: ] for more exports", Style::new().fg(WARN)) } else { "".into() },
        ]));
        // Mittel je Phase aus render.py; die größte hervorgehoben (dort geht die CPU-Zeit hin)
        let mut spans = vec!["Avg per render: ".fg(DIM)];
        match run.phase_avg() {
            Some(avg) => {
                let max = avg.iter().copied().fold(0.0, f64::max);
                for (k, v) in PHASES.iter().zip(avg) {
                    let style = if v == max && v > 0.0 { Style::new().fg(WARN).bold() } else { Style::new() };
                    spans.push(Span::styled(format!("{k} {v:.2} s"), style));
                    spans.push("  ".into());
                }
            }
            None => spans.push("no timings yet".fg(DIM)),
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines), inner);

    let block = boxed("Throughput and CPU");
    let inner = block.inner(bottom);
    f.render_widget(block, bottom);
    let [a, b] = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).spacing(2).areas(inner);
    let spark = |f: &mut Frame, r: Rect, title: String, data: &VecDeque<u64>, max: Option<u64>, color: Color| {
        let [t, s] = Layout::vertical([Constraint::Length(1), Constraint::Min(1)]).areas(r);
        f.render_widget(Paragraph::new(title).fg(DIM), t);
        let v: Vec<u64> = data.iter().copied().skip(data.len().saturating_sub(s.width as usize)).collect();
        let mut sp = Sparkline::default().data(&v).style(Style::new().fg(color));
        if let Some(m) = max {
            sp = sp.max(m);
        }
        f.render_widget(sp, s);
    };
    spark(f, a, format!("Renders/min (60 s): {:.0}", e.rate(60.0)), &app.rate, None, ACCENT);
    spark(f, b, format!("CPU: {} %", app.cpu.back().copied().unwrap_or(0)), &app.cpu, Some(100), OK);
}

fn draw_preview(f: &mut Frame, app: &mut App, area: Rect) {
    let title = match app.history_pos {
        Some(p) => format!("Preview · {}/{}", p + 1, app.engine.history.len()),
        None if app.engine.running() => "Preview · latest render".into(),
        None => "Preview".into(),
    };
    let block = boxed(&title);
    let inner = block.inner(area);
    f.render_widget(block, area);
    let [img_area, text] = Layout::vertical([Constraint::Min(4), Constraint::Length(3)]).areas(inner);
    let Some(t) = app.preview_target() else {
        f.render_widget(Paragraph::new("no render yet").fg(DIM), inner);
        return;
    };
    let png = app.engine.render_png(t);
    let key = (png.clone(), std::fs::metadata(&png).and_then(|m| m.modified()).ok());
    if app.preview.as_ref().map(|(k, _)| k) != Some(&key) {
        app.preview = image::open(&png).ok().map(|img| (key, app.picker.new_resize_protocol(img)));
    }
    if let Some((_, proto)) = app.preview.as_mut() {
        f.render_stateful_widget(StatefulImage::default().resize(Resize::Fit(None)), img_area, proto);
    } else {
        f.render_widget(Paragraph::new("image not readable").fg(BAD), img_area);
    }
    let tg = &app.engine.targets[t];
    let rig = app.engine.pose_rig(t).ok().map(|(p, r)| {
        let rig = r.file_stem().map(|s| s.to_string_lossy().replace("inventorylightgroup_", "")).unwrap_or_default();
        format!("pose {},{},{} · rig {rig}", p[0], p[1], p[2])
    });
    f.render_widget(
        Paragraph::new(vec![
            Line::from(Span::styled(tg.name().to_string(), Style::new().fg(ACCENT).bold())),
            Line::from(format!("{} · {}/{}", tg.entity, tg.kind, tg.sub_type)).fg(DIM),
            Line::from(rig.unwrap_or_default()).fg(DIM),
        ]),
        text,
    );
}

fn draw_log(f: &mut Frame, app: &App, area: Rect) {
    let e = &app.engine;
    let tab = |on: bool, s: String| if on { Span::styled(format!(" {s} "), Style::new().fg(Color::Black).bg(ACCENT)) } else { Span::styled(format!(" {s} "), Style::new().fg(DIM)) };
    let block = Block::bordered()
        .border_style(Style::new().fg(DIM))
        .title(Line::from(vec![" ".into(), tab(!app.errors_tab, "Log".into()), tab(app.errors_tab, format!("Errors {}", e.errors.len())), " ".into()]));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let h = inner.height as usize;
    let lines: Vec<Line> = if app.errors_tab {
        e.errors
            .iter()
            .rev()
            .take(h)
            .rev()
            .map(|(t, err)| Line::from(vec![Span::styled(format!("{}  ", e.targets[*t].entity), Style::new().fg(BAD)), Span::raw(err.clone())]))
            .collect()
    } else {
        e.log
            .iter()
            .rev()
            .take(h)
            .rev()
            .map(|l| {
                let color = match l.level {
                    Level::Ok => Color::Reset,
                    Level::Error => BAD,
                    Level::Info => ACCENT,
                };
                Line::from(vec![Span::styled(format!("{} ", l.time), Style::new().fg(DIM)), Span::styled(l.text.clone(), Style::new().fg(color))])
            })
            .collect()
    };
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_keys(f: &mut Frame, app: &App, area: Rect) {
    let keys: &[(&str, &str)] = if app.editing {
        &[("type", "filter (terms separated by blanks = OR)"), ("Ctrl+U", "clear"), ("Enter/Esc", "done")]
    } else if app.engine.running() {
        &[("p", "pause"), ("+/-", "Blender"), ("[/]", "export"), ("←/→", "browse preview"), ("Tab", "log/errors"), ("q", "abort")]
    } else {
        &[("/", "filter"), ("x", "clear filter"), ("u", "scope"), ("↑↓", "list"), ("Enter", "start"), ("+/-", "Blender"), ("[/]", "export"), ("Tab", "log/errors"), ("q", "quit")]
    };
    let mut spans = Vec::new();
    for (k, v) in keys {
        spans.push(Span::styled(format!(" {k} "), Style::new().fg(Color::Black).bg(Color::Gray)));
        spans.push(Span::styled(format!(" {v}  "), Style::new().fg(DIM)));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}
