"""The write actions. Each one shows its commands and waits for a yes first.

Rules kept here: no force, no history rewrite, no tag or release deletion,
no branch switch on a dirty tree, back to the starting branch afterwards.
Pushes, GitHub changes and workflow runs get their own (sensitive)
confirmation.

`main` is protected (pull requests only, squash merge, no bypass): nothing
here pushes to it. A live version goes through a pull request (`release/...`
or the channel's own branch), is merged by squash on the user's explicit
yes, and is tagged on the squash commit afterwards; every release step is
based on `origin/main`, the local main is never touched. The feed
(`channels.json` on the `channels` branch) is written by CI only.

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
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol

from . import core, repo
from .core import DATA, MAIN, ORIGIN_MAIN, Product, Version, branch_of


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
    def watch_build(self, tag: str, workflow: str, since: str | None = None) -> None: ...


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


def git_push(*refs: str, upstream: bool = False, delete: bool = False) -> list[str]:
    """The one place a push command is built. It refuses main: the default
    branch only changes through a merged pull request."""
    for ref in refs:
        if core.is_default_branch(ref):
            raise ValueError(f"refusing to push {ref}: main takes pull requests only")
    return ["git", "push", *(["-u"] if upstream else []), "origin", *(["--delete"] if delete else []), *refs]


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
    """Pull the checked-out channel `branch` from origin (a plain pull: the
    branch may have been pushed from another machine). On a conflict the
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


async def fetch_origin(ctx: Ctx, why: str) -> None:
    """Offer a fetch, so that origin/main and the channel branches are current.
    Release steps start from origin/main; the local main is not used."""
    cmd = ["git", "fetch", "--prune", "origin"]
    if await ctx.confirm("Fetch origin?", [cmd], note=why + "\nNo = use the remote refs as fetched last."):
        await run_all(ctx, [cmd])


async def merge(ctx: Ctx, ref: str, into: str) -> bool:
    """Merge `ref` into the checked-out channel branch `into`; on a conflict
    abort and report."""
    cmd = ["git", "merge", "--no-ff", "--no-edit", ref]
    note = "A merge commit. On a conflict the merge is aborted and reported."
    if not await ctx.confirm(f"Merge {ref} into {into}", [cmd], note=note):
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
    cmd = git_push(branch)
    if await ctx.confirm(f"Push {branch}?", [cmd], sensitive=True):
        await ctx.execute(cmd)


# --- bump of a channel version: set the version, commit, tag, push, watch ---


