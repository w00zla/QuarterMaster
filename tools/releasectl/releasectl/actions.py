"""The write actions. Each one shows its commands and waits for a yes first.

Rules kept here: no force, no history rewrite, no tag or release deletion,
no branch switch on a dirty tree, back to the starting branch afterwards.
Pushes, GitHub release edits and commits on main get their own confirmation.

Most actions work on the active app (`ctx.product`: app or companion); the
data release is a third kind with its own action.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from . import core, repo
from .core import DATA, MAIN, Product, Version, branch_of


@dataclass
class FileWrite:
    """A file written by the tool itself, shown like a command."""
    path: str
    text: str
    label: str


Cmd = list[str] | FileWrite


def show(cmd: Cmd) -> str:
    if isinstance(cmd, FileWrite):
        return f"write {cmd.path}  ({cmd.label})"
    return shlex.join(cmd)


class Ctx(Protocol):
    root: Path
    dry_run: bool
    product: str  # the active app: a key of core.PRODUCTS
    snap: repo.Snapshot

    def note(self, text: str, style: str = "") -> None: ...
    def selected(self) -> core.ChannelRow | None: ...
    def selected_draft(self) -> str | None: ...
    async def confirm(self, title: str, cmds: list[Cmd], note: str = "",
                      sensitive: bool = False) -> bool: ...
    async def ask(self, title: str, prompt: str, value: str = "",
                  validate=None) -> str | None: ...
    async def pick(self, title: str, options: list[str]) -> str | None: ...
    async def execute(self, cmd: Cmd) -> tuple[bool, str]: ...
    async def suspended(self, title: str, func) -> None: ...
    def watch_build(self, tag: str, workflow: str) -> None: ...


class Stop(Exception):
    """Ends an action with a message in the log."""


def prod_of(ctx: Ctx) -> Product:
    return core.PRODUCTS[ctx.product]


def view_of(ctx: Ctx) -> repo.ProductView:
    return ctx.snap.view(ctx.product)


async def run_all(ctx: Ctx, cmds: list[Cmd]) -> bool:
    for cmd in cmds:
        ok, _ = await ctx.execute(cmd)
        if not ok:
            return False
    return True


# --- branch handling ---------------------------------------------------------


def dirty_stop(ctx: Ctx, message: str) -> None:
    """Stop on a dirty tree; a dry run only notes it and carries on."""
    if not ctx.dry_run:
        raise Stop(message)
    ctx.note(f"[dry-run] would stop here: {message}", "yellow")


async def switch_to(ctx: Ctx, target: str, why: str) -> str | None:
    """Check out `target` (after a yes); the branch to return to, or None."""
    start = repo.current_branch(ctx.root)
    if start == target:
        return start
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, f"Working tree has changes; commit or stash before {why}.")
    back = f"afterwards: git checkout {start}"
    if not await ctx.confirm(f"Switch to {target}", [["git", "checkout", target]],
                             note=back):
        return None
    if not await run_all(ctx, [["git", "checkout", target]]):
        raise Stop(f"Could not check out {target}.")
    return start


async def switch_back(ctx: Ctx, start: str, target: str) -> None:
    if start != target:
        await ctx.execute(["git", "checkout", start])


async def pull(ctx: Ctx, branch: str) -> None:
    """Pull the checked-out `branch` from origin. A plain pull: CI commits
    to main after a publish (channels.json, README), so a local main often
    has diverged; git merges or rebases as configured. On a conflict the
    pull is undone and reported."""
    ok, _ = await ctx.execute(["git", "pull", "--no-edit", "origin", branch])
    if ok:
        return
    pending = repo.pending_operation(ctx.root)
    if pending:
        conflicts = repo.git(ctx.root, "diff", "--name-only", "--diff-filter=U") or ""
        if conflicts:
            ctx.note("Conflicts, pull undone. Files:\n  " +
                     conflicts.replace("\n", "\n  "), "red")
        await ctx.execute(["git", pending, "--abort"])
    raise Stop(f"Pulling {branch} failed; resolve by hand: git checkout {branch} && git pull origin {branch}")


async def update_main_here(ctx: Ctx) -> None:
    """Offer a pull of the checked-out main from origin."""
    cmd = ["git", "pull", "--no-edit", "origin", MAIN]
    if await ctx.confirm("Update main from origin?", [cmd],
                         note="No = continue with the local main."):
        await pull(ctx, MAIN)


async def update_main_elsewhere(ctx: Ctx) -> None:
    """Offer an update of main without checking it out: a fast-forward via
    fetch; if main has diverged, a pull on main (switch there and back)."""
    if repo.current_branch(ctx.root) == MAIN:
        return await update_main_here(ctx)
    cmd = ["git", "fetch", "origin", f"{MAIN}:{MAIN}"]
    if not await ctx.confirm("Update main from origin?", [cmd],
                             note="No = use the local main."):
        return
    if await run_all(ctx, [cmd]):
        return
    pull_cmd = ["git", "pull", "--no-edit", "origin", MAIN]
    if not await ctx.confirm("main has diverged from origin; switch to main and pull?",
                             [["git", "checkout", MAIN], pull_cmd],
                             note="No = use the local main."):
        return
    start = await switch_to(ctx, MAIN, "pulling main")
    if start is None:
        return
    try:
        await pull(ctx, MAIN)
    finally:
        await switch_back(ctx, start, MAIN)


async def merge(ctx: Ctx, ref: str, into: str, sensitive: bool) -> bool:
    """Merge `ref` into the checked-out `into`; on a conflict abort and report."""
    cmd = ["git", "merge", "--no-ff", "--no-edit", ref]
    note = "A merge commit. On a conflict the merge is aborted and reported."
    if not await ctx.confirm(f"Merge {ref} into {into}", [cmd], note=note,
                             sensitive=sensitive):
        return False
    ok, _ = await ctx.execute(cmd)
    if ok:
        return True
    conflicts = repo.git(ctx.root, "diff", "--name-only", "--diff-filter=U") or ""
    if conflicts:
        ctx.note("Conflicts, merge aborted. Files:\n  " +
                 conflicts.replace("\n", "\n  "), "red")
        ctx.note(f"Resolve by hand: git checkout {into} && git merge {ref}", "red")
    await ctx.execute(["git", "merge", "--abort"])
    return False


async def offer_push(ctx: Ctx, branch: str) -> None:
    cmd = ["git", "push", "origin", branch]
    if await ctx.confirm(f"Push {branch}?", [cmd], sensitive=True):
        await ctx.execute(cmd)


# --- bump: set the version, commit, tag, push, watch -------------------------


def _read_version_files(ctx: Ctx, prod: Product, branch: str) -> dict[str, str]:
    texts = {}
    for path in core.version_files(prod):
        if ctx.dry_run:  # nothing was checked out: read the branch's copy
            text = repo.show_file(ctx.root, branch, path)
        else:
            try:
                text = (ctx.root / path).read_text(encoding="utf-8")
            except OSError:
                text = None
        if text is None:
            raise Stop(f"Cannot read {path} on {branch}.")
        texts[path] = text
    return texts


async def bump(ctx: Ctx, prod: Product, version: Version, branch: str) -> None:
    """The out-of-app version bump: files, commit, tag, then push and watch.

    `branch` is the checked-out branch (in a dry run the one that would be).
    """
    error = core.branch_guard(version, branch)
    if error:
        raise Stop(error)
    if not ctx.dry_run and repo.current_branch(ctx.root) != branch:
        raise Stop(f"Not on {branch}.")
    # Tracked changes only: untracked files (local/, scratch) are not touched
    # by the commit, which adds the version files by name.
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, "The working tree is not clean, commit or stash first.")

    # Always tag the state origin has too: without the pull a bot commit on
    # origin would be missing from the tag and the branch push rejected.
    if repo.ref_exists(ctx.root, f"refs/remotes/origin/{branch}"):
        await pull(ctx, branch)

    tag = prod.tag(version)
    if repo.ref_exists(ctx.root, f"refs/tags/{tag}") or tag in ctx.snap.tags:
        raise Stop(f"Tag {tag} exists already.")

    try:
        new = core.bump_texts(prod, _read_version_files(ctx, prod, branch), str(version))
    except ValueError as e:
        raise Stop(str(e))
    files = core.version_files(prod)
    cmds: list[Cmd] = [FileWrite(p, t, f"version {version}") for p, t in new.items()]
    cmds += [["git", "add", *files],
             ["git", "commit", "-q", "-m", core.commit_message(prod, version)],
             ["git", "tag", "-a", tag, "-m", core.tag_message(prod, version)]]
    on_main = branch == MAIN
    if not await ctx.confirm(f"Bump {prod.title} to {version}", cmds, sensitive=on_main,
                             note="Commits on main." if on_main else ""):
        return
    for cmd in cmds:
        ok, _ = await ctx.execute(cmd)
        if not ok:
            if not isinstance(cmd, list) or cmd[1] != "tag":
                await ctx.execute(["git", "checkout", "HEAD", "--", *files])
            else:
                ctx.note(f"Commit made, tag failed: tag it by hand "
                         f"(git tag -a {tag} -m '{core.tag_message(prod, version)}').",
                         "red")
            raise Stop("Bump failed.")
    ctx.note(("[dry-run] " if ctx.dry_run else "") + f"Committed and tagged {tag}.", "green")

    push = [["git", "push", "origin", branch], ["git", "push", "origin", tag]]
    kind = f"pre-release (channel {version.channel})" if version.is_channel else "full release"
    if not await ctx.confirm(f"Push {branch} and {tag}?", push, sensitive=True,
                             note=f"CI builds a draft; publish it as a {kind}."):
        ctx.note("Not pushed. Later: " + " && ".join(map(show, push)))
        return
    if not await run_all(ctx, push):
        raise Stop("Push failed.")
    await offer_watch(ctx, prod, tag)


async def offer_watch(ctx: Ctx, prod: Product, tag: str) -> None:
    watch = [["gh", "run", "list", "--workflow", prod.workflow, "--event", "push"],
             ["gh", "run", "view", "<run>", "--json", "status,conclusion,url,jobs"]]
    if not await ctx.confirm("Watch the CI build?", watch,
                             note="Read-only; the Build tab follows the run."):
        return
    if ctx.dry_run:
        for cmd in watch:
            ctx.note(f"[dry-run] $ {show(cmd)}", "yellow")
        return
    ctx.watch_build(tag, prod.workflow)


async def watch(ctx: Ctx) -> None:
    """Follow the build of a pushed app tag in the Build tab (read-only)."""
    prod = prod_of(ctx)
    versions = core.versions_in(prod, ctx.snap.tags_of(prod))
    if not versions:
        raise Stop(f"No {prod.title} version tags.")

    def check(text: str) -> str | None:
        return None if core.product_of_tag(text) and text in ctx.snap.tags else \
            "no such app tag (data releases are built locally)"

    text = await ctx.ask("Watch the build of", "Tag", prod.tag(versions[-1]), validate=check)
    if text:
        ctx.watch_build(text, core.product_of_tag(text).workflow)


# --- channels.json on main ---------------------------------------------------


def _main_channels(ctx: Ctx) -> tuple[dict, str | None]:
    """channels.json of the local main: (document, old text or None)."""
    if ctx.dry_run:
        text = repo.show_file(ctx.root, MAIN, "channels.json")
    else:
        path = ctx.root / "channels.json"
        text = path.read_text(encoding="utf-8") if path.exists() else None
    try:
        return core.load_channels(text), text
    except ValueError as e:
        raise Stop(str(e))


async def edit_channels_on_main(ctx: Ctx, edit, message: str) -> None:
    """Switch to main, apply `edit(doc)`, commit, offer the push, go back."""
    start = await switch_to(ctx, MAIN, "editing channels.json")
    if start is None:
        return
    try:
        await update_main_here(ctx)
        doc, old = _main_channels(ctx)
        try:
            new = core.dump_channels(edit(doc))
        except KeyError as e:
            raise Stop(f"Channel {e} is not listed on main.")
        if new == old:
            raise Stop("Nothing to change.")
        cmds: list[Cmd] = [FileWrite("channels.json", new, "see below"),
                           ["git", "add", "channels.json"],
                           ["git", "commit", "-q", "-m", message]]
        if not await ctx.confirm("Commit on main", cmds, note=new, sensitive=True):
            return
        for cmd in cmds:
            ok, _ = await ctx.execute(cmd)
            if not ok:
                await ctx.execute(["git", "checkout", "HEAD", "--", "channels.json"]
                                  if old is not None else ["git", "rm", "-q", "--cached",
                                                           "--ignore-unmatch", "channels.json"])
                raise Stop("Commit failed.")
        await offer_push(ctx, MAIN)
    finally:
        await switch_back(ctx, start, MAIN)


# --- the actions -------------------------------------------------------------


def _need_row(ctx: Ctx) -> core.ChannelRow:
    row = ctx.selected()
    if row is None:
        raise Stop("Select a channel first.")
    return row


def _need_branch(row: core.ChannelRow) -> None:
    if not row.has_branch:
        raise Stop(f"{branch_of(row.id)} does not exist.")


async def new_channel(ctx: Ctx) -> None:
    known = ctx.snap.channel_ids()

    def check(text: str) -> str | None:
        return core.validate_channel_id(text) or ("exists" if text in known else None)

    cid = await ctx.ask("New channel", "Id", validate=check)
    if cid is None:
        return
    await update_main_elsewhere(ctx)
    branch = branch_of(cid)
    cmds: list[Cmd] = [["git", "branch", branch, MAIN]]
    if not await ctx.confirm(f"Create {branch}", cmds,
                             note="The branch serves both apps; each gets its versions with Bump channel."):
        return
    if not await run_all(ctx, cmds):
        raise Stop("Branch not created.")
    push = ["git", "push", "-u", "origin", branch]
    if await ctx.confirm(f"Push {branch}?", [push], sensitive=True):
        await ctx.execute(push)


def _check_channel_version(prod: Product, text: str, row: core.ChannelRow,
                           view: repo.ProductView, tags: set[str]) -> str | None:
    v = Version.parse(text)
    live = view.live.latest if view.live else None
    if v is None or v.channel != row.id:
        return f"x.y.z-{row.id}.n"
    if prod.tag(v) in tags:
        return "tag exists"
    if row.newest and v <= row.newest:
        return f"not above {row.newest}"
    if live and v.base <= live:
        return f"base not above live {live}"
    return None


async def bump_channel(ctx: Ctx) -> None:
    prod = prod_of(ctx)
    row = _need_row(ctx)
    _need_branch(row)
    snap = ctx.snap
    view = view_of(ctx)
    live = view.live.latest if view.live else None
    tags = snap.tags_of(prod)
    proposal = core.next_channel_version(row.id, core.versions_of(prod, row.id, tags), live)
    text = await ctx.ask(f"Bump the {prod.title} on the {row.id} channel", "Version", str(proposal),
                         validate=lambda t: _check_channel_version(prod, t, row, view, tags))
    if text is None:
        return
    branch = branch_of(row.id)
    start = await switch_to(ctx, branch, "bumping the channel")
    if start is None:
        return
    try:
        await bump(ctx, prod, Version.parse(text), branch)
    finally:
        await switch_back(ctx, start, branch)


def _check_live_version(prod: Product, text: str, snap: repo.Snapshot) -> str | None:
    v = Version.parse(text)
    live = snap.view(prod.key).live
    latest = live.latest if live else None
    if v is None or v.is_channel:
        return "x.y.z"
    if latest and v <= latest:
        return f"not above live {latest}"
    return "tag exists" if prod.tag(v) in snap.tags else None


async def bump_live(ctx: Ctx) -> None:
    prod = prod_of(ctx)
    live = view_of(ctx).live
    proposal = core.live_proposal(live.latest if live else None,
                                  live.newest_tag if live else None)
    text = await ctx.ask(f"Bump {prod.title} live", "Version", str(proposal),
                         validate=lambda t: _check_live_version(prod, t, ctx.snap))
    if text is None:
        return
    start = await switch_to(ctx, MAIN, "bumping live")
    if start is None:
        return
    try:
        await bump(ctx, prod, Version.parse(text), MAIN)
    finally:
        await switch_back(ctx, start, MAIN)


def _selected_draft(ctx: Ctx) -> core.Draft:
    """The draft selected in the Drafts panel."""
    snap = ctx.snap
    if not snap.drafts:
        raise Stop("No drafts." if snap.releases is not None else
                   f"GitHub not reachable: {snap.gh_error}")
    tag = ctx.selected_draft()
    draft = next((d for d in snap.drafts if d.tag == tag), None)
    if draft is None:
        raise Stop("Select a draft first.")
    return draft


def editor_command(path: str, env=None, platform: str | None = None) -> tuple[list[str], bool]:
    """The editor for the release notes and whether it runs in the terminal
    (then the UI is suspended while it runs). $VISUAL / $EDITOR first, else
    notepad on Windows (a window of its own) and nano elsewhere."""
    env = os.environ if env is None else env
    platform = sys.platform if platform is None else platform
    spec = env.get("VISUAL") or env.get("EDITOR")
    if spec:
        return shlex.split(spec, posix=platform != "win32") + [path], True
    if platform == "win32":
        return ["notepad", path], False
    return ["nano", path], True


def _run_editor(argv: list[str], cwd: Path):
    return subprocess.run([shutil.which(argv[0]) or argv[0], *argv[1:]], cwd=cwd)


async def edit_notes(ctx: Ctx) -> None:
    """Write a draft's release notes in an editor, then save them to GitHub."""
    tag = _selected_draft(ctx).tag
    body = repo.query(ctx.root, "gh", "release", "view", tag, "--json", "body",
                      "--jq", ".body")
    if body is None:
        raise Stop(f"Cannot read the notes of {tag}.")
    fd, name = tempfile.mkstemp(prefix=f"releasectl-{tag}-", suffix=".md")
    path = Path(name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(body.rstrip("\n") + "\n" if body.strip() else "")
        editor, interactive = editor_command(str(path))
        save = ["gh", "release", "edit", tag, "--notes-file", str(path)]
        if ctx.dry_run:
            for cmd in (editor, save):
                ctx.note(f"[dry-run] $ {show(cmd)}", "yellow")
            return
        if interactive:
            await ctx.suspended(f"Release notes of {tag}", lambda: _run_editor(editor, ctx.root))
        else:
            ctx.note(f"Editing {path} in {editor[0]}; close it to go on.")
            await asyncio.to_thread(_run_editor, editor, ctx.root)
        new = path.read_text(encoding="utf-8")
        if new.strip() == body.strip():
            raise Stop("Notes unchanged.")
        if await ctx.confirm(f"Save the notes of {tag}", [save], note=new,
                             sensitive=True):
            await ctx.execute(save)
    finally:
        path.unlink(missing_ok=True)


async def publish(ctx: Ctx) -> None:
    snap = ctx.snap
    draft = _selected_draft(ctx)
    tag = draft.tag
    if draft.kind == DATA:
        # Data releases are never "latest": the repository's latest release is the apps' business.
        cmd = ["gh", "release", "edit", tag, "--draft=false", "--prerelease=false", "--latest=false"]
        note = "Full release; CI points data.stable in channels.json at it."
        if await ctx.confirm(f"Publish {tag}", [cmd], note=note, sensitive=True):
            await ctx.execute(cmd)
        return
    prod = core.PRODUCTS[draft.kind]
    v = prod.parse(tag)
    live = snap.view(prod.key).live.latest
    if v.is_channel:
        cmd = ["gh", "release", "edit", tag, "--draft=false", "--prerelease"]
        note = f"Pre-release; CI points the {v.channel} channel of the {prod.title} at it."
        if live and v.base <= live:
            note += f"\nWarning: base <= live {live}, the app never offers it."
    else:
        if live and v <= live:
            raise Stop(f"{tag} is not above the latest release {prod.tag(live)}.")
        cmd = ["gh", "release", "edit", tag, "--draft=false", "--prerelease=false"]
        note = ("Full release; CI points stable in channels.json at it. "
                "Not forced to 'latest': the updaters read tags, not GitHub's latest.")
    if await ctx.confirm(f"Publish {tag}", [cmd], note=note, sensitive=True):
        await ctx.execute(cmd)


async def sync(ctx: Ctx) -> None:
    row = _need_row(ctx)
    _need_branch(row)
    branch = branch_of(row.id)
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, "Working tree has changes; commit or stash first.")
    await update_main_elsewhere(ctx)
    start = await switch_to(ctx, branch, "syncing")
    if start is None:
        return
    try:
        merged = await merge(ctx, MAIN, branch, sensitive=False)
        if merged:
            await offer_push(ctx, branch)
    finally:
        await switch_back(ctx, start, branch)


