"""Read-only git / gh queries that feed the overview.

Nothing here writes: the write commands are built and run by actions.py.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass, field
from pathlib import Path

from . import core


def query(root: Path, *argv: str) -> str | None:
    """Run a read-only command; its stdout, or None when it fails."""
    try:
        p = subprocess.run(argv, cwd=root, capture_output=True, text=True,
                           timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return p.stdout if p.returncode == 0 else None


def git(root: Path, *args: str) -> str | None:
    out = query(root, "git", *args)
    return out.strip() if out is not None else None


def current_branch(root: Path) -> str:
    """The checked-out branch, or the commit hash on a detached HEAD."""
    name = git(root, "rev-parse", "--abbrev-ref", "HEAD") or "HEAD"
    if name != "HEAD":
        return name
    return git(root, "rev-parse", "HEAD") or "HEAD"


def is_dirty(root: Path) -> bool:
    """Uncommitted changes to tracked files (untracked files do not count)."""
    return bool(git(root, "status", "--porcelain", "--untracked-files=no"))


def ref_exists(root: Path, ref: str) -> bool:
    return git(root, "rev-parse", "-q", "--verify", ref) is not None


def pending_operation(root: Path) -> str | None:
    """A merge or rebase left open (by a failed pull), or None."""
    if ref_exists(root, "MERGE_HEAD"):
        return "merge"
    for name in ("rebase-merge", "rebase-apply"):
        path = git(root, "rev-parse", "--git-path", name)
        if path and (root / path).exists():
            return "rebase"
    return None


def is_ancestor(root: Path, ref: str, of: str) -> bool:
    p = subprocess.run(["git", "merge-base", "--is-ancestor", ref, of],
                       cwd=root, capture_output=True)
    return p.returncode == 0


def ahead_behind(root: Path, ref: str, base: str) -> tuple[int, int] | None:
    out = git(root, "rev-list", "--left-right", "--count", f"{ref}...{base}")
    if not out:
        return None
    left, right = out.split()
    return int(left), int(right)


def show_file(root: Path, ref: str, path: str) -> str | None:
    out = query(root, "git", "show", f"{ref}:{path}")
    return out


def releases(root: Path) -> tuple[dict[str, str] | None, str | None]:
    """tag -> draft / pre-release / release, or (None, error)."""
    try:
        p = subprocess.run(
            ["gh", "release", "list", "--limit", "1000",
             "--json", "tagName,isDraft,isPrerelease"],
            cwd=root, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired) as e:
        return None, str(e)
    if p.returncode != 0:
        return None, (p.stderr.strip() or "gh release list failed")
    out = {}
    for r in json.loads(p.stdout):
        state = (core.DRAFT if r["isDraft"] else
                 core.PRERELEASE if r["isPrerelease"] else core.RELEASE)
        out[r["tagName"]] = state
    return out, None


@dataclass
class ProductView:
    """One app's part of the overview."""
    rows: list[core.ChannelRow] = field(default_factory=list)
    live: core.LiveInfo | None = None
    main_ahead_live: int | None = None  # commits on main since the latest live tag


@dataclass
class Snapshot:
    branch: str = ""
    dirty: bool = False
    main_vs_origin: tuple[int, int] | None = None  # (ahead, behind)
    tags: set[str] = field(default_factory=set)  # every product and data tag
    releases: dict[str, str] | None = None
    gh_error: str | None = None
    channels_doc: dict = field(default_factory=dict)
    channels_error: str | None = None
    channels_file: bool = False  # channels.json exists on origin/channels
    views: dict[str, ProductView] = field(default_factory=dict)
    data: core.DataInfo | None = None
    drafts: list[core.Draft] = field(default_factory=list)
    pending: list[core.Pending] = field(default_factory=list)  # open PRs, untagged bumps

    def view(self, key: str) -> ProductView:
        return self.views.get(key) or ProductView()

    def tags_of(self, prod: core.Product) -> set[str]:
        return {t for t in self.tags if prod.parse(t)}

    def channel_ids(self) -> set[str]:
        return {r.id for v in self.views.values() for r in v.rows}


def _channel_ids(root: Path, prefix: str) -> set[str]:
    out = git(root, "for-each-ref", "--format=%(refname)", prefix) or ""
    return {line[len(prefix):] for line in out.splitlines() if line}


def gather(root: Path) -> Snapshot:
    snap = Snapshot(branch=current_branch(root), dirty=is_dirty(root))
    snap.main_vs_origin = ahead_behind(root, core.MAIN, "origin/main")
    patterns = [f"{p.tag_prefix}*" for p in core.PRODUCTS.values()] + ["data-*"]
    snap.tags = set((git(root, "tag", "-l", *patterns) or "").split())
    snap.releases, snap.gh_error = releases(root)
    if snap.releases:
        snap.tags |= {t for t in snap.releases
                      if core.product_of_tag(t) or core.parse_data_tag(t)}

    # The feed is on its own branch; no branch or no file is "nothing released yet".
    text = show_file(root, core.CHANNELS_REF, core.CHANNELS_FILE)
    snap.channels_file = text is not None
    try:
        snap.channels_doc = core.load_channels(text)
    except ValueError as e:
        snap.channels_error = str(e)

    local = _channel_ids(root, "refs/heads/channel/")
    remote = _channel_ids(root, "refs/remotes/origin/channel/")
    counts = {}
    for cid in local | remote:
        ref = core.branch_of(cid) if cid in local else f"origin/{core.branch_of(cid)}"
        ab = ahead_behind(root, ref, core.ORIGIN_MAIN)
        if ab:
            counts[cid] = ab
    for key, prod in core.PRODUCTS.items():
        tags = snap.tags_of(prod)
        view = ProductView(
            rows=core.build_rows(prod, snap.channels_doc, tags, snap.releases, local, remote, counts),
            live=core.build_live(prod, snap.channels_doc, tags, snap.releases))
        if view.live.latest and prod.tag(view.live.latest) in snap.tags:
            n = git(root, "rev-list", "--count", f"{prod.tag(view.live.latest)}..{core.ORIGIN_MAIN}")
            view.main_ahead_live = int(n) if n else None
        snap.views[key] = view
    snap.data = core.build_data(snap.channels_doc, snap.tags, snap.releases)
    snap.drafts = core.list_drafts(snap.releases)
    snap.pending = pending_releases(root, snap.tags)
    return snap