def _read_version_files(ctx: Ctx, prod: Product, branch: str, from_ref: bool = False) -> dict[str, str]:
    """The version files' texts: of the checked-out working tree, or of `branch`
    as a ref (a dry run, or `from_ref` when nothing is checked out)."""
    texts = {}
    for path in core.version_files(prod):
        if ctx.dry_run or from_ref:
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
    """The out-of-app version bump of a channel version: files, commit, tag,
    then push (the channel branch is not under the main ruleset) and watch.

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

    # Always tag the state origin has too: without the pull a commit pushed
    # from elsewhere would be missing from the tag and the branch push rejected.
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
    if not await ctx.confirm(f"Bump {prod.title} to {version}", cmds):
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

    push = [git_push(branch), git_push(tag)]
    if not await ctx.confirm(f"Push {branch} and {tag}?", push, sensitive=True,
                             note=f"CI builds a draft; publish it as a pre-release (channel {version.channel})."):
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


def dispatch_since() -> str:
    """A time just before a workflow was started (with room for clock skew), to
    find its run afterwards."""
    return (datetime.now(timezone.utc) - timedelta(seconds=60)).strftime("%Y-%m-%dT%H:%M:%SZ")


async def offer_watch_dispatch(ctx: Ctx, workflow: str, label: str, since: str) -> None:
    watch = [["gh", "run", "list", "--workflow", workflow, "--event", "workflow_dispatch"],
             ["gh", "run", "view", "<run>", "--json", "status,conclusion,url,jobs"]]
    if not await ctx.confirm(f"Watch the {workflow} run?", watch,
                             note="Read-only; the Build tab follows the run."):
        return
    if ctx.dry_run:
        for cmd in watch:
            ctx.note(f"[dry-run] $ {show(cmd)}", "yellow")
        return
    ctx.watch_build(label, workflow, since)


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


# --- live versions through a pull request ---------------------------------------

REFRESH = "Refresh the state and checks"
MERGE = "Merge now (squash)"
LATER = "Leave it for later (Bump live continues it)"


async def pr_gate(ctx: Ctx, branch: str, what: str, delete_branch: bool = True) -> bool:
    """Show the pull request of `branch` (state, checks), let the user wait and
    refresh, and on an explicit yes merge it by squash. True when it is merged,
    False when it was left open. Never --auto, never --admin. A release branch
    is deleted by the merge; a channel branch is not (its deletion is offered
    afterwards: the channel is not over until the user says so)."""
    merge_cmd = ["gh", "pr", "merge", branch, "--squash", *(["--delete-branch"] if delete_branch else [])]
    after = ", then the branch is deleted" if delete_branch else ""
    if ctx.dry_run:
        ctx.note(f"[dry-run] then: show the pull request (gh pr view {branch} --json "
                 "number,state,url,title,mergeStateStatus,statusCheckRollup) until the user merges it.", "yellow")
        if await ctx.confirm(f"Merge {branch}", [merge_cmd], sensitive=True,
                             note=f"{what}\nSquash merge{after}."):
            await ctx.execute(merge_cmd)
        return True
    while True:
        view = await asyncio.to_thread(repo.pr_view, ctx.root, branch)
        if view is None:
            raise Stop(f"No pull request found for {branch} (gh pr view failed).")
        ctx.note(core.pr_summary(view))
        if view.state == "MERGED":
            ctx.note(f"#{view.number} is merged already.", "green")
            return True
        if view.state != "OPEN":
            raise Stop(f"Pull request #{view.number} is {view.state.lower()} without a merge.")
        choice = await ctx.pick(f"{what}: PR #{view.number}, {view.checks_line}", [REFRESH, MERGE, LATER])
        if choice is None or choice == LATER:
            ctx.note(f"Left open: {view.url}\nBump live (or Finalize) continues it later: merge, then tag.")
            return False
        if choice == REFRESH:
            continue
        warn = ""
        if view.failed or view.pending or view.merge_state not in ("CLEAN", "HAS_HOOKS", ""):
            warn = (f"Not clean: {view.checks_line}, merge state {view.merge_state.lower() or '?'}. "
                    "GitHub refuses the merge while required checks are not satisfied.\n")
        if await ctx.confirm(f"Merge PR #{view.number} ({branch})", [merge_cmd], sensitive=True,
                             note=f"{warn}{view.title}\nSquash merge{after}. Nothing is merged automatically."):
            ok, _ = await ctx.execute(merge_cmd)
            if ok:
                return True
            ctx.note("The merge did not go through; the state is shown again.", "red")


def _local_tags(ctx: Ctx) -> set[str]:
    patterns = [f"{p.tag_prefix}*" for p in core.PRODUCTS.values()]
    return set((repo.git(ctx.root, "tag", "-l", *patterns) or "").split()) | ctx.snap.tags


async def tag_squash(ctx: Ctx, expected: list[tuple[Product, Version]] | None) -> None:
    """After the merge: fetch, find the squash commit on origin/main, check it
    carries exactly the bumped version, tag it (annotated) and push the tag.

    `expected` lists what must be found; None tags every untagged bump on
    origin/main (resuming a channel's pull request, whose versions are not known).
    """
    fetch = [["git", "fetch", "--prune", "origin"], ["git", "fetch", "--tags", "origin"]]
    ctx.note("Fetching the merge result (read-only).")
    if not await run_all(ctx, fetch):
        raise Stop("Fetch failed; Bump live continues from here once origin is reachable.")
    if ctx.dry_run:
        for prod, version in expected or []:
            tag = prod.tag(version)
            for cmd in (["git", "tag", "-a", tag, "-m", core.tag_message(prod, version), "<squash commit on origin/main>"],
                        git_push(tag)):
                ctx.note(f"[dry-run] $ {show(cmd)}", "yellow")
            ctx.note(f"[dry-run] first: find the squash commit on origin/main and verify that every file of the "
                     f"{prod.title} carries {version}.", "yellow")
        return
    found = repo.untagged_bumps(ctx.root, _local_tags(ctx))
    if expected is not None:
        todo = []
        for prod, version in expected:
            item = next((p for p in found if p.product == prod.key and p.version == version), None)
            if item is None:
                raise Stop(f"The squash commit of {prod.title} {version} is not on origin/main (or it is tagged "
                           "already). Bump live picks it up when it shows.")
            todo.append(item)
    else:
        todo = found
    if not todo:
        ctx.note("Nothing to tag on origin/main.")
    for item in todo:
        prod = core.PRODUCTS[item.product]
        version, sha = item.version, item.commit
        texts = {p: repo.show_file(ctx.root, sha, p) for p in core.version_files(prod)}
        bad = core.files_not_carrying(prod, texts, str(version))
        if bad:
            raise Stop(f"{sha[:8]} does not carry exactly {version} in {', '.join(bad)}; not tagging it.")
        changed = (repo.git(ctx.root, "diff-tree", "--no-commit-id", "--name-only", "-r", sha) or "").split()
        extra = [f for f in changed if f not in core.version_files(prod)]
        tag = prod.tag(version)
        cmds = [["git", "tag", "-a", tag, "-m", core.tag_message(prod, version), sha], git_push(tag)]
        note = (f"{sha[:8]} on origin/main: {repo.git(ctx.root, 'log', '-1', '--format=%s', sha)}\n"
                f"Every file of the {prod.title} carries {version}. CI builds a draft; publish it as a full release.")
        if extra:
            note += "\nAlso changed in that commit: " + ", ".join(extra)
        if not await ctx.confirm(f"Tag {tag} on {sha[:8]}", cmds, sensitive=True, note=note):
            ctx.note(f"Not tagged. Bump live offers it again (the version is on main, the tag is missing).")
            continue
        if not await run_all(ctx, cmds):
            raise Stop(f"Tagging {tag} failed; Bump live offers it again.")
        await offer_watch(ctx, prod, tag)


async def release_pr(ctx: Ctx, prod: Product, version: Version) -> None:
    """A live bump: a branch from origin/main with the version files changed,
    pushed, with a pull request; then the gate (checks, merge on a yes) and
    the tag on the squash commit."""
    tag = prod.tag(version)
    if repo.ref_exists(ctx.root, f"refs/tags/{tag}") or tag in ctx.snap.tags:
        raise Stop(f"Tag {tag} exists already.")
    branch = core.release_branch(prod, version)
    if any(repo.ref_exists(ctx.root, ref) for ref in (f"refs/heads/{branch}", f"refs/remotes/origin/{branch}")):
        raise Stop(f"{branch} exists already: a bump in progress? It is listed as unfinished work in Bump live.")
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, "The working tree is not clean, commit or stash first.")
    await fetch_origin(ctx, f"The bump branch is cut from {ORIGIN_MAIN}.")
    if not repo.ref_exists(ctx.root, ORIGIN_MAIN):
        raise Stop(f"No {ORIGIN_MAIN}: fetch first.")
    try:
        new = core.bump_texts(prod, _read_version_files(ctx, prod, ORIGIN_MAIN, from_ref=True), str(version))
    except ValueError as e:
        raise Stop(str(e))
    files = core.version_files(prod)
    title = core.commit_message(prod, version)
    pr = ["gh", "pr", "create", "--base", MAIN, "--head", branch, "--title", title,
          "--body", core.pr_body_bump(prod, version)]
    cmds: list[Cmd] = [["git", "checkout", "--no-track", "-b", branch, ORIGIN_MAIN]]
    cmds += [FileWrite(p, t, f"version {version}") for p, t in new.items()]
    cmds += [["git", "add", *files], ["git", "commit", "-q", "-m", title],
             git_push(branch, upstream=True), pr]
    note = (f"A branch {branch} from {ORIGIN_MAIN} with the bump, a pull request to main. Main itself is not pushed to.\n"
            f"Next: the checks, then your yes to the squash merge; the tag {tag} goes on the squash commit.")
    if not await ctx.confirm(f"Bump {prod.title} to {version} (pull request)", cmds, note=note, sensitive=True):
        return
    start = repo.current_branch(ctx.root)
    push_at = cmds.index(git_push(branch, upstream=True))
    try:
        for i, cmd in enumerate(cmds):
            ok, _ = await ctx.execute(cmd)
            if ok:
                continue
            if i == 0:
                raise Stop(f"Could not create {branch}.")
            if i < push_at:  # nothing pushed yet: undo the local part
                await ctx.execute(["git", "checkout", "HEAD", "--", *files])
                await ctx.execute(["git", "checkout", start])
                await ctx.execute(["git", "branch", "-D", branch])
                raise Stop("Bump failed; the local branch is removed again.")
            if i == push_at:
                raise Stop(f"Push failed; {branch} exists locally with the commit: fix the cause, then "
                           f"git push -u origin {branch} and gh pr create, or delete the branch.")
            raise Stop(f"{branch} is pushed but the pull request was not created: "
                       f"gh pr create --base main --head {branch} (Bump live offers it as unfinished work).")
    finally:
        await switch_back(ctx, start, branch)
    ctx.note(("[dry-run] " if ctx.dry_run else "") + f"Pull request for {branch} created.", "green")
    if await pr_gate(ctx, branch, f"Bump {prod.title} to {version}"):
        await tag_squash(ctx, [(prod, version)])


UNFINISHED_NEW = "Start a new bump"


async def resume(ctx: Ctx, item: core.Pending) -> None:
    """Pick up unfinished work: merge an open pull request and tag, open the
    missing pull request of a pushed release branch, or tag a merged bump."""
    prod = core.PRODUCTS[item.product] if item.product else None
    expected = [(prod, item.version)] if prod else None
    if item.kind == "untagged":
        return await tag_squash(ctx, expected)
    if item.kind == "branch":
        title = core.commit_message(prod, item.version)
        pr = ["gh", "pr", "create", "--base", MAIN, "--head", item.branch, "--title", title,
              "--body", core.pr_body_bump(prod, item.version)]
        if not await ctx.confirm(f"Open the pull request of {item.branch}", [pr], sensitive=True):
            return
        if not await run_all(ctx, [pr]):
            raise Stop("The pull request was not created.")
    if await pr_gate(ctx, item.branch, f"Continue {item.branch}", delete_branch=prod is not None):
        await tag_squash(ctx, expected)
        if not prod and item.branch.startswith(core.BRANCH_PREFIX):
            await offer_branch_delete(ctx, item.branch[len(core.BRANCH_PREFIX):])


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
    await fetch_origin(ctx, f"The channel is cut from {ORIGIN_MAIN}.")
    branch = branch_of(cid)
    cmds: list[Cmd] = [["git", "branch", "--no-track", branch, ORIGIN_MAIN]]
    if not await ctx.confirm(f"Create {branch}", cmds,
                             note="The branch serves both apps; each gets its versions with Bump channel."):
        return
    if not await run_all(ctx, cmds):
        raise Stop("Branch not created.")
    push = git_push(branch, upstream=True)
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
    """A new live version through a pull request, or the continuation of an
    unfinished one (an open pull request, a merged bump without its tag)."""
    prod = prod_of(ctx)
    pending = ctx.snap.pending
    if pending:
        options = [p.label for p in pending] + [UNFINISHED_NEW]
        choice = await ctx.pick("Unfinished release work", options)
        if choice is None:
            return
        if choice != UNFINISHED_NEW:
            return await resume(ctx, pending[options.index(choice)])
    live = view_of(ctx).live
    proposal = core.live_proposal(live.latest if live else None,
                                  live.newest_tag if live else None)
    text = await ctx.ask(f"Bump {prod.title} live", "Version", str(proposal),
                         validate=lambda t: _check_live_version(prod, t, ctx.snap))
    if text is None:
        return
    await release_pr(ctx, prod, Version.parse(text))


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
        note = "Full release; CI points data.stable in the feed (channels branch) at it."
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
        note = ("Full release; CI points stable in the feed (channels branch) at it. "
                "Not forced to 'latest': the updaters read tags, not GitHub's latest.")
    if await ctx.confirm(f"Publish {tag}", [cmd], note=note, sensitive=True):
        await ctx.execute(cmd)


async def sync(ctx: Ctx) -> None:
    """Merge origin/main into the channel branch (the branch is not protected)."""
    row = _need_row(ctx)
    _need_branch(row)
    branch = branch_of(row.id)
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, "Working tree has changes; commit or stash first.")
    await fetch_origin(ctx, f"The channel gets {ORIGIN_MAIN} merged in.")
    start = await switch_to(ctx, branch, "syncing")
    if start is None:
        return
    try:
        if await merge(ctx, ORIGIN_MAIN, branch):
            await offer_push(ctx, branch)
    finally:
        await switch_back(ctx, start, branch)


async def finalize(ctx: Ctx) -> None:
    """Bring a channel to main: the live version bump of every app the channel
    carried is committed on the channel branch as its last commits, the branch
    is pushed and a pull request to main opened; after the user's yes it is
    merged by squash, and each app's tag goes on the squash commit.

    One pull request and one merge do everything (the alternative, the channel
    merge first and one bump pull request per app, costs a CI run each and
    leaves a main that carries the channel's pre-release version in between).
    The checks of the pull request run on exactly what is released. After a
    squash merge the branch is not an ancestor of main: the channel ends here,
    its branch is offered for deletion.
    """
    row = _need_row(ctx)
    _need_branch(row)
    snap = ctx.snap
    branch = branch_of(row.id)
    if repo.is_dirty(ctx.root):
        dirty_stop(ctx, "Working tree has changes; commit or stash first.")

    open_pr = next((p for p in snap.pending if p.kind == "pr" and p.branch == branch), None)
    if open_pr:
        ctx.note(f"A pull request of {branch} is open already (#{open_pr.number}); continuing it.")
        return await resume(ctx, open_pr)

    await fetch_origin(ctx, f"{branch} and {ORIGIN_MAIN} should be current.")

    # The apps the channel carried, the active one first; each needs a live version.
    carried: list[tuple[Product, Version]] = []
    for key in [ctx.product, *(k for k in core.PRODUCTS if k != ctx.product)]:
        prod = core.PRODUCTS[key]
        view = snap.view(key)
        own = next((r for r in view.rows if r.id == row.id), None)
        if own is None or own.newest is None:
            continue
        proposal = core.next_live(view.live.latest if view.live else None, own.newest)
        text = await ctx.ask(f"Finalize {row.id}: {prod.title} live version", "Version (Esc = cancel the finalize)",
                             str(proposal), validate=lambda t, p=prod: _check_live_version(p, t, snap))
        if text is None:
            return
        carried.append((prod, Version.parse(text)))
    if not carried:
        ctx.note(f"{row.id} carries no app version: the pull request brings the branch to main without a bump.")

    start = await switch_to(ctx, branch, "finalizing")
    if start is None:
        return
    try:
        if repo.ref_exists(ctx.root, f"refs/remotes/origin/{branch}"):
            await pull(ctx, branch)
        cmds: list[Cmd] = []
        files_all: list[str] = []
        for prod, version in carried:
            try:
                new = core.bump_texts(prod, _read_version_files(ctx, prod, branch), str(version))
            except ValueError as e:
                raise Stop(str(e))
            files = core.version_files(prod)
            files_all += files
            cmds += [FileWrite(p, t, f"version {version}") for p, t in new.items()]
            cmds += [["git", "add", *files], ["git", "commit", "-q", "-m", core.commit_message(prod, version)]]
        has_origin = repo.ref_exists(ctx.root, f"refs/remotes/origin/{branch}")
        push_at = len(cmds)
        cmds.append(git_push(branch, upstream=not has_origin))
        title = core.finalize_title(row.id, carried)
        cmds.append(["gh", "pr", "create", "--base", MAIN, "--head", branch, "--title", title,
                     "--body", core.finalize_body(row.id, carried)])
        note = (f"The version bump(s) become the last commit(s) of {branch}; the pull request to main carries them "
                "together with the channel's work. Main itself is not pushed to.\n"
                "Next: the checks, then your yes to the squash merge, then the tags on the squash commit. "
                "A squash merge leaves the branch outside main's history; the channel ends here.")
        ab = repo.ahead_behind(ctx.root, branch, ORIGIN_MAIN)
        if ab and ab[1]:
            note += (f"\nThe branch is {ab[1]} commit(s) behind {ORIGIN_MAIN}: if the pull request cannot merge "
                     "cleanly or the checks want an up-to-date branch, run Sync first.")
        if not await ctx.confirm(f"Finalize {row.id}: bump, push, pull request", cmds, note=note, sensitive=True):
            return
        for i, cmd in enumerate(cmds):
            ok, _ = await ctx.execute(cmd)
            if ok:
                continue
            if i < push_at:
                await ctx.execute(["git", "checkout", "HEAD", "--", *files_all])
                raise Stop(f"Bump failed; commits already made stay on {branch} (git log), the rest was undone.")
            if i == push_at:
                raise Stop(f"Push of {branch} failed; the bump commits are local. Fix the cause and finalize again "
                           "(the bump will be offered again, so drop the local commits first if it refuses).")
            raise Stop(f"{branch} is pushed but the pull request was not created: gh pr create --base main "
                       f"--head {branch}. Finalize continues it once it exists.")
    finally:
        await switch_back(ctx, start, branch)
    ctx.note(("[dry-run] " if ctx.dry_run else "") + f"Pull request for {branch} created.", "green")
    if not await pr_gate(ctx, branch, f"Finalize {row.id}", delete_branch=False):
        return
    await tag_squash(ctx, carried)
    await offer_branch_delete(ctx, row.id)
    ctx.note(f"The {row.id} channel is finished. Next: publish the drafts, then remove the channel (per app).")


async def remove_channel(ctx: Ctx) -> None:
    """Take the channel out of the feed. The feed is written by CI only: the
    `channels.yml` workflow does it, this starts that run."""
    prod = prod_of(ctx)
    row = _need_row(ctx)
    if not row.listed:
        raise Stop(f"{row.id} is not in channels.json for the {prod.title}.")
    cmd = ["gh", "workflow", "run", "channels.yml", "-f", f"product={prod.key}", "-f", f"channel={row.id}",
           "-f", "action=remove"]
    note = (f"Starts the Channels workflow, which removes {row.id} from the {prod.title}'s list in channels.json "
            "on the channels branch. The feed changes when that run is through; the testers fall back to stable "
            "at their next check.")
    since = dispatch_since()
    if not await ctx.confirm(f"Remove the {row.id} channel of the {prod.title}", [cmd], note=note, sensitive=True):
        return
    ok, _ = await ctx.execute(cmd)
    if not ok:
        raise Stop("The workflow was not started.")
    ctx.note("Started. The feed changes when the run is through (r refreshes the view afterwards).")
    await offer_watch_dispatch(ctx, "channels.yml", f"channels.yml: remove {row.id} ({prod.key})", since)
    others = [k for k in core.PRODUCTS if k != prod.key
              and core.find_channel(ctx.snap.channels_doc, k, row.id)]
    if others:
        ctx.note(f"{row.id} is still listed for the {', '.join(others)}; its branch is kept.")
        return
    await offer_branch_delete(ctx, row.id)


async def offer_branch_delete(ctx: Ctx, cid: str) -> None:
    """Delete channel/<id> locally / on origin, each only when it is merged
    into main: an ancestor, or (squash merge) the head of a merged pull request.
    Channel branches are not under the main ruleset."""
    branch = branch_of(cid)
    root = ctx.root
    if repo.ref_exists(root, f"refs/heads/{branch}"):
        if repo.current_branch(root) == branch:
            ctx.note(f"{branch} is checked out; not deleting it.")
        elif not repo.branch_merged(root, branch, branch):
            ctx.note(f"{branch} is not merged into main; kept.")
        else:
            force = not repo.is_ancestor(root, branch, ORIGIN_MAIN)
            cmd = ["git", "branch", "-D" if force else "-d", branch]
            if await ctx.confirm(f"Delete local {branch}?", [cmd],
                                 note="Squash-merged: its content is on main under another commit." if force else ""):
                await ctx.execute(cmd)
    if repo.ref_exists(root, f"refs/remotes/origin/{branch}"):
        if not repo.branch_merged(root, f"origin/{branch}", branch):
            ctx.note(f"origin/{branch} is not merged into origin/main; kept.")
        else:
            cmd = git_push(branch, delete=True)
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
        raise Stop(f"the feed names {previous} as data.stable, but GitHub has no such release.")
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
                              ": no data.stable in the feed, so this is a first release holding every picture.") +
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