async def finalize(ctx: Ctx) -> None:
    """Merge the channel into main, then offer Bump live for each app the
    channel has versions of (the active one first)."""
    row = _need_row(ctx)
    _need_branch(row)
    branch = branch_of(row.id)
    ref = branch if row.local else f"origin/{branch}"
    start = await switch_to(ctx, MAIN, "finalizing")
    if start is None:
        return
    try:
        await update_main_here(ctx)
        if not await merge(ctx, ref, MAIN, sensitive=True):
            return
        order = [ctx.product, *(k for k in core.PRODUCTS if k != ctx.product)]
        bumped = False
        for key in order:
            prod = core.PRODUCTS[key]
            view = ctx.snap.view(key)
            own = next((r for r in view.rows if r.id == row.id), None)
            if key != ctx.product and (own is None or own.newest is None):
                continue  # the channel never covered this app
            proposal = core.next_live(view.live.latest if view.live else None,
                                      own.newest if own else None)
            text = await ctx.ask(f"Bump {prod.title} live?", "Version (Esc = not now)",
                                 str(proposal),
                                 validate=lambda t, p=prod: _check_live_version(p, t, ctx.snap))
            if text is None:
                continue
            await bump(ctx, prod, Version.parse(text), MAIN)
            bumped = True
        if not bumped:
            await offer_push(ctx, MAIN)
        else:
            ctx.note(f"Next: remove the {row.id} channel (per app) once the releases are published.")
    finally:
        await switch_back(ctx, start, MAIN)


