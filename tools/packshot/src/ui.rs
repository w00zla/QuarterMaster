// The TUI: three views behind a tab bar. 1 Run: header (selection or progress), the to-render list or the workers
// (local and on nodes) with throughput, the image preview (Sixel/Kitty/iTerm2, else half blocks). 2 Sets: the sets
// with their runs, the selected run's result and images on the right, details on i. 3 Nodes: this box, connected
// nodes and coordinators, fetching runs and the live manifest, sending the add-on. Log and errors at the bottom,
// keys in the last line.
use std::collections::{HashMap, VecDeque};
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
use crate::cluster::NodeState;
use crate::engine::{Engine, Kind, Level, PHASES, Scope, Selection, default_run_name};
use crate::net::Role;
use crate::store::LIVE;

const ACCENT: Color = Color::Cyan;
const OK: Color = Color::Green;
const WARN: Color = Color::Yellow;
const BAD: Color = Color::Red;
const DIM: Color = Color::DarkGray;
const SEL_BG: Color = Color::Rgb(31, 58, 74);

#[derive(Clone, Copy, PartialEq)]
enum View {
    Run,
    Sets,
    Nodes,
}

/// Text input in the header line
enum Input {
    Filter,
    RunName(String),
    NewSet(String),
}

/// A question in the header line: Enter (or y) confirms, anything else goes back
enum Confirm {
    Overwrite,
    /// outdated nodes before the start: y sends the add-on, n starts without them
    Outdated(Vec<u64>),
    Quit,
    DeleteRun { id: String, text: String },
    DeleteSet(String),
    Adopt(String),
}

/// A row of the Sets view
#[derive(Clone, PartialEq)]
enum SetRow {
    Set(String),
    Run { set: String, id: String },
}

struct App {
    engine: Engine,
    picker: Picker,
    view: View,
    filter: String,
    scope: Scope,
    input: Option<Input>,
    sel: Selection,
    selected: usize,
    confirm: Option<Confirm>,
    /// run name for the next start (from --name, else asked at the start)
    name: String,
    preview: Option<((PathBuf, Option<SystemTime>), StatefulProtocol)>,
    /// position in the render history; None = always the latest
    history_pos: Option<usize>,
    errors_tab: bool,
    set_rows: Vec<SetRow>,
    set_sel: usize,
    details: bool,
    /// thumbnails of the selected run in the Sets view
    thumbs: HashMap<PathBuf, StatefulProtocol>,
    node_sel: usize,
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
    // Ask for the graphics protocol and cell size (after entering the alternate screen); else half blocks
    let mut picker = Picker::from_query_stdio().unwrap_or_else(|_| Picker::halfblocks());
    picker.set_background_color(Some(image::Rgba([22u8, 24, 28, 255])));
    let sel = engine.select(&args.filter, args.scope);
    let mut app = App {
        engine,
        picker,
        view: View::Run,
        filter: args.filter,
        scope: args.scope,
        input: None,
        sel,
        selected: 0,
        confirm: None,
        name: args.name,
        preview: None,
        history_pos: None,
        errors_tab: false,
        set_rows: Vec::new(),
        set_sel: 0,
        details: false,
        thumbs: HashMap::new(),
        node_sel: 0,
        sys: System::new().ok(),
        cpu: VecDeque::new(),
        rate: VecDeque::new(),
        last_sample: Instant::now() - Duration::from_secs(10),
        was_running: false,
        line: args.line,
        quit: false,
    };
    app.refresh_sets();
    let result = main_loop(&mut terminal, &mut app);
    app.engine.abort();
    if let Some(h) = app.engine.hub.as_mut() {
        h.close_all();
    }
    ratatui::restore();
    result
}