# --- pull requests and bumps merged to main ------------------------------------


def pull_requests(root: Path) -> list[dict] | None:
    """Every pull request (newest 100) as gh reports it, None when gh fails."""
    out = query(root, "gh", "pr", "list", "--state", "all", "--limit", "100",
                "--json", "number,state,headRefName,baseRefName")
    try:
        return json.loads(out) if out else None
    except ValueError:
        return None


def pr_view(root: Path, branch: str) -> core.PrView | None:
    """The pull request of `branch` with its checks, None when there is none."""
    out = query(root, "gh", "pr", "view", branch, "--json",
                "number,state,url,title,mergeStateStatus,statusCheckRollup")
    try:
        return core.parse_pr(json.loads(out)) if out else None
    except ValueError:
        return None


def merged_pr_heads(root: Path, branch: str) -> set[str]:
    """The head commits of merged pull requests from `branch` (a squash merge
    leaves the branch outside main's history, this is how to tell it is done)."""
    out = query(root, "gh", "pr", "list", "--head", branch, "--state", "merged",
                "--json", "headRefOid")
    try:
        return {str(x["headRefOid"]) for x in json.loads(out)} if out else set()
    except (ValueError, KeyError, TypeError):
        return set()


def branch_merged(root: Path, ref: str, branch: str) -> bool:
    """`ref` (a local or origin branch) is merged into origin/main: an
    ancestor, or exactly the head of a pull request that was merged."""
    if is_ancestor(root, ref, core.ORIGIN_MAIN):
        return True
    tip = git(root, "rev-parse", ref)
    return bool(tip) and tip in merged_pr_heads(root, branch)


def _version_at(root: Path, ref: str, prod: core.Product) -> core.Version | None:
    text = show_file(root, ref, prod.cargo_toml)
    current = core.cargo_toml_version(text) if text else None
    return core.Version.parse(current, v_prefix=False) if current else None


def bump_commit(root: Path, prod: core.Product, ref: str = core.ORIGIN_MAIN) -> tuple[core.Version, str] | None:
    """The version `ref` carries for `prod` and the commit that introduced it
    (the oldest one of the run of commits on the Cargo.toml that carry it): the
    squash commit of a bump. None when it cannot be read."""
    version = _version_at(root, ref, prod)
    if version is None:
        return None
    shas = (git(root, "log", "--format=%H", "-n", "30", ref, "--", prod.cargo_toml) or "").split()
    found = None
    for sha in shas:
        if _version_at(root, sha, prod) != version:
            break
        found = sha
    return (version, found) if found else None


def untagged_bumps(root: Path, tags: set[str]) -> list[core.Pending]:
    """Live versions on origin/main that are above every live tag of the app and
    have no tag: a bump merged, the tagging not done."""
    out = []
    for prod in core.PRODUCTS.values():
        found = bump_commit(root, prod)
        if not found:
            continue
        version, sha = found
        known = core.versions_in(prod, tags)
        newest_live = max((v for v in known if not v.is_channel), default=None)
        if version.is_channel or prod.tag(version) in tags or (newest_live and version <= newest_live):
            continue
        out.append(core.Pending("untagged", prod.key, version, commit=sha))
    return out


def pending_releases(root: Path, tags: set[str]) -> list[core.Pending]:
    prs = pull_requests(root)
    remote = {name for name in _channel_ids(root, "refs/remotes/origin/release/")}
    remote = {core.RELEASE_PREFIX + name for name in remote}
    return core.build_pending(prs, remote, untagged_bumps(root, tags))


# --- CI build runs -----------------------------------------------------------


def run_for_tag(root: Path, tag: str, workflow: str) -> str | None:
    """The id of the newest `workflow` run a push of `tag` started."""
    jq = f'map(select(.headBranch == "{tag}")) | .[0].databaseId // empty'
    out = query(root, "gh", "run", "list", "--workflow", workflow, "--event",
                "push", "--json", "databaseId,headBranch", "--jq", jq)
    return out.strip() or None if out else None


def run_for_dispatch(root: Path, workflow: str, since: str) -> str | None:
    """The id of the newest manually started run of `workflow` created at or
    after `since` (an ISO UTC time)."""
    jq = f'map(select(.createdAt >= "{since}")) | .[0].databaseId // empty'
    out = query(root, "gh", "run", "list", "--workflow", workflow, "--event",
                "workflow_dispatch", "--json", "databaseId,createdAt", "--jq", jq)
    return out.strip() or None if out else None


def run_view(root: Path, run_id: str) -> dict | None:
    out = query(root, "gh", "run", "view", run_id, "--json", "status,conclusion,url,jobs")
    try:
        return json.loads(out) if out else None
    except ValueError:
        return None


def run_failed_log(root: Path, run_id: str, lines: int = 40) -> str:
    """The tail of the failed steps' log, or empty."""
    out = query(root, "gh", "run", "view", run_id, "--log-failed") or ""
    return "\n".join(out.rstrip().splitlines()[-lines:])