async def remove_channel(ctx: Ctx) -> None:
    prod = prod_of(ctx)
    row = _need_row(ctx)
    if not row.listed:
        raise Stop(f"{row.id} is not in channels.json for the {prod.title}.")
    await edit_channels_on_main(ctx, lambda doc: core.remove_channel(doc, prod.key, row.id),
                                f"Remove the {row.id} channel of the {prod.title}")
    others = [k for k in core.PRODUCTS if k != prod.key
              and core.find_channel(ctx.snap.channels_doc, k, row.id)]
    if others:
        ctx.note(f"{row.id} is still listed for the {', '.join(others)}; its branch is kept.")
        return
    await offer_branch_delete(ctx, row.id)


async def offer_branch_delete(ctx: Ctx, cid: str) -> None:
    """Delete channel/<id> locally / on origin, each only when merged into main."""
    branch = branch_of(cid)
    root = ctx.root
    if repo.ref_exists(root, f"refs/heads/{branch}"):
        if repo.current_branch(root) == branch:
            ctx.note(f"{branch} is checked out; not deleting it.")
        elif not repo.is_ancestor(root, branch, MAIN):
            ctx.note(f"{branch} is not merged into main; kept.")
        else:
            cmd = ["git", "branch", "-d", branch]
            if await ctx.confirm(f"Delete local {branch}?", [cmd]):
                await ctx.execute(cmd)
    if repo.ref_exists(root, f"refs/remotes/origin/{branch}"):
        if not repo.is_ancestor(root, f"origin/{branch}", "origin/main"):
            ctx.note(f"origin/{branch} is not merged into origin/main; kept.")
        else:
            cmd = ["git", "push", "origin", "--delete", branch]
            if await ctx.confirm(f"Delete {branch} on origin?", [cmd], sensitive=True):
                await ctx.execute(cmd)


