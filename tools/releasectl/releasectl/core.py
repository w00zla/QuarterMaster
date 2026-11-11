"""Pure release logic: versions, products, channels.json, version bumps, the overview.

No Textual, no git, no network here: everything takes and returns plain
data, so it is covered by unit tests.

Quartermaster has two apps in one repository (the singleuser desktop app
`app` and the `companion`) that are versioned, tagged and channelled
separately, plus data releases (`data-<game label>-<n>`) that follow a
different scheme and are built locally. A `Product` describes one app; the
data releases have their own small helpers further down.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from functools import total_ordering

# Same shapes as the apps and CI: x.y.z (live) or x.y.z-<id>.<n> (channel).
_NUM = r"(0|[1-9][0-9]*)"
_ID = r"[a-z][a-z0-9-]{0,31}"
VERSION_RE = re.compile(rf"^{_NUM}\.{_NUM}\.{_NUM}(?:-({_ID})\.{_NUM})?$")
CHANNEL_ID_RE = re.compile(rf"^{_ID}$")

MAIN = "main"
BRANCH_PREFIX = "channel/"


# --- versions ---------------------------------------------------------------


@total_ordering
@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    channel: str | None = None  # None = live version
    n: int | None = None

    @classmethod
    def parse(cls, text: str, v_prefix: bool = True) -> Version | None:
        """Parse `x.y.z` or `x.y.z-<id>.<n>`, with or without a leading `v`
        (typed by a person). A tag with a product prefix goes through
        `Product.parse`, which allows no `v` of its own."""
        if v_prefix and text.startswith("v"):
            text = text[1:]
        m = VERSION_RE.match(text)
        if not m:
            return None
        major, minor, patch, channel, n = m.groups()
        if channel == "stable":
            return None
        return cls(int(major), int(minor), int(patch), channel,
                   int(n) if n is not None else None)

    @property
    def base(self) -> Version:
        return Version(self.major, self.minor, self.patch)

    @property
    def is_channel(self) -> bool:
        return self.channel is not None

    def __str__(self) -> str:
        core = f"{self.major}.{self.minor}.{self.patch}"
        return f"{core}-{self.channel}.{self.n}" if self.is_channel else core

    def _key(self) -> tuple:
        # Semver: a pre-release sorts before its release; pre-release
        # identifiers compare one by one, numeric < alphanumeric, numbers
        # numerically, strings in ASCII order.
        core = (self.major, self.minor, self.patch)
        if not self.is_channel:
            return core + (1, ())
        return core + (0, ((1, self.channel), (0, self.n)))

    def __lt__(self, other: Version) -> bool:
        return self._key() < other._key()


def validate_channel_id(text: str) -> str | None:
    """Return an error message, or None when `text` is a usable channel id."""
    if not CHANNEL_ID_RE.match(text):
        return "a-z first, then a-z 0-9 -, at most 32"
    if text == "stable":
        return "'stable' is built in"
    return None


def branch_of(channel_id: str) -> str:
    return BRANCH_PREFIX + channel_id


def next_minor(v: Version) -> Version:
    return Version(v.major, v.minor + 1, 0)


def live_proposal(latest: Version | None, newest_tag: Version | None) -> Version:
    """Propose a plain live bump: the next minor after the latest live
    release or the newest live tag, whichever is higher."""
    base = max((v for v in (latest, newest_tag) if v), default=None)
    return next_minor(base) if base else Version(0, 1, 0)


def next_channel_version(channel_id: str, existing: list[Version],
                         latest_live: Version | None) -> Version:
    """Propose the next version of a channel.

    The next n on the current base while that base is above the latest live
    version; otherwise (none yet, or the base was released) the next minor
    after the latest live version, n = 1.
    """
    own = sorted(v for v in existing if v.channel == channel_id)
    newest = own[-1] if own else None
    if newest and (latest_live is None or newest.base > latest_live):
        return Version(newest.major, newest.minor, newest.patch, channel_id,
                       newest.n + 1)
    start = next_minor(latest_live) if latest_live else Version(0, 1, 0)
    return Version(start.major, start.minor, start.patch, channel_id, 1)


def next_live(latest_live: Version | None, channel_version: Version | None) -> Version:
    """Propose the live version that finalizes a channel version: its base if that is
    above the latest live version, else the next minor."""
    if channel_version and (latest_live is None or channel_version.base > latest_live):
        return channel_version.base
    return next_minor(latest_live) if latest_live else Version(0, 1, 0)


# --- products ----------------------------------------------------------------

# How one file carries the version: a Cargo.toml (first `version = ` line), the
# Cargo.lock entry of the product's own package, a package.json (top level).
CARGO, LOCK, JSON = "cargo", "lock", "json"


@dataclass(frozen=True)
class Product:
    key: str  # the key in channels.json
    title: str  # in the UI and in tag messages
    tag_prefix: str  # `app-v`: the tag is the prefix plus the version
    workflow: str  # the CI workflow a tag push starts
    cargo_toml: str  # the version the product reports (Cargo.toml's package)
    cargo_package: str  # its package name in Cargo.lock
    files: tuple[tuple[str, str], ...]  # (path, kind) of everything that carries the version

    def tag(self, v: Version) -> str:
        return f"{self.tag_prefix}{v}"

    def parse(self, tag: str) -> Version | None:
        """The version of one of this product's tags, None for anything else
        (another product's tag, a data tag, a bare `v1.2.3`)."""
        if not tag.startswith(self.tag_prefix):
            return None
        return Version.parse(tag[len(self.tag_prefix):], v_prefix=False)


# Everything that must change together, read off the code: the app reports its
# Cargo.toml version (`CARGO_PKG_VERSION`; tauri.conf.json carries none), a Rust
# test keeps that equal to the root package.json (the version the server bundle
# carries), app/package.json mirrors it. The companion reports its Cargo.toml
# version and mirrors it in companion/package.json.
APP = Product(
    key="app", title="app", tag_prefix="app-v", workflow="build-app.yml",
    cargo_toml="app/src-tauri/Cargo.toml", cargo_package="quartermaster",
    files=(("app/src-tauri/Cargo.toml", CARGO), ("app/src-tauri/Cargo.lock", LOCK),
           ("package.json", JSON), ("app/package.json", JSON)))
COMPANION = Product(
    key="companion", title="companion", tag_prefix="companion-v", workflow="build-companion.yml",
    cargo_toml="companion/src-tauri/Cargo.toml", cargo_package="quartermaster-companion",
    files=(("companion/src-tauri/Cargo.toml", CARGO), ("companion/src-tauri/Cargo.lock", LOCK),
           ("companion/package.json", JSON)))

PRODUCTS = {p.key: p for p in (APP, COMPANION)}
DATA = "data"  # the third kind in channels.json and in the UI; not a Product


def product_of_tag(tag: str) -> Product | None:
    return next((p for p in PRODUCTS.values() if p.parse(tag)), None)


# --- bump (the version in the product's files) --------------------------------

# A live version is tagged only on main, a channel version only on channel/<id>.


def branch_guard(version: Version, branch: str) -> str | None:
    if not version.is_channel and branch != MAIN:
        return f"a live version is tagged on main, this is '{branch}'"
    if version.is_channel and branch != branch_of(version.channel):
        return (f"a {version.channel} version is tagged on "
                f"{branch_of(version.channel)}, this is '{branch}'")
    return None


_CARGO_VERSION_RE = re.compile(r'^version = "(.*)"$', re.M)


def cargo_toml_version(text: str) -> str | None:
    """The package version: the first `version = ` line of Cargo.toml."""
    m = _CARGO_VERSION_RE.search(text)
    return m.group(1) if m else None


def set_cargo_toml(text: str, current: str, new: str, package: str = "") -> str:
    line = f'version = "{current}"'
    pattern = re.compile(rf"^{re.escape(line)}$", re.M)
    return pattern.sub(f'version = "{new}"', text, count=1)


def set_cargo_lock(text: str, current: str, new: str, package: str) -> str:
    """The version line right after our own package's name."""
    pattern = re.compile(
        rf'^(name = "{re.escape(package)}"\n)version = "{re.escape(current)}"$', re.M)
    return pattern.sub(rf'\g<1>version = "{new}"', text, count=1)


def set_package_json(text: str, current: str, new: str, package: str = "") -> str:
    """The top-level version (two-space indent)."""
    pattern = re.compile(rf'^  "version": "{re.escape(current)}",$', re.M)
    return pattern.sub(f'  "version": "{new}",', text, count=1)


_SETTERS = {CARGO: set_cargo_toml, LOCK: set_cargo_lock, JSON: set_package_json}


def version_files(prod: Product) -> list[str]:
    return [path for path, _ in prod.files]


def bump_texts(prod: Product, texts: dict[str, str], new: str) -> dict[str, str]:
    """Set `new` in every version file of `prod`; raise ValueError if one
    stays unchanged or the files disagree on the current version.

    `texts` maps the paths of `prod.files` to their contents. The current
    version is the one in the product's Cargo.toml; every other file has to
    carry exactly that version, else it is not touched blindly.
    """
    current = cargo_toml_version(texts[prod.cargo_toml])
    if current is None:
        raise ValueError(f"no version line in {prod.cargo_toml}")
    if current == new:
        raise ValueError(f"the version is {new} already")
    out = {}
    for path, kind in prod.files:
        changed = _SETTERS[kind](texts[path], current, new, prod.cargo_package)
        if changed == texts[path] or f'"{new}"' not in changed:
            raise ValueError(f"{path} was not updated (it does not carry {current}?)")
        out[path] = changed
    return out


def commit_message(prod: Product, version: Version) -> str:
    return f"Bump {prod.title} version to {version}"


def tag_message(prod: Product, version: Version) -> str:
    return f"Quartermaster {prod.title} {version}"


# --- channels.json -----------------------------------------------------------
# { "app":       { "stable": "app-v1.0.0", "channels": [{ "id": "beta", "tag": "app-v1.1.0-beta.1" }] },
#   "companion": { the same },
#   "data":      { "stable": "data-4.10.2.12913470-1" } }
# CI writes it when a release is published; releasectl only removes a channel.

_TOP_ORDER = ("app", "companion", "data")
_SECTION_ORDER = ("stable", "channels")
_ENTRY_ORDER = ("id", "tag")


def load_channels(text: str | None) -> dict:
    """Parse channels.json; a missing file (None) is an empty document."""
    if text is None:
        return {}
    doc = json.loads(text)
    if not isinstance(doc, dict):
        raise ValueError("channels.json: expected an object")
    for key in (*PRODUCTS, DATA):
        section = doc.get(key)
        if section is None:
            continue
        if not isinstance(section, dict):
            raise ValueError(f"channels.json: '{key}' must be an object")
        if key == DATA:
            continue
        channels = section.get("channels", [])
        if not isinstance(channels, list):
            raise ValueError(f"channels.json: {key}.channels must be a list")
        for entry in channels:
            if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
                raise ValueError(f"channels.json: every {key} channel needs an id")
    return doc


def dump_channels(doc: dict) -> str:
    """Serialize with 2-space indent and a trailing newline; products first
    (app, companion, data), `stable` before `channels`, `id` before `tag`."""
    out: dict = {}
    for key in (*_TOP_ORDER, *(k for k in doc if k not in _TOP_ORDER)):
        if key not in doc:
            continue
        section = doc[key]
        if not isinstance(section, dict):
            out[key] = section
            continue
        ordered = {k: section[k] for k in _SECTION_ORDER if k in section}
        ordered.update({k: v for k, v in section.items() if k not in _SECTION_ORDER})
        if isinstance(ordered.get("channels"), list):
            entries = []
            for entry in ordered["channels"]:
                e = {k: entry[k] for k in _ENTRY_ORDER if k in entry}
                e.update({k: v for k, v in entry.items() if k not in _ENTRY_ORDER})
                entries.append(e)
            ordered["channels"] = entries
        out[key] = ordered
    return json.dumps(out, indent=2, ensure_ascii=False) + "\n"


def channel_entries(doc: dict, key: str) -> list[dict]:
    return (doc.get(key) or {}).get("channels") or []


def stable_of(doc: dict, key: str) -> str | None:
    """The `stable` tag of a product (or of `data`), None when there is none."""
    value = (doc.get(key) or {}).get("stable")
    return value if isinstance(value, str) else None


def find_channel(doc: dict, key: str, channel_id: str) -> dict | None:
    return next((e for e in channel_entries(doc, key) if e["id"] == channel_id), None)


def remove_channel(doc: dict, key: str, channel_id: str) -> dict:
    if find_channel(doc, key, channel_id) is None:
        raise KeyError(channel_id)
    new = copy.deepcopy(doc)
    new[key]["channels"] = [e for e in new[key]["channels"] if e["id"] != channel_id]
    return new


# --- overview ----------------------------------------------------------------

DRAFT, PRERELEASE, RELEASE, MISSING, UNKNOWN = (
    "draft", "pre-release", "release", "missing", "?")


def release_state(tag: str | None, releases: dict[str, str] | None) -> str:
    """`releases` maps tag -> state; None means GitHub could not be asked."""
    if tag is None:
        return ""
    if releases is None:
        return UNKNOWN
    return releases.get(tag, MISSING)


def versions_in(prod: Product, tags: set[str]) -> list[Version]:
    """The parsed versions of `prod`'s tags, ascending."""
    return sorted(v for v in map(prod.parse, tags) if v)


def latest_live(prod: Product, tags: set[str], releases: dict[str, str] | None) -> Version | None:
    """The highest live version published as a full release."""
    if releases is None:
        return None
    lives = [v for v in versions_in(prod, tags)
             if not v.is_channel and releases.get(prod.tag(v)) == RELEASE]
    return max(lives, default=None)


def versions_of(prod: Product, channel_id: str, tags: set[str]) -> list[Version]:
    return [v for v in versions_in(prod, tags) if v.channel == channel_id]


@dataclass
class ChannelRow:
    id: str
    listed: bool = False
    listed_tag: str | None = None
    listed_state: str = ""
    local: bool = False
    remote: bool = False
    ahead: int | None = None  # commits on the branch that main lacks
    behind: int | None = None  # commits on main the branch lacks
    newest: Version | None = None
    newest_state: str = ""
    warnings: list[str] = field(default_factory=list)

    @property
    def has_branch(self) -> bool:
        return self.local or self.remote

    @property
    def merged(self) -> bool:
        return self.has_branch and self.ahead == 0


def channel_warnings(prod: Product, row: ChannelRow, live: Version | None) -> list[str]:
    out = []
    base_of = row.newest or prod.parse(row.listed_tag or "")
    if live and base_of and base_of.is_channel and base_of.base <= live:
        out.append(f"base <= live {live}")
    if row.listed:
        tag_v = prod.parse(row.listed_tag or "")
        if tag_v is None or tag_v.channel != row.id:
            out.append("listed tag invalid")
        elif row.listed_state not in (PRERELEASE, UNKNOWN):
            out.append("listed tag unpublished")
        if not row.has_branch:
            out.append("listed, no branch")
        elif row.merged:
            out.append("merged, still listed")
    return out


def build_rows(prod: Product, doc: dict, tags: set[str], releases: dict[str, str] | None,
               local: set[str], remote: set[str],
               counts: dict[str, tuple[int, int]]) -> list[ChannelRow]:
    """One row per channel of `prod`: listed in channels.json, a channel/*
    branch (the branch is shared by both apps, so a fresh channel shows up
    for each), or a tag.

    `local` / `remote` are channel ids with a branch, `counts` maps an id to
    (ahead, behind) against main.
    """
    live = latest_live(prod, tags, releases)
    ids = {e["id"] for e in channel_entries(doc, prod.key)} | local | remote
    ids |= {v.channel for v in versions_in(prod, tags) if v.is_channel}
    rows = []
    for cid in sorted(ids):
        entry = find_channel(doc, prod.key, cid)
        own = versions_of(prod, cid, tags)
        row = ChannelRow(id=cid, local=cid in local, remote=cid in remote)
        if entry:
            row.listed = True
            row.listed_tag = entry.get("tag")
            row.listed_state = release_state(row.listed_tag, releases)
        row.ahead, row.behind = counts.get(cid, (None, None))
        if own:
            row.newest = own[-1]
            row.newest_state = release_state(prod.tag(row.newest), releases)
        row.warnings = channel_warnings(prod, row, live)
        rows.append(row)
    return rows


@dataclass
class LiveInfo:
    latest: Version | None  # newest full release
    newest_tag: Version | None  # newest live tag, whatever its release state
    newest_state: str
    stable: str | None = None  # the tag channels.json lists as stable


def build_live(prod: Product, doc: dict, tags: set[str],
               releases: dict[str, str] | None) -> LiveInfo:
    lives = [v for v in versions_in(prod, tags) if not v.is_channel]
    newest = lives[-1] if lives else None
    return LiveInfo(latest=latest_live(prod, tags, releases), newest_tag=newest,
                    newest_state=release_state(prod.tag(newest) if newest else None,
                                               releases),
                    stable=stable_of(doc, prod.key))


# --- drafts ------------------------------------------------------------------


@dataclass(frozen=True)
class Draft:
    tag: str
    kind: str  # "app", "companion" or "data"
    channel: str | None = None  # of a channel version

    @property
    def label(self) -> str:
        if self.kind == DATA:
            return "data"
        return f"{self.kind} " + (f"channel {self.channel}" if self.channel else "live")


def list_drafts(releases: dict[str, str] | None) -> list[Draft]:
    """Every draft release: per kind (app, companion, data) newest first."""
    found: list[Draft] = []
    for tag, state in (releases or {}).items():
        if state != DRAFT:
            continue
        prod = product_of_tag(tag)
        if prod:
            found.append(Draft(tag, prod.key, prod.parse(tag).channel))
        elif parse_data_tag(tag):
            found.append(Draft(tag, DATA))

    def newest_first(d: Draft):
        if d.kind == DATA:
            label, n = parse_data_tag(d.tag)
            return (_label_key(label), n)
        return PRODUCTS[d.kind].parse(d.tag)

    out: list[Draft] = []
    for kind in (*PRODUCTS, DATA):
        out += sorted((d for d in found if d.kind == kind), key=newest_first, reverse=True)
    return out


# --- data releases -----------------------------------------------------------

# The same shape as src/datapack/manifest.ts.
DATA_TAG_RE = re.compile(r"^data-([A-Za-z0-9][A-Za-z0-9._+-]*)-([1-9][0-9]*)$")
GAME_LABEL_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
# Release assets of a data release, named as manifest.ts names them.
MANIFEST_NAME = "manifest.json"
THUMBS_UPDATE_NAME = "thumbs-update.zip"
CATALOG_NAME = "catalog.json.gz"


def data_tag(label: str, n: int) -> str:
    return f"data-{label}-{n}"


def full_pack_name(label: str, n: int) -> str:
    return f"quartermaster-data-{label}-{n}.zip"


def parse_data_tag(tag: str) -> tuple[str, int] | None:
    m = DATA_TAG_RE.match(tag)
    return (m.group(1), int(m.group(2))) if m else None


def data_tags(tags: set[str]) -> list[str]:
    return sorted((t for t in tags if parse_data_tag(t)), key=lambda t: (parse_data_tag(t)[0], parse_data_tag(t)[1]))


def next_data_n(label: str, tags: set[str]) -> int:
    """The next re-issue number for a game label: one above the highest known."""
    known = [p[1] for p in map(parse_data_tag, tags) if p and p[0] == label]
    return max(known, default=0) + 1


_LABEL_IN_HEAD = re.compile(r'"game"\s*:\s*\{[^{}]*?"label"\s*:\s*"([^"]+)"')


def label_from_head(text: str) -> str | None:
    """The game label out of the start of a snapshot's JSON (the `game`
    object comes first and its label before the nested manifest)."""
    m = _LABEL_IN_HEAD.search(text)
    return m.group(1) if m else None


@dataclass
class DataInfo:
    stable: str | None  # data.stable of channels.json
    stable_state: str
    newest: str | None  # the highest data tag by game label and n
    newest_state: str


def build_data(doc: dict, tags: set[str], releases: dict[str, str] | None) -> DataInfo:
    stable = stable_of(doc, DATA)
    # The newest one across labels: labels are game versions, compare them naturally.
    ordered = sorted(data_tags(tags), key=lambda t: (_label_key(parse_data_tag(t)[0]), parse_data_tag(t)[1]))
    newest = ordered[-1] if ordered else None
    return DataInfo(stable, release_state(stable, releases), newest, release_state(newest, releases))


def _label_key(label: str) -> tuple:
    """`4.10.2.12913470` sorts numerically part by part."""
    return tuple((0, int(p)) if p.isdigit() else (1, p) for p in re.split(r"[.+-]", label))


def format_size(n: int) -> str:
    size = float(n)
    for unit in ("B", "KiB", "MiB", "GiB"):
        if size < 1024 or unit == "GiB":
            return f"{int(size)} B" if unit == "B" else f"{size:.1f} {unit}"
        size /= 1024
    return f"{n} B"


def pack_summary(manifest: dict, sizes: dict[str, int]) -> str:
    """What a built data release holds: tag, predecessor, the four assets with
    sizes and the delta (thumbs-update.zip with its new pictures)."""
    files = manifest["files"]
    lines = [f"tag        {manifest['tag']}",
             f"previous   {manifest.get('previous') or '- (first release)'}",
             f"game       {manifest['game']['label']} (build {manifest['game']['build']})"]
    for name, size in sizes.items():
        lines.append(f"  {name:<46} {format_size(size):>10}")
    thumbs = files["thumbs"]
    lines.append(f"delta      {format_size(sizes.get(thumbs['name'], thumbs['size']))} "
                 f"({thumbs['count']} new pictures in {thumbs['name']})")
    return "\n".join(lines)


def data_release_notes(manifest: dict) -> str:
    previous = manifest.get("previous")
    return (f"Data release for game version {manifest['game']['label']} (build "
            f"{manifest['game']['build']}), snapshot schema {manifest['schemaVersion']}.\n"
            + (f"Previous: {previous}\n" if previous else "First release: no predecessor.\n")
            + f"New thumbnails against the predecessor: {manifest['files']['thumbs']['count']}.\n")


# --- CI build runs -----------------------------------------------------------

# What `gh run view --json` reports for a job that has not started / ended.
_NO_TIME = "0001-01-01T00:00:00Z"


@dataclass
class StepRow:
    name: str
    state: str  # queued / running / success / failure / cancelled / skipped
    seconds: int | None  # run time so far or in total; None before the start


@dataclass
class JobRow:
    name: str
    state: str
    seconds: int | None
    steps: list[StepRow] = field(default_factory=list)

    @property
    def expanded(self) -> bool:
        """Its steps are shown: while it runs, and when it failed."""
        return self.state in ("running", "failure")


@dataclass
class RunView:
    state: str  # queued / running / success / failure / cancelled
    url: str
    jobs: list[JobRow]

    @property
    def done(self) -> bool:
        return self.state not in ("queued", "running")


def _state(status: str, conclusion: str) -> str:
    if status != "completed":
        return "running" if status == "in_progress" else "queued"
    return conclusion or "failure"


def _parse_time(text: str | None):
    from datetime import datetime
    if not text or text == _NO_TIME:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _timed(item: dict, now) -> tuple[str, str, int | None]:
    """(name, state, seconds) of a job or step; `now` times a running one."""
    start = _parse_time(item.get("startedAt"))
    end = _parse_time(item.get("completedAt")) or (now if start else None)
    seconds = int((end - start).total_seconds()) if start and end else None
    return (str(item.get("name", "?")), _state(item.get("status", ""), item.get("conclusion", "")),
            max(seconds, 0) if seconds is not None else None)


def parse_run(data: dict, now) -> RunView:
    """`gh run view --json status,conclusion,url,jobs` as rows, each job
    with its steps; `now` (an aware datetime) times what still runs."""
    jobs = []
    for job in data.get("jobs") or []:
        steps = sorted((s for s in job.get("steps") or [] if isinstance(s, dict)),
                       key=lambda s: s.get("number", 0))
        jobs.append(JobRow(*_timed(job, now), steps=[StepRow(*_timed(s, now)) for s in steps]))
    return RunView(_state(data.get("status", ""), data.get("conclusion", "")),
                   str(data.get("url", "")), jobs)


def duration(seconds: int | None) -> str:
    return "" if seconds is None else f"{seconds // 60}:{seconds % 60:02d}"