fn main_loop(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.quit {
        app.engine.tick();
        let running = app.engine.running();
        if app.was_running && !running {
            // run over: renders and failures changed
            app.refresh();
            app.refresh_sets();
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

    /// Rows of the Sets view: live first, then the experiments; each with its own runs, newest first
    fn refresh_sets(&mut self) {
        let mut names = self.engine.store.sets().unwrap_or_default();
        names.sort_by_key(|n| (n != LIVE, n.clone()));
        let mut rows = Vec::new();
        for n in names {
            rows.push(SetRow::Set(n.clone()));
            if let Ok(s) = self.engine.store.load_set(&n) {
                for id in s.runs.iter().rev() {
                    rows.push(SetRow::Run { set: n.clone(), id: id.clone() });
                }
            }
        }
        self.set_rows = rows;
        self.set_sel = self.set_sel.min(self.set_rows.len().saturating_sub(1));
        self.thumbs.clear();
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

    /// Rows of the Nodes view: (connection, host name); this box first with 0, configured coordinators that are not
    /// connected with 0 and their address
    fn node_rows(&self) -> Vec<(u64, String)> {
        let e = &self.engine;
        let mut rows = vec![(0, e.me.name.clone())];
        if let Some(h) = e.hub.as_ref() {
            let mut peers: Vec<_> = h.peers.iter().map(|p| (p.conn, p.hello.name.clone())).collect();
            peers.sort_by(|a, b| a.1.cmp(&b.1));
            rows.extend(peers);
            for addr in &h.cfg.coordinators {
                let name = h.addr_names.get(addr);
                let connected = name.is_some_and(|n| *n == e.me.name || h.peers.iter().any(|p| p.hello.name == *n)) || h.peers.iter().any(|p| p.outbound && p.addr == *addr);
                if !connected {
                    rows.push((0, addr.clone()));
                }
            }
        }
        rows
    }

    fn selected_conn(&self) -> Option<(u64, Role)> {
        let (conn, _) = self.node_rows().get(self.node_sel).cloned()?;
        let role = self.engine.hub.as_ref()?.peer(conn)?.hello.role?;
        Some((conn, role))
    }

    /// Start: name (asked unless --name), overwrite question, outdated nodes, then go
    fn start_flow(&mut self, step: u8) -> Result<()> {
        if self.sel.todo.is_empty() {
            return Ok(());
        }
        if step == 0 {
            let name = if self.name.is_empty() { default_run_name(&self.filter, self.scope) } else { self.name.clone() };
            self.input = Some(Input::RunName(name));
            return Ok(());
        }
        if step <= 1 && self.sel.overwrite > 0 {
            self.confirm = Some(Confirm::Overwrite);
            return Ok(());
        }
        if step <= 2 {
            let outdated: Vec<u64> = self.engine.connected_nodes().into_iter().filter(|(_, h)| self.engine.node_state(h) == NodeState::Outdated).map(|(c, _)| c).collect();
            if !outdated.is_empty() {
                self.confirm = Some(Confirm::Outdated(outdated));
                return Ok(());
            }
        }
        self.go(false)
    }

    /// Start the run; `with_outdated`: the outdated nodes got the add-on and join once they report it
    fn go(&mut self, with_outdated: bool) -> Result<()> {
        let nodes: Vec<String> = self
            .engine
            .connected_nodes()
            .into_iter()
            .filter(|(_, h)| match self.engine.node_state(h) {
                NodeState::Ready => true,
                NodeState::Outdated => with_outdated,
                NodeState::Incompatible => false,
            })
            .map(|(_, h)| h.name)
            .collect();
        let line = format!("{} --filter \"{}\" --scope {}", self.line, self.filter, self.scope.key());
        let name = self.name.clone();
        self.engine.start(&self.sel, line.trim(), &self.filter, self.scope, &name, nodes)?;
        self.history_pos = None;
        self.rate.clear();
        self.refresh_sets();
        Ok(())
    }

    fn report<T>(&mut self, what: &str, r: Result<T>) {
        if let Err(e) = r {
            self.engine.note(Level::Error, format!("{what}: {e:#}"));
        }
    }

    fn key(&mut self, code: KeyCode, mods: KeyModifiers) -> Result<()> {
        if let Some(c) = self.confirm.take() {
            let yes = matches!(code, KeyCode::Enter | KeyCode::Char('y'));
            match c {
                Confirm::Overwrite if yes => self.start_flow(2)?,
                Confirm::Outdated(conns) => match code {
                    KeyCode::Char('y') | KeyCode::Enter => {
                        for c in conns {
                            let r = self.engine.send_addon(c);
                            self.report("Add-on not sent", r);
                        }
                        self.go(true)?;
                    }
                    KeyCode::Char('n') => self.go(false)?,
                    _ => {}
                },
                Confirm::Quit if yes || code == KeyCode::Char('q') => self.quit = true,
                Confirm::DeleteRun { id, .. } if yes => {
                    let r = self.engine.store.delete_run(&id).map(|_| ());
                    self.report("Run not deleted", r);
                    let r = self.engine.reload_set();
                    self.report("Set not reloaded", r);
                    self.refresh();
                    self.refresh_sets();
                }
                Confirm::DeleteSet(name) if yes => {
                    let r = self.engine.store.delete_set(&name).map(|_| ());
                    self.report("Set not deleted", r);
                    let r = self.engine.reload_set();
                    self.report("Set not reloaded", r);
                    self.refresh();
                    self.refresh_sets();
                }
                Confirm::Adopt(name) if yes => {
                    match self.engine.store.adopt(&name) {
                        Ok(n) => self.engine.note(Level::Ok, format!("{n} runs of {name} appended to live")),
                        Err(e) => self.engine.note(Level::Error, format!("Not adopted: {e:#}")),
                    }
                    let r = self.engine.reload_set();
                    self.report("Set not reloaded", r);
                    self.refresh();
                    self.refresh_sets();
                }
                _ => {}
            }
            return Ok(());
        }
        if let Some(input) = self.input.as_mut() {
            let text = match input {
                Input::Filter => &mut self.filter,
                Input::RunName(s) | Input::NewSet(s) => s,
            };
            match code {
                KeyCode::Esc => {
                    if !matches!(input, Input::Filter) {
                        self.input = None;
                        return Ok(());
                    }
                    self.input = None;
                }
                KeyCode::Enter => {
                    let input = self.input.take().unwrap();
                    match input {
                        Input::Filter => {}
                        Input::RunName(n) => {
                            self.name = n.trim().to_string();
                            self.start_flow(1)?;
                            // --name only counts for the first run; later ones are asked again
                            self.name.clear();
                            return Ok(());
                        }
                        Input::NewSet(n) => {
                            let n = n.trim().to_string();
                            match self.engine.store.create_set(&n, LIVE) {
                                Ok(_) => self.engine.note(Level::Ok, format!("Set {n} created from live")),
                                Err(e) => self.engine.note(Level::Error, format!("Set not created: {e:#}")),
                            }
                            self.refresh_sets();
                            return Ok(());
                        }
                    }
                }
                KeyCode::Backspace => {
                    text.pop();
                }
                KeyCode::Char('u') if mods.contains(KeyModifiers::CONTROL) => text.clear(),
                KeyCode::Char(c) => text.push(c),
                _ => return Ok(()),
            }
            if matches!(self.input, Some(Input::Filter) | None) {
                self.selected = 0;
                self.refresh();
            }
            return Ok(());
        }
        let running = self.engine.running();
        // keys of every view
        match code {
            KeyCode::Char('1') => self.view = View::Run,
            KeyCode::Char('2') => {
                self.view = View::Sets;
                self.refresh_sets();
            }
            KeyCode::Char('3') => self.view = View::Nodes,
            KeyCode::Tab => {
                self.view = match self.view {
                    View::Run => View::Sets,
                    View::Sets => View::Nodes,
                    View::Nodes => View::Run,
                };
                if self.view == View::Sets {
                    self.refresh_sets();
                }
            }
            KeyCode::Char('e') => self.errors_tab = !self.errors_tab,
            KeyCode::Char('q') | KeyCode::Esc if running => self.confirm = Some(Confirm::Quit),
            KeyCode::Char('q') | KeyCode::Esc => self.quit = true,
            _ => match self.view {
                View::Run => self.key_run(code, running)?,
                View::Sets => self.key_sets(code, running),
                View::Nodes => self.key_nodes(code, running),
            },
        }
        Ok(())
    }

    fn key_run(&mut self, code: KeyCode, running: bool) -> Result<()> {
        let e = &mut self.engine;
        match code {
            KeyCode::Char('+') => e.max_renderers = (e.max_renderers + 1).min(16),
            KeyCode::Char('-') => e.max_renderers = e.max_renderers.saturating_sub(1).max(1),
            KeyCode::Char(']') => e.max_exporters = (e.max_exporters + 1).min(8),
            KeyCode::Char('[') => e.max_exporters = e.max_exporters.saturating_sub(1).max(1),
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
            _ if running => {}
            KeyCode::Char('/') | KeyCode::Char('f') => self.input = Some(Input::Filter),
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
            KeyCode::Enter => self.start_flow(0)?,
            _ => {}
        }
        Ok(())
    }

    fn key_sets(&mut self, code: KeyCode, running: bool) {
        let row = self.set_rows.get(self.set_sel).cloned();
        match code {
            KeyCode::Up => self.set_sel = self.set_sel.saturating_sub(1),
            KeyCode::Down => self.set_sel = (self.set_sel + 1).min(self.set_rows.len().saturating_sub(1)),
            KeyCode::PageUp => self.set_sel = self.set_sel.saturating_sub(20),
            KeyCode::PageDown => self.set_sel = (self.set_sel + 20).min(self.set_rows.len().saturating_sub(1)),
            KeyCode::Char('i') => self.details = !self.details,
            _ if running => {}
            KeyCode::Enter => {
                if let Some(SetRow::Set(n)) = row {
                    let r = self.engine.switch_set(&n);
                    self.report("Set not activated", r);
                    self.refresh();
                }
            }
            KeyCode::Char('n') => self.input = Some(Input::NewSet(String::new())),
            KeyCode::Char('l') => {
                let set = match row {
                    Some(SetRow::Set(n)) | Some(SetRow::Run { set: n, .. }) => n,
                    None => return,
                };
                if set != LIVE {
                    self.confirm = Some(Confirm::Adopt(set));
                }
            }
            KeyCode::Char('x') => match row {
                Some(SetRow::Run { set, id }) => {
                    let text = match self.engine.store.load_set(&set).and_then(|s| self.engine.store.removal_impact(&s, &id)) {
                        Ok((older, gone)) => format!("Delete run {id}? {set}: {older} images fall back to older runs, {gone} disappear."),
                        Err(e) => format!("Delete run {id}? ({e:#})"),
                    };
                    self.confirm = Some(Confirm::DeleteRun { id, text });
                }
                Some(SetRow::Set(n)) if n != LIVE => self.confirm = Some(Confirm::DeleteSet(n)),
                _ => {}
            },
            _ => {}
        }
    }

    fn key_nodes(&mut self, code: KeyCode, running: bool) {
        let n = self.node_rows().len();
        match code {
            KeyCode::Up => self.node_sel = self.node_sel.saturating_sub(1),
            KeyCode::Down => self.node_sel = (self.node_sel + 1).min(n.saturating_sub(1)),
            _ => {
                let Some((conn, role)) = self.selected_conn() else { return };
                match (code, role) {
                    (KeyCode::Char('h'), Role::Coordinator) if !running => {
                        if self.engine.fetch_runs(conn) == 0 {
                            self.engine.refresh_runs(conn);
                        }
                    }
                    (KeyCode::Char('m'), Role::Coordinator) => self.engine.fetch_manifest(conn),
                    (KeyCode::Char('r'), Role::Coordinator) => self.engine.refresh_runs(conn),
                    (KeyCode::Char('s'), Role::Node) => {
                        let r = self.engine.send_addon(conn);
                        self.report("Add-on not sent", r);
                    }
                    _ => {}
                }
            }
        }
    }

    /// The item of the preview: while running the history, else the selection (with an image), else the latest
    fn preview_target(&self) -> Option<usize> {
        let h = &self.engine.history;
        if let Some(p) = self.history_pos {
            return h.get(p).copied();
        }
        if !self.engine.running() {
            if let Some(&t) = self.sel.todo.get(self.selected) {
                if self.engine.has_render(t) {
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
    // thousands with a comma
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

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1e6)
}

/// "2026-11-03_19-12_name" -> "11-03 19:12"
fn run_date(id: &str) -> String {
    let d = id.get(5..10).unwrap_or("");
    let t = id.get(11..16).unwrap_or("").replace('-', ":");
    format!("{d} {t}")
}

fn boxed(title: impl Into<String>) -> Block<'static> {
    Block::bordered().border_style(Style::new().fg(DIM)).title(Span::styled(format!(" {} ", title.into()), Style::new().fg(ACCENT).add_modifier(Modifier::BOLD)))
}

fn draw(f: &mut Frame, app: &mut App) {
    let [tabs, rest, log, keys] = Layout::vertical([Constraint::Length(1), Constraint::Min(14), Constraint::Length(8), Constraint::Length(1)]).areas(f.area());
    draw_tabs(f, app, tabs);
    match app.view {
        View::Run => {
            let [head, middle] = Layout::vertical([Constraint::Length(5), Constraint::Min(9)]).areas(rest);
            let [left, right] = Layout::horizontal([Constraint::Min(50), Constraint::Length(48)]).areas(middle);
            draw_head(f, app, head);
            if app.engine.running() { draw_workers(f, app, left) } else { draw_list(f, app, left) }
            draw_preview(f, app, right);
        }
        View::Sets => draw_sets(f, app, rest),
        View::Nodes => draw_nodes(f, app, rest),
    }
    draw_log(f, app, log);
    draw_keys(f, app, keys);
}

fn draw_tabs(f: &mut Frame, app: &App, area: Rect) {
    let tab = |on: bool, s: &str| if on { Span::styled(format!(" {s} "), Style::new().fg(Color::Black).bg(ACCENT).bold()) } else { Span::styled(format!(" {s} "), Style::new().fg(DIM)) };
    let e = &app.engine;
    let nodes = e.connected_nodes();
    let ready = nodes.iter().filter(|(_, h)| e.node_state(h) == NodeState::Ready).count();
    let net = match e.hub.as_ref() {
        None => "local".to_string(),
        Some(h) => match &h.listen_error {
            Some(_) => format!("{} · not listening · nodes {ready}/{}", e.me.name, nodes.len()),
            None => format!("{} · nodes {ready}/{}", e.me.name, nodes.len()),
        },
    };
    let right = format!("target set {} · {net} ", e.set.name);
    let left = vec![tab(app.view == View::Run, "1 Run"), " ".into(), tab(app.view == View::Sets, "2 Sets"), " ".into(), tab(app.view == View::Nodes, "3 Nodes")];
    let [l, r] = Layout::horizontal([Constraint::Min(30), Constraint::Length(right.chars().count() as u16)]).areas(area);
    f.render_widget(Paragraph::new(Line::from(left)), l);
    f.render_widget(Paragraph::new(right).fg(DIM), r);
}

fn confirm_line(app: &App) -> Option<Line<'static>> {
    let warn = |s: String| Line::from(Span::styled(s, Style::new().fg(Color::Black).bg(WARN).bold()));
    match app.confirm.as_ref()? {
        Confirm::Overwrite => Some(warn(format!(" {} images in the set will be replaced.  Enter: go  ·  any other key: back ", num(app.sel.overwrite)))),
        Confirm::Outdated(c) => Some(warn(format!(" {} node(s) with another add-on.  y: send add-on and start  ·  n: start without them  ·  Esc: back ", c.len()))),
        Confirm::Quit => Some(warn(" A run is in progress.  Enter/q: abort and quit  ·  any other key: back ".into())),
        Confirm::DeleteRun { text, .. } => Some(warn(format!(" {text}  Enter: delete  ·  Esc: back "))),
        Confirm::DeleteSet(n) => Some(warn(format!(" Delete set {n} and its runs that no other set uses?  Enter: delete  ·  Esc: back "))),
        Confirm::Adopt(n) => Some(warn(format!(" Append the runs of {n} to live (nothing is rendered)?  Enter: adopt  ·  Esc: back "))),
    }
}

fn input_line(app: &App) -> Option<Line<'static>> {
    let (label, text) = match app.input.as_ref()? {
        Input::RunName(s) => ("Run name", s.clone()),
        Input::NewSet(s) => ("New set from live", s.clone()),
        Input::Filter => return None,
    };
    Some(Line::from(vec![
        Span::styled(format!(" {label}: "), Style::new().fg(DIM)),
        Span::styled(format!(" {text}▏ "), Style::new().fg(Color::Black).bg(ACCENT)),
        Span::styled("  Enter: ok  ·  Esc: back", Style::new().fg(DIM)),
    ]))
}

fn draw_head(f: &mut Frame, app: &App, area: Rect) {
    let e = &app.engine;
    let local = format!("Blender {} · Export {} · {} cores · Vulkan", e.max_renderers, e.max_exporters, e.cores);
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
            format!("  ·  {rate:.0}/min  ·  {local}  ·  {} Blender in all", e.total_slots()).into(),
        ];
        if e.paused {
            l1.push(Span::styled("  PAUSED: starts nothing new", Style::new().fg(WARN).bold()));
        }
        let run_id = e.record.as_ref().map(|r| r.id.as_str()).unwrap_or("");
        let l3 = confirm_line(app).unwrap_or_else(|| {
            Line::from(format!("Run {run_id} → set {}  ·  Filter: {}  ·  Scope: {}", e.set.name, if app.filter.is_empty() { "all" } else { &app.filter }, app.scope.label())).fg(DIM)
        });
        let block = boxed(format!("Run · target set {}", e.set.name));
        let inner = block.inner(area);
        f.render_widget(block, area);
        let [a, b, c] = Layout::vertical([Constraint::Length(1); 3]).areas(inner);
        f.render_widget(Paragraph::new(Line::from(l1)), a);
        f.render_widget(Gauge::default().ratio(pct.clamp(0.0, 1.0)).label("").gauge_style(Style::new().fg(if run.failed > 0 { WARN } else { OK }).bg(Color::Black)), b);
        f.render_widget(Paragraph::new(l3), c);
        return;
    }

    let s = &app.sel;
    let editing = matches!(app.input, Some(Input::Filter));
    let cursor = if editing { "▏" } else { "" };
    let filter_style = if editing { Style::new().fg(Color::Black).bg(ACCENT) } else { Style::new().fg(ACCENT) };
    let l1 = Line::from(vec![
        "Set ".fg(DIM),
        Span::styled(format!(" {} ", e.set.name), Style::new().fg(ACCENT)),
        "   Filter ".fg(DIM),
        Span::styled(format!(" {}{cursor} ", if app.filter.is_empty() && !editing { "all" } else { &app.filter }), filter_style),
        "   Scope ".fg(DIM),
        Span::styled(format!(" {} ", app.scope.label()), if app.scope == Scope::All { Style::new().fg(Color::Black).bg(WARN) } else { Style::new().fg(ACCENT) }),
        format!("   {local}").fg(DIM),
    ]);
    let mut l2 = vec![
        format!("{} matches: ", num(s.matched)).into(),
        Span::styled(format!("{} in the set", num(s.existing)), Style::new().fg(OK)),
        format!(" · {} missing · ", num(s.missing)).into(),
        Span::styled(format!("{} failed last time", num(s.failed)), Style::new().fg(if s.failed > 0 { BAD } else { DIM })),
        "  →  ".fg(DIM),
        Span::styled(format!("{} to render", num(s.todo.len())), Style::new().fg(ACCENT).bold()),
    ];
    if s.overwrite > 0 {
        l2.push(Span::styled(format!(", {} of them replaced", num(s.overwrite)), Style::new().fg(WARN)));
    }
    if let (Some(m), true) = (e.manifest.as_ref(), e.set.name == LIVE) {
        l2.push(format!("  ·  manifest of {} ({})", m.from, m.at.get(..16).unwrap_or(&m.at).replace('T', " ")).fg(DIM));
    }
    let l3 = confirm_line(app).or_else(|| input_line(app)).unwrap_or_else(|| match e.run.as_ref() {
        Some(run) => {
            let end = run.finished.map(|t| t.duration_since(run.started)).unwrap_or_default();
            Line::from(vec![
                Span::styled(if run.aborted { "Last run aborted: " } else { "Last run done: " }, Style::new().fg(DIM)),
                Span::styled(format!("{} ok", num(run.ok)), Style::new().fg(OK)),
                ", ".fg(DIM),
                Span::styled(format!("{} failed", num(run.failed)), Style::new().fg(if run.failed > 0 { BAD } else { DIM })),
                format!(" in {}", fmt_dur(end)).fg(DIM),
            ])
        }
        None => Line::from(""),
    });
    let block = boxed("Run · selection");
    let inner = block.inner(area);
    f.render_widget(block, area);
    f.render_widget(Paragraph::new(vec![l1, Line::from(l2), l3]), inner);
}

fn draw_list(f: &mut Frame, app: &mut App, area: Rect) {
    let block = boxed(format!("To render · {}", num(app.sel.todo.len())));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let h = inner.height as usize;
    if app.sel.todo.is_empty() {
        let hint = match app.scope {
            Scope::Missing => "Nothing missing in the filter.",
            Scope::Failed => "Nothing failed in the filter.",
            Scope::All => "No matches.",
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
            let (mark, color) = if e.failed_last(t) { ("✗", BAD) } else if e.has_render(t) { ("↻", WARN) } else { ("·", DIM) };
            let kind = format!("{}/{}", tg.kind, tg.sub_type);
            let ent_w = w.saturating_sub(4 + 34).clamp(20, 60);
            let mut line = Line::from(vec![
                Span::styled(format!(" {mark} "), Style::new().fg(color)),
                Span::raw(format!("{:<ent_w$.ent_w$} ", tg.entity)),
                Span::styled(format!("{:<28.28} ", kind), Style::new().fg(DIM)),
                Span::styled(tg.name().to_string(), Style::new().fg(DIM)),
            ]);
            if top + i == app.selected {
                line = line.style(Style::new().bg(SEL_BG));
            }
            line
        })
        .collect();
    f.render_widget(Paragraph::new(lines), inner);
}

fn draw_workers(f: &mut Frame, app: &App, area: Rect) {
    let e = &app.engine;
    let gone: Vec<String> = e
        .run
        .as_ref()
        .map(|r| r.nodes.iter().filter(|n| !e.connected_nodes().iter().any(|(_, h)| &h.name == *n)).cloned().collect())
        .unwrap_or_default();
    let rows = (e.workers.len() + gone.len()) as u16 + 5;
    let [top, bottom] = Layout::vertical([Constraint::Length(rows.max(6)), Constraint::Min(5)]).areas(area);
    let block = boxed("Workers");
    let inner = block.inner(top);
    f.render_widget(block, top);
    let mut lines = vec![Line::from(format!("{:<16}{:<8}{:<40}{:>8}{:>9}", "Node/id", "Phase", "Entity", "Block", "Time")).fg(DIM)];
    let mut ws: Vec<_> = e.workers.iter().collect();
    ws.sort_by_key(|w| (w.node.clone(), w.kind == Kind::Render, w.slot));
    for w in ws {
        let (phase, color) = if w.kind == Kind::Export { ("export", WARN) } else { ("render", ACCENT) };
        let current = w.current().map(|t| e.targets[t].entity.as_str()).unwrap_or("…");
        lines.push(Line::from(vec![
            Span::styled(format!("{:<16.15}", w.label()), Style::new().fg(color).bold()),
            Span::raw(format!("{phase:<8}")),
            Span::raw(format!("{current:<40.40}")),
            Span::styled(format!("{:>8}", format!("{}/{}", w.reported.len(), w.order.len())), Style::new().fg(DIM)),
            Span::raw(format!("{:>8.1}s", w.since.elapsed().as_secs_f64())),
        ]));
    }
    for n in gone {
        lines.push(Line::from(vec![Span::styled(format!("{n:<16.15}"), Style::new().fg(DIM)), Span::styled("—       not connected", Style::new().fg(DIM))]));
    }
    if let Some(run) = e.run.as_ref() {
        let (queued, ready) = run.waiting();
        let idle = e.workers.iter().filter(|w| w.kind == Kind::Render).count() < e.total_slots() && ready == 0 && queued > 0;
        lines.push(Line::from(vec![
            format!("{} entities waiting for export · {ready} blocks waiting for Blender · {} exported", num(queued), num(run.exported)).fg(DIM),
            if e.transferred > 0 { format!(" · {} to nodes", mb(e.transferred)).fg(DIM) } else { "".into() },
            if idle { Span::styled("  Blender waits for export: ] for more exports", Style::new().fg(WARN)) } else { "".into() },
        ]));
        // mean per phase from render.py; the largest highlighted (that is where the CPU time goes)
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
    spark(f, b, format!("CPU here: {} %", app.cpu.back().copied().unwrap_or(0)), &app.cpu, Some(100), OK);
}

fn draw_preview(f: &mut Frame, app: &mut App, area: Rect) {
    let title = match app.history_pos {
        Some(p) => format!("Preview · {}/{}", p + 1, app.engine.history.len()),
        None if app.engine.running() => "Preview · latest render".into(),
        None => "Preview".into(),
    };
    let block = boxed(title);
    let inner = block.inner(area);
    f.render_widget(block, area);
    let [img_area, text] = Layout::vertical([Constraint::Min(4), Constraint::Length(3)]).areas(inner);
    let Some(t) = app.preview_target() else {
        f.render_widget(Paragraph::new("no render yet").fg(DIM), inner);
        return;
    };
    let Some(png) = app.engine.image(t) else {
        f.render_widget(Paragraph::new("no render yet").fg(DIM), inner);
        return;
    };
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

fn draw_sets(f: &mut Frame, app: &mut App, area: Rect) {
    let [left, right] = Layout::horizontal([Constraint::Min(60), Constraint::Length(52)]).areas(area);
    let block = boxed("Sets and runs");
    let inner = block.inner(left);
    f.render_widget(block, left);
    let [list_area, foot] = Layout::vertical([Constraint::Min(3), Constraint::Length(1)]).areas(inner);
    let h = list_area.height as usize;
    let top = app.set_sel.saturating_sub(h.saturating_sub(1).min(h / 2)).min(app.set_rows.len().saturating_sub(h));
    let me = app.engine.me.name.clone();
    let active = app.engine.set.name.clone();
    let mut lines = vec![Line::from(format!("{:<44}{:<14}{:<18}{:>8}  {:<10}", "Set / run", "Node", "Filter", "Images", "Add-on")).fg(DIM)];
    let rows: Vec<SetRow> = app.set_rows.iter().skip(top).take(h.saturating_sub(1)).cloned().collect();
    for (i, row) in rows.iter().enumerate() {
        let mut line = match row {
            SetRow::Set(n) => {
                let s = app.engine.store.load_set(n).ok();
                let (runs, files) = s.as_ref().map(|s| (s.chain().count(), s.files.len())).unwrap_or_default();
                let base = s.as_ref().and_then(|s| s.base.clone()).map(|b| format!(" from {b}")).unwrap_or_default();
                let mut spans = vec![Span::styled(format!("▾ {n}"), Style::new().fg(ACCENT).bold()), base.fg(DIM)];
                if *n == active {
                    spans.push(Span::styled(" target ", Style::new().fg(OK)));
                }
                let used: usize = spans.iter().map(|s| s.content.chars().count()).sum();
                spans.push(format!("{:w$}{:<14}{:<18}{:>8}", "", format!("{runs} runs"), "", num(files), w = 44usize.saturating_sub(used)).fg(DIM));
                Line::from(spans)
            }
            SetRow::Run { id, .. } => {
                let r = app.engine.store.run(id).ok().cloned();
                let name = r.as_ref().map(|r| r.name.clone()).unwrap_or_default();
                let node = r.as_ref().map(|r| r.node.clone()).unwrap_or_default();
                let foreign = !node.is_empty() && node != me;
                let filter = r.as_ref().map(|r| r.origin["filter"].as_str().unwrap_or("").to_string()).unwrap_or_default();
                let images = r.as_ref().map(|r| r.entities.values().filter(|e| e.ok).count()).unwrap_or(0);
                let addon = r.as_ref().and_then(|r| r.origin["addon"].as_str().map(|s| s.chars().take(8).collect::<String>())).unwrap_or_default();
                let running = r.as_ref().is_some_and(|r| r.finished.is_none());
                let label = format!("    {}  {}", run_date(id), name);
                Line::from(vec![
                    Span::raw(format!("{label:<44.44}")),
                    Span::raw(format!("{:<14.14}", format!("{node}{}", if foreign { " ⇣" } else { "" }))),
                    Span::styled(format!("{:<18.18}", if filter.is_empty() { "all".into() } else { filter }), Style::new().fg(DIM)),
                    Span::raw(format!("{:>8}", num(images))),
                    Span::styled(format!("  {addon:<10}"), Style::new().fg(DIM)),
                    if running { Span::styled(" running", Style::new().fg(WARN)) } else { "".into() },
                ])
            }
        };
        if top + i == app.set_sel {
            line = line.style(Style::new().bg(SEL_BG));
        }
        lines.push(line);
    }
    f.render_widget(Paragraph::new(lines), list_area);
    let foot_line = confirm_line(app).or_else(|| input_line(app)).unwrap_or_else(|| Line::from("⇣ = run from another coordinator, fetched with h in view 3").fg(DIM));
    f.render_widget(Paragraph::new(foot_line), foot);

    // right: the selected run (or set)
    let row = app.set_rows.get(app.set_sel).cloned();
    match row {
        Some(SetRow::Run { id, .. }) => draw_run_detail(f, app, right, &id),
        Some(SetRow::Set(n)) => {
            let block = boxed(format!("Set {n}"));
            let inner = block.inner(right);
            f.render_widget(block, right);
            let s = app.engine.store.load_set(&n).ok();
            let mut lines = Vec::new();
            if let Some(s) = s {
                lines.push(Line::from(format!("Base       {}", s.base.clone().unwrap_or_else(|| "–".into()))));
                lines.push(Line::from(format!("Runs       {} own, {} from the base", s.runs.len(), s.base_runs.len())));
                lines.push(Line::from(format!("Images     {}", num(s.files.len()))));
                lines.push(Line::from(format!("Folder     {}", app.engine.store.set_dir(&n).display())).fg(DIM));
            }
            f.render_widget(Paragraph::new(lines), inner);
        }
        None => {}
    }
}

fn draw_run_detail(f: &mut Frame, app: &mut App, area: Rect, id: &str) {
    let block = boxed(format!("Run {}", run_date(id)));
    let inner = block.inner(area);
    f.render_widget(block, area);
    let Ok(r) = app.engine.store.run(id).cloned() else {
        f.render_widget(Paragraph::new("run.json not readable").fg(BAD), inner);
        return;
    };
    let ok = r.entities.values().filter(|e| e.ok).count();
    let failed = r.entities.len() - ok;
    let dur = match (chrono::DateTime::parse_from_rfc3339(&r.started), r.finished.as_deref().and_then(|f| chrono::DateTime::parse_from_rfc3339(f).ok())) {
        (Ok(a), Some(b)) => fmt_dur(Duration::from_secs((b - a).num_seconds().max(0) as u64)),
        _ => "running".into(),
    };
    let o = &r.origin;
    let s = |k: &str| o[k].as_str().unwrap_or("?").to_string();
    let row = |k: &str, v: String| Line::from(vec![Span::styled(format!("{k:<11}"), Style::new().fg(DIM)), Span::raw(v)]);
    let mut lines = vec![
        Line::from(Span::styled(r.name.clone(), Style::new().fg(ACCENT).bold())),
        row("Node", format!("{}{}", r.node, if r.node != app.engine.me.name { " (fetched)" } else { "" })),
        row("Selection", format!("{} · {}", if s("filter").is_empty() { "all".into() } else { s("filter") }, s("scope"))),
        row("Result", format!("{ok} ok · {failed} failed · {dur}{}", if r.aborted { " · aborted" } else { "" })),
    ];
    if app.details {
        let nodes: Vec<String> = o["nodes"].as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        lines.push(row("Add-on", s("addon")));
        lines.push(row("render.py", s("render_py")));
        lines.push(row("Blender", format!("{} · {}", s("blender_version"), s("gpu_backend"))));
        lines.push(row("StarBreaker", s("starbreaker")));
        let p4k_date = o["p4k_mtime"].as_i64().and_then(|t| chrono::DateTime::from_timestamp(t, 0)).map(|d| d.format("%Y-%m-%d").to_string()).unwrap_or_default();
        lines.push(row("p4k", format!("{:.1} GB · {p4k_date}", o["p4k_bytes"].as_f64().unwrap_or(0.0) / 1e9)));
        lines.push(row("Processes", format!("{} Blender, {} export{}", o["renderers"], o["exporters"], if nodes.is_empty() { String::new() } else { format!(" + {}", nodes.join(", ")) })));
        lines.push(row("Folder", app.engine.store.run_dir(id).display().to_string()).fg(DIM));
    }
    let text_h = lines.len() as u16 + 1;
    let [text, imgs] = Layout::vertical([Constraint::Length(text_h), Constraint::Min(3)]).areas(inner);
    f.render_widget(Paragraph::new(lines), text);
    // up to 8 images of the run
    let dir = app.engine.store.run_dir(id);
    let files: Vec<PathBuf> = r.entities.values().filter_map(|e| e.files.first()).take(8).map(|f| dir.join(f)).collect();
    if files.is_empty() || imgs.height < 3 {
        return;
    }
    let cols = 4u16;
    let rows_n = (files.len() as u16).div_ceil(cols).min((imgs.height / 5).max(1));
    let cell_w = imgs.width / cols;
    let cell_h = (imgs.height / rows_n).min(cell_w / 2 + 1);
    for (k, p) in files.iter().enumerate().take((rows_n * cols) as usize) {
        let (cx, cy) = (k as u16 % cols, k as u16 / cols);
        let cell = Rect { x: imgs.x + cx * cell_w, y: imgs.y + cy * cell_h, width: cell_w.saturating_sub(1), height: cell_h.saturating_sub(1) };
        if !app.thumbs.contains_key(p) {
            if let Ok(img) = image::open(p) {
                let proto = app.picker.new_resize_protocol(img);
                app.thumbs.insert(p.clone(), proto);
            }
        }
        if let Some(proto) = app.thumbs.get_mut(p) {
            f.render_stateful_widget(StatefulImage::default().resize(Resize::Fit(None)), cell, proto);
        }
    }
}

fn draw_nodes(f: &mut Frame, app: &mut App, area: Rect) {
    let [top, bottom] = Layout::vertical([Constraint::Min(6), Constraint::Length(9)]).areas(area);
    let e = &app.engine;
    let title = match e.hub.as_ref() {
        None => "Nodes · no cluster (no token in packshot.json)".to_string(),
        Some(h) => match &h.listen_error {
            Some(err) => format!("Nodes · {err}"),
            None => format!("Nodes · listening on {}", h.cfg.listen),
        },
    };
    let block = boxed(title);
    let inner = block.inner(top);
    f.render_widget(block, top);
    let cols = |a: &str, b: &str, c: &str, d: &str, g: &str, p: &str, q: &str| format!("{a:<14.13}{b:<14.13}{c:<16.15}{d:<18.17}{g:<9.8}{p:<10.9}{q}");
    let mut lines = vec![Line::from(cols("Node", "Role", "Connection", "Add-on", "Blender", "p4k", "Processes")).fg(DIM)];
    let rows = app.node_rows();
    for (i, (conn, name)) in rows.iter().enumerate() {
        let mut line = if i == 0 {
            Line::from(cols(name, "coordinator", "here", e.me.addon.as_deref().unwrap_or("?"), &e.me.blender, &e.me.p4k_bytes.map(|b| format!("{:.0} GB", b as f64 / 1e9)).unwrap_or_default(), &format!("{} Blender · {} export · {} cores", e.max_renderers, e.max_exporters, e.cores)))
        } else if let Some(p) = e.hub.as_ref().and_then(|h| h.peer(*conn)) {
            let h = &p.hello;
            let role = if h.role == Some(Role::Node) { "node" } else { "coordinator" };
            let state = e.node_state(h);
            let addon = format!("{}{}", h.addon.as_deref().unwrap_or("?"), if state == NodeState::Outdated { " old" } else { "" });
            let conn_s = if p.outbound { "connected ↗" } else { "connected ↙" };
            let mut l = Line::from(cols(name, role, conn_s, &addon, &h.blender, &h.p4k_bytes.map(|b| format!("{:.0} GB", b as f64 / 1e9)).unwrap_or_else(|| "–".into()), &format!("{} Blender · {} cores · {}", h.slots, h.cores, h.os)));
            if state != NodeState::Ready && h.role == Some(Role::Node) {
                l = l.fg(if state == NodeState::Outdated { WARN } else { BAD });
            }
            l
        } else {
            // a configured address: the host name once it answered there, else the address
            let label = e.hub.as_ref().and_then(|h| h.addr_names.get(name)).cloned().unwrap_or_else(|| name.clone());
            let err = e.hub.as_ref().and_then(|h| h.dial_errors.get(name)).cloned().unwrap_or_else(|| "not connected".into());
            let err = if label == *name { err } else { format!("{name}: {err}") };
            Line::from(vec![Span::raw(format!("{label:<14.13}{:<14}", "coordinator")), Span::styled(err, Style::new().fg(DIM))])
        };
        if i == app.node_sel {
            line = line.style(Style::new().bg(SEL_BG));
        }
        lines.push(line);
    }
    f.render_widget(Paragraph::new(lines), inner);

    let [l, r] = Layout::horizontal([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(bottom);
    // Sync with the selected coordinator
    let sel = rows.get(app.node_sel).cloned();
    let peer = sel.as_ref().and_then(|(c, _)| e.hub.as_ref().and_then(|h| h.peer(*c)));
    let title = format!("Sync · {}", sel.as_ref().map(|(_, n)| n.as_str()).unwrap_or(""));
    let block = boxed(title);
    let inner = block.inner(l);
    f.render_widget(block, l);
    let mut lines = Vec::new();
    match peer {
        Some(p) if p.hello.role == Some(Role::Coordinator) => {
            let runs = e.fetchable(&p.hello.name);
            let images: usize = runs.iter().map(|r| r.images).sum();
            let bytes: u64 = runs.iter().map(|r| r.bytes).sum();
            let known = e.peer_runs.get(&p.hello.name).map(|v| v.len()).unwrap_or(0);
            lines.push(Line::from(vec!["Fetch:     ".into(), Span::styled(format!("{} runs", runs.len()), Style::new().fg(ACCENT)), format!(" · {} images · {}  (of {known} runs there)", num(images), mb(bytes)).into()]));
            for r in runs.iter().take(3) {
                lines.push(Line::from(format!("           {}  {}", run_date(&r.id), r.name)).fg(DIM));
            }
            let m = match e.manifest.as_ref() {
                Some(m) => format!("{} entities from {} ({})", m.entities.values().filter(|v| **v).count(), m.from, m.at.get(..16).unwrap_or(&m.at).replace('T', " ")),
                None => "none".into(),
            };
            lines.push(Line::from(format!("Manifest:  {m}")));
            lines.push(Line::from(format!("Add-on:    {} has {}, here {}", p.hello.name, p.hello.addon.as_deref().unwrap_or("?"), e.me.addon.as_deref().unwrap_or("?"))));
        }
        Some(p) => {
            lines.push(Line::from(format!("Node {} · {} Blender · {}", p.hello.name, p.hello.slots, p.hello.os)));
            lines.push(Line::from(format!("Add-on:    {} there, {} here", p.hello.addon.as_deref().unwrap_or("?"), e.me.addon.as_deref().unwrap_or("?"))));
            lines.push(Line::from(format!("Blender:   {} there, {} here", p.hello.blender, e.me.blender)));
            lines.push(Line::from(format!("packshot:  {} there, {} here", p.hello.version, e.me.version)));
        }
        None => lines.push(Line::from("this box or not connected").fg(DIM)),
    }
    f.render_widget(Paragraph::new(lines), inner);

    let block = boxed("Before the next run");
    let inner = block.inner(r);
    f.render_widget(block, r);
    let mut lines = Vec::new();
    for (_, h) in e.connected_nodes() {
        match e.node_state(&h) {
            NodeState::Ready => lines.push(Line::from(vec![Span::styled(format!("{:<14}", h.name), Style::new().fg(OK)), format!("joins with {} Blender", h.slots).into()])),
            NodeState::Outdated => lines.push(Line::from(vec![Span::styled(format!("{:<14}", h.name), Style::new().fg(WARN)), "another add-on: asked at the start (or s)".into()])),
            NodeState::Incompatible => lines.push(Line::from(vec![Span::styled(format!("{:<14}", h.name), Style::new().fg(BAD)), format!("left out: packshot {} / Blender {}", h.version, h.blender).into()])),
        }
    }
    if lines.is_empty() {
        lines.push(Line::from("no node connected").fg(DIM));
    }
    f.render_widget(Paragraph::new(lines), inner);
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
    let running = app.engine.running();
    let keys: &[(&str, &str)] = if app.input.is_some() {
        &[("type", "text"), ("Ctrl+U", "clear"), ("Enter", "ok"), ("Esc", "back")]
    } else {
        match (app.view, running) {
            (View::Run, true) => &[("p", "pause"), ("+/-", "Blender"), ("[/]", "export"), ("←/→", "preview"), ("e", "log/errors"), ("Tab", "view"), ("q", "abort")],
            (View::Run, false) => &[("/", "filter"), ("x", "clear filter"), ("u", "scope"), ("↑↓", "list"), ("Enter", "start"), ("+/-", "Blender"), ("[/]", "export"), ("e", "log/errors"), ("Tab", "view"), ("q", "quit")],
            (View::Sets, true) => &[("↑↓", "set/run"), ("i", "details"), ("Tab", "view"), ("q", "abort")],
            (View::Sets, false) => &[("↑↓", "set/run"), ("Enter", "target set"), ("n", "new set"), ("l", "to live"), ("x", "delete"), ("i", "details"), ("Tab", "view"), ("q", "quit")],
            (View::Nodes, _) => &[("↑↓", "node"), ("h", "fetch runs"), ("m", "fetch manifest"), ("r", "refresh"), ("s", "send add-on"), ("Tab", "view"), ("q", if running { "abort" } else { "quit" })],
        }
    };
    let mut spans = Vec::new();
    for (k, v) in keys {
        spans.push(Span::styled(format!(" {k} "), Style::new().fg(Color::Black).bg(Color::Gray)));
        spans.push(Span::styled(format!(" {v}  "), Style::new().fg(DIM)));
    }
    f.render_widget(Paragraph::new(Line::from(spans)), area);
}