async def fetch(ctx: Ctx) -> None:
    # No --prune together with --tags: that would delete local tags.
    cmds: list[Cmd] = [["git", "fetch", "--prune", "origin"],
                       ["git", "fetch", "--tags", "origin"]]
    if await ctx.confirm("Fetch origin", cmds, note="Remote refs and tags only."):
        await run_all(ctx, cmds)


# --- data release ------------------------------------------------------------


def snapshot_label(path: Path) -> str | None:
    """The game label of a snapshot (.json or .json.gz). The head of the
    file is enough in practice; if the pattern is not there, the file is
    parsed as a whole."""
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rb") as f:
        head = f.read(256 * 1024).decode("utf-8", errors="replace")
    label = core.label_from_head(head)
    if label:
        return label
    with opener(path, "rb") as f:
        return (json.load(f).get("game") or {}).get("label")


def newest_snapshot(root: Path) -> Path | None:
    """The newest snapshot in local/snapshots, the place `catalog:extract` writes to."""
    folder = root / "local" / "snapshots"
    files = [p for p in folder.glob("*.json*") if p.name.endswith((".json", ".json.gz"))] if folder.is_dir() else []
    return max(files, key=lambda p: p.stat().st_mtime, default=None)


def default_thumbs(root: Path, env=None) -> Path:
    """$THUMBS_DIR, else local/thumbs: where `thumbs:build` writes."""
    env = os.environ if env is None else env
    return Path(env["THUMBS_DIR"]) if env.get("THUMBS_DIR") else root / "local" / "thumbs"


def _path_arg(root: Path, text: str) -> Path:
    p = Path(text)
    return p if p.is_absolute() else root / p


async def data_release(ctx: Ctx) -> None:
    """Build a data release with `pnpm data:pack` and create it as a draft."""
    snap = ctx.snap
    root = ctx.root
    if snap.releases is None:
        raise Stop(f"GitHub not reachable: {snap.gh_error}")
    if snap.channels_error:
        raise Stop(snap.channels_error)

    found = newest_snapshot(root)
    text = await ctx.ask("Data release: snapshot", "Snapshot (.json / .json.gz)",
                         str(found) if found else "local/snapshots/",
                         validate=lambda t: None if _path_arg(root, t).is_file() else "no such file")
    if text is None:
        return
    snapshot = _path_arg(root, text)
    text = await ctx.ask("Data release: thumbnails", "Thumbnails folder (thumbs.json, s/, m/, l/)",
                         str(default_thumbs(root)),
                         validate=lambda t: None if (_path_arg(root, t) / "thumbs.json").is_file()
                         else "no thumbs.json there")
    if text is None:
        return
    thumbs = _path_arg(root, text)

    label = await asyncio.to_thread(snapshot_label, snapshot)
    if not label or not core.GAME_LABEL_RE.match(label):
        raise Stop(f"No usable game label in {snapshot.name}: {label!r}")
    proposal = core.next_data_n(label, snap.tags)

    def check_n(t: str) -> str | None:
        if not t.isdigit() or int(t) < 1:
            return "a whole number from 1"
        return "tag exists" if core.data_tag(label, int(t)) in snap.tags else None

    text = await ctx.ask(f"Data release for {label}", "Re-issue number n", str(proposal),
                         validate=check_n)
    if text is None:
        return
    n = int(text)
    tag = core.data_tag(label, n)

    previous = core.stable_of(snap.channels_doc, DATA)
    if previous and previous not in snap.releases:
        raise Stop(f"channels.json names {previous} as data.stable, but GitHub has no such release.")
    if previous == tag:
        raise Stop(f"{tag} is the current data.stable; use a higher n.")

    work = root / "local" / "data-release" / tag
    prev_dir, out_dir = work / "previous", work / "out"
    cmds: list[Cmd] = []
    if previous:
        cmds.append(["gh", "release", "download", previous, "--clobber",
                     "--pattern", core.MANIFEST_NAME, "--pattern", core.THUMBS_UPDATE_NAME,
                     "--dir", str(prev_dir)])
    pack = ["pnpm", "data:pack", "--snapshot", str(snapshot), "--thumbs", str(thumbs),
            "--n", str(n), "--out", str(out_dir)]
    if previous:
        pack += ["--previous", str(prev_dir)]
    cmds.append(pack)
    note = (f"Builds {tag}" + (f" on top of {previous} (data.stable): its manifest and thumbs-update.zip are "
                              "downloaded first, the delta is what is new against it." if previous else
                              ": no data.stable in channels.json, so this is a first release holding every picture.") +
            f"\nOutput: {out_dir}. Nothing is created on GitHub yet.")
    if not await ctx.confirm(f"Build {tag}", cmds, note=note):
        return
    if not await run_all(ctx, cmds):
        raise Stop("The build failed; see the log.")

    names = [core.MANIFEST_NAME, core.full_pack_name(label, n), core.CATALOG_NAME, core.THUMBS_UPDATE_NAME]
    create = ["gh", "release", "create", tag, *(str(out_dir / name) for name in names),
              "--draft", "--title", tag, "--notes", "<notes>"]
    if ctx.dry_run:
        ctx.note(f"[dry-run] then: show the built assets and run {show(create)}", "yellow")
        return

    try:
        manifest = json.loads((out_dir / core.MANIFEST_NAME).read_text(encoding="utf-8"))
        sizes = {name: (out_dir / name).stat().st_size for name in names}
    except (OSError, ValueError) as e:
        raise Stop(f"The built release is incomplete: {e}")
    if manifest.get("tag") != tag:
        raise Stop(f"The build made {manifest.get('tag')}, expected {tag}.")
    summary = core.pack_summary(manifest, sizes)
    ctx.note(summary, "green")

    notes = core.data_release_notes(manifest)
    create[-1] = notes
    if not await ctx.confirm(f"Create the draft release {tag}", [create], note=summary, sensitive=True):
        ctx.note(f"Not created. The assets stay in {out_dir}.")
        return
    ok, _ = await ctx.execute(create)
    if ok:
        ctx.note("Draft created. Review it in Drafts (Notes), publish it there.")


ACTIONS = {
    "new": new_channel,
    "bump": bump_channel,
    "live": bump_live,
    "notes": edit_notes,
    "publish": publish,
    "sync": sync,
    "finalize": finalize,
    "remove": remove_channel,
    "fetch": fetch,
    "watch": watch,
    "data": data_release,
}
