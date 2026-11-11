"""Headless UI tests against a throwaway git repo (temp dir + local bare
origin; no network). GitHub is replaced: `repo.releases` returns a canned
state, `gh` queries are answered by FakeGH (pull requests, their checks), and
every `gh` / `pnpm` command an action runs is recorded and faked by FakeCtl
instead of being run (git runs for real, against the local origin).

The origin refuses pushes to main (a pre-receive hook: the ruleset of the real
repository), except from the helpers that stand for GitHub's squash merge and
for CI. Every test also checks, at the command level, that the tool never
asked git to push main."""

import asyncio
import gzip
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from textual.widgets import OptionList

from releasectl import actions, core, repo
from releasectl.app import AskScreen, ConfirmScreen, PickScreen, ReleaseCtl

APP_TOML = '[package]\nname = "quartermaster"\nversion = "0.1.0"\nedition = "2021"\n'
APP_LOCK = '[[package]]\nname = "quartermaster"\nversion = "0.1.0"\n'
ROOT_PKG = '{\n  "name": "sc-quartermaster",\n  "version": "0.1.0",\n  "private": true\n}\n'
APP_PKG = '{\n  "name": "sc-quartermaster-app",\n  "private": true,\n  "version": "0.1.0",\n  "type": "module"\n}\n'
COMP_TOML = '[package]\nname = "quartermaster-companion"\nversion = "2.1.0"\nedition = "2021"\n'
COMP_LOCK = ('[[package]]\nname = "quartermaster"\nversion = "9.9.9"\n\n'
             '[[package]]\nname = "quartermaster-companion"\nversion = "2.1.0"\n')
COMP_PKG = '{\n  "name": "sc-quartermaster-companion",\n  "private": true,\n  "version": "2.1.0",\n  "type": "module"\n}\n'

# What GitHub "has" unless a test says otherwise: both apps released once.
RELEASES = {"app-v0.1.0": core.RELEASE, "companion-v2.1.0": core.RELEASE}

ALLOW_MAIN = {"QM_ALLOW_MAIN": "1"}  # the environment of GitHub / CI pushing to main

# The ruleset of main in the real repository: pull requests only.
PRE_RECEIVE = """#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ] && [ -z "$QM_ALLOW_MAIN" ]; then
    echo "main is protected: pull requests only" >&2
    exit 1
  fi
done
"""

CHECKS_PENDING = [{"__typename": "CheckRun", "name": "ci", "status": "IN_PROGRESS", "conclusion": ""}]
CHECKS_OK = [{"__typename": "CheckRun", "name": "ci", "status": "COMPLETED", "conclusion": "SUCCESS"}]


def git(cwd, *args, env=None, check=True):
    p = subprocess.run(["git", *args], cwd=cwd, check=check, capture_output=True, text=True,
                       env={**os.environ, **env} if env else None)
    return p.stdout.strip() if check else p


class Repo:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="releasectl-test-"))
        self.origin = self.tmp / "origin.git"
        self.work = self.tmp / "work"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.origin))
        git(self.tmp, "init", "-q", "-b", "main", str(self.work))
        for k, val in [("user.name", "t"), ("user.email", "t@t"),
                       ("commit.gpgsign", "false"), ("tag.gpgsign", "false"),
                       ("pull.rebase", "false")]:
            git(self.work, "config", k, val)
        for d in ("app/src-tauri", "companion/src-tauri"):
            (self.work / d).mkdir(parents=True)
        self.write("app/src-tauri/Cargo.toml", APP_TOML)
        self.write("app/src-tauri/Cargo.lock", APP_LOCK)
        self.write("package.json", ROOT_PKG)
        self.write("app/package.json", APP_PKG)
        self.write("companion/src-tauri/Cargo.toml", COMP_TOML)
        self.write("companion/src-tauri/Cargo.lock", COMP_LOCK)
        self.write("companion/package.json", COMP_PKG)
        self.write(".gitignore", "/local/\n")
        self.commit("init")
        git(self.work, "tag", "-a", "app-v0.1.0", "-m", "Quartermaster app 0.1.0")
        git(self.work, "tag", "-a", "companion-v2.1.0", "-m", "Quartermaster companion 2.1.0")
        git(self.work, "remote", "add", "origin", str(self.origin))
        git(self.work, "push", "-q", "origin", "main", "app-v0.1.0", "companion-v2.1.0")
        git(self.work, "branch", "channel/x")
        git(self.work, "push", "-q", "origin", "channel/x")
        # From here on origin behaves like the real one: main takes no direct pushes.
        (self.origin / "hooks" / "pre-receive").write_bytes(PRE_RECEIVE.encode())

    def write(self, path, text):
        p = self.work / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def _bot(self):
        bot = self.tmp / "bot"
        if not bot.exists():
            git(self.tmp, "clone", "-q", str(self.origin), str(bot))
            for k, val in [("user.name", "bot"), ("user.email", "b@b"),
                           ("commit.gpgsign", "false"), ("pull.rebase", "false")]:
                git(bot, "config", k, val)
        return bot

    def bot_commit(self, path, text, branch="main"):
        """A commit straight onto origin, like CI or somebody else on another machine."""
        bot = self._bot()
        git(bot, "fetch", "-q", "origin")
        git(bot, "checkout", "-q", "-B", branch, f"origin/{branch}")
        (bot / path).write_text(text)
        git(bot, "add", "-A")
        git(bot, "commit", "-q", "-m", f"bot: {path}")
        git(bot, "push", "-q", "origin", branch, env=ALLOW_MAIN)

    def channels_branch(self, text):
        """CI writing the feed: channels.json on the `channels` branch of origin; fetched here."""
        bot = self._bot()
        git(bot, "fetch", "-q", "origin")
        if git(bot, "branch", "-r", "--list", "origin/channels"):
            git(bot, "checkout", "-q", "-B", "channels", "origin/channels")
        else:
            git(bot, "checkout", "-q", "--orphan", "channels")
            git(bot, "rm", "-rf", "-q", ".")
        (bot / "channels.json").write_text(text)
        git(bot, "add", "channels.json")
        git(bot, "commit", "-q", "-m", "bot: channels.json")
        git(bot, "push", "-q", "origin", "channels")
        git(self.work, "fetch", "-q", "origin")

    def squash_merge(self, branch, title):
        """What GitHub does for `gh pr merge --squash`: one commit on main with the branch's changes."""
        bot = self._bot()
        git(bot, "fetch", "-q", "origin")
        git(bot, "checkout", "-q", "-B", "main", "origin/main")
        git(bot, "merge", "--squash", "-q", f"origin/{branch}")
        git(bot, "commit", "-q", "-m", title)
        git(bot, "push", "-q", "origin", "main", env=ALLOW_MAIN)
        return git(bot, "rev-parse", "HEAD")

    def delete_remote_branch(self, branch):
        git(self.origin, "update-ref", "-d", f"refs/heads/{branch}")

    def commit(self, msg):
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", msg)

    def channel_versions(self, **versions):
        """channel/x carrying app / companion versions (files bumped, tagged), pushed, plus some work."""
        w = self.work
        git(w, "checkout", "-q", "channel/x")
        self.write("feature.txt", "from the channel\n")
        for key, ver in versions.items():
            prod = core.PRODUCTS[key]
            texts = {p: (w / p).read_text() for p in core.version_files(prod)}
            for p, t in core.bump_texts(prod, texts, ver).items():
                self.write(p, t)
        self.commit("channel work")
        tags = [core.PRODUCTS[k].tag(core.Version.parse(v)) for k, v in versions.items()]
        for t in tags:
            git(w, "tag", "-a", t, "-m", "t")
        git(w, "push", "-q", "origin", "channel/x", *tags)
        git(w, "checkout", "-q", "main")

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class FakeGH:
    """The parts of GitHub the tool talks to: pull requests with their checks,
    the squash merge, workflow runs."""

    def __init__(self, repo_):
        self.repo = repo_
        self.prs: dict[str, dict] = {}
        self.checks = CHECKS_OK
        self.merge_blocked = False
        self.dispatches: list[list[str]] = []

    @staticmethod
    def opt(argv, name):
        return argv[argv.index(name) + 1] if name in argv else None

    def view(self, pr):
        pending = any(c.get("status") != "COMPLETED" for c in self.checks)
        return {"number": pr["number"], "state": pr["state"], "url": f"https://github.test/pull/{pr['number']}",
                "title": pr["title"], "mergeStateStatus": "BLOCKED" if pending else "CLEAN",
                "statusCheckRollup": list(self.checks)}

    def query(self, argv):
        """The read-only `gh` calls (repo.query)."""
        if argv[1:3] == ("pr", "list"):
            head, state = self.opt(argv, "--head"), self.opt(argv, "--state")
            if state == "merged":
                return json.dumps([{"headRefOid": p["oid"]} for h, p in self.prs.items()
                                   if h == head and p["state"] == "MERGED"])
            return json.dumps([{"number": p["number"], "state": p["state"], "headRefName": h, "baseRefName": "main"}
                               for h, p in self.prs.items()])
        if argv[1:3] == ("pr", "view"):
            pr = self.prs.get(argv[3])
            return json.dumps(self.view(pr)) if pr else None
        return None

    def run(self, cmd):
        """The write calls (FakeCtl): (ok, output) or None when not ours."""
        if cmd[1:3] == ["pr", "create"]:
            head = self.opt(cmd, "--head")
            assert self.opt(cmd, "--base") == "main", cmd
            oid = git(self.repo.origin, "rev-parse", f"refs/heads/{head}", check=False)
            if oid.returncode:
                return False, f"head branch {head} is not on the remote"
            number = len(self.prs) + 1
            self.prs[head] = {"number": number, "state": "OPEN", "title": self.opt(cmd, "--title"),
                              "body": self.opt(cmd, "--body"), "oid": oid.stdout.strip()}
            return True, f"https://github.test/pull/{number}"
        if cmd[1:3] == ["pr", "merge"]:
            assert "--squash" in cmd, cmd
            assert not {"--auto", "--admin", "--merge", "--rebase"} & set(cmd), cmd
            if self.merge_blocked:
                return False, "Pull request is not mergeable: the required checks have not passed"
            self.do_merge(cmd[3], delete="--delete-branch" in cmd)
            return True, ""
        if cmd[1:3] == ["workflow", "run"]:
            self.dispatches.append(cmd)
            return True, ""
        return None

    def do_merge(self, head, delete):
        pr = self.prs[head]
        pr["sha"] = self.repo.squash_merge(head, pr["title"])
        pr["state"] = "MERGED"
        if delete:
            self.repo.delete_remote_branch(head)
            if git(self.repo.work, "branch", "--list", head) and git(self.repo.work, "branch", "--show-current") != head:
                git(self.repo.work, "branch", "-D", head)


class FakeCtl(ReleaseCtl):
    """The app with `gh` and `pnpm` steps recorded instead of run (git runs for real)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls: list[list[str]] = []  # gh / pnpm steps that ran
        self.all_cmds: list[list[str]] = []  # every command, dry-run or not
        self.fail_on: str | None = None  # a command word that fails, e.g. "pnpm"
        self.gh: FakeGH | None = None

    async def _execute(self, cmd):
        if isinstance(cmd, list):
            self.all_cmds.append(list(cmd))
        if isinstance(cmd, list) and cmd[0] in ("gh", "pnpm") and not self.dry_run:
            self.calls.append(cmd)
            self.log_line("$ " + actions.show(cmd), "cyan")
            if self.fail_on == cmd[0]:
                return False, "failed"
            result = self.gh.run(cmd) if cmd[0] == "gh" else None
            if result is not None:
                if result[1]:
                    self.log_line(result[1], "" if result[0] else "red")
                return result
            self.fake_effect(cmd)
            return True, ""
        return await super()._execute(cmd)

    def fake_effect(self, cmd):
        if cmd[:3] == ["gh", "release", "download"]:
            out = Path(cmd[cmd.index("--dir") + 1])
            out.mkdir(parents=True, exist_ok=True)
            (out / "manifest.json").write_text("{}")
            (out / "thumbs-update.zip").write_bytes(b"zip")
        elif cmd[:2] == ["pnpm", "data:pack"]:
            arg = lambda name: cmd[cmd.index(name) + 1]
            out = Path(arg("--out"))
            out.mkdir(parents=True, exist_ok=True)
            label, n = "4.10.2.12913470", arg("--n")
            tag = f"data-{label}-{n}"
            previous = arg("--previous") if "--previous" in cmd else None
            manifest = {"format": 1, "tag": tag, "previous": "data-4.10.2.12913470-1" if previous else None,
                        "game": {"label": label, "build": 12913470}, "schemaVersion": 7,
                        "files": {"thumbs": {"name": "thumbs-update.zip", "size": 2048, "count": 5}}}
            (out / "manifest.json").write_text(json.dumps(manifest))
            (out / f"quartermaster-data-{label}-{n}.zip").write_bytes(b"x" * 3000)
            (out / "catalog.json.gz").write_bytes(b"x" * 1500)
            (out / "thumbs-update.zip").write_bytes(b"x" * 2048)


def pushes(cmds):
    return [c for c in cmds if c[:2] == ["git", "push"]]


def assert_no_push_to_main(test, cmds):
    """No command that pushes to main: every push names its refs, none of them is main."""
    for cmd in pushes(cmds):
        refs = [a for a in cmd[2:] if not a.startswith("-") and a != "origin"]
        test.assertTrue(refs, f"a push without refs: {cmd}")
        for ref in refs:
            test.assertFalse(core.is_default_branch(ref), f"push to the default branch: {cmd}")
        for flag in ("--force", "-f", "--force-with-lease", "--all", "--mirror"):
            test.assertNotIn(flag, cmd)


def laid_out(screen):
    """The dialog is composed and its buttons have a place on screen."""
    return any(b.region.width > 0 for b in screen.query("#cancel"))


async def modal(app, pilot, kind=None):
    """Wait for the next dialog and return it."""
    for _ in range(400):
        await pilot.pause(0.02)
        if isinstance(app.screen, (ConfirmScreen, AskScreen, PickScreen)):
            if (kind is None or isinstance(app.screen, kind)) and laid_out(app.screen):
                return app.screen
    raise AssertionError(f"no dialog; log: {log_text(app)}")


async def click(app, pilot, selector, wait=50):
    """Click a dialog button and wait (briefly) until that dialog is gone, so the
    next `modal` cannot find it again; a dialog that stays (a validation error) just times out."""
    screen = app.screen
    await pilot.click(selector)
    for _ in range(wait):
        if app.screen is not screen:
            break
        await pilot.pause(0.02)


async def answer(app, pilot, ok, kind=ConfirmScreen, expect=None):
    screen = await modal(app, pilot, kind)
    if expect:
        assert expect in screen.title_text, (expect, screen.title_text, log_text(app)[-1500:])
    title = screen.title_text
    await pilot.click("#ok" if ok else "#cancel")
    # Wait until this dialog is gone, else the next `modal` could find it again.
    for _ in range(400):
        if app.screen is not screen:
            break
        await pilot.pause(0.02)
    return title


async def choose(app, pilot, label, expect=None):
    """Select the option starting with `label` in a pick dialog."""
    screen = await modal(app, pilot, PickScreen)
    if expect:
        assert expect in screen.title_text, (expect, screen.title_text, log_text(app)[-1500:])
    index = next(i for i, o in enumerate(screen.options) if o.startswith(label))
    options = screen.query_one(OptionList)
    options.highlighted = index
    options.action_select()
    for _ in range(400):
        if app.screen is not screen:
            break
        await pilot.pause(0.02)
    return screen


async def idle(app, pilot):
    for _ in range(400):
        await pilot.pause(0.02)
        if not app.busy:
            return
    raise AssertionError("action did not finish")


def log_text(app):
    return "\n".join(line.text for line in app.log_panel.lines)


def select(app, cid):
    ids = [r.id for r in app.active_rows()]
    app.table.move_cursor(row=ids.index(cid))


class Base(unittest.TestCase):
    releases: dict | None = RELEASES
    app_class = FakeCtl

    def setUp(self):
        self.repo = Repo()
        self.gh = FakeGH(self.repo)
        patch = mock.patch.object(repo, "releases", lambda root: (
            (dict(self.releases), None) if self.releases is not None else (None, "no GitHub in tests")))
        patch.start()
        self.addCleanup(patch.stop)
        real_query = repo.query

        def query(root, *argv):  # gh is never run for real
            return self.gh.query(argv) if argv[0] == "gh" else real_query(root, *argv)

        patch = mock.patch.object(repo, "query", query)
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.repo.cleanup)

    def run_app(self, body, dry_run=False, app_class=None):
        commands = []

        async def go():
            app = (app_class or self.app_class)(self.repo.work, dry_run=dry_run)
            app.gh = self.gh
            async with app.run_test(size=(160, 50)) as pilot:
                for _ in range(200):
                    await pilot.pause(0.02)
                    if app.snap.views:
                        break
                try:
                    await body(app, pilot)
                finally:
                    commands.extend(getattr(app, "all_cmds", []))
        asyncio.run(go())
        self.commands = commands
        assert_no_push_to_main(self, commands)


def channels_text(app_ids, companion_ids, data="data-4.10.2.12913470-1"):
    def section(key, stable, prefix, ids, ver):
        entries = "".join(
            f'      {{\n        "id": "{i}",\n        "tag": "{prefix}{ver}-{i}.1"\n      }}{"," if k < len(ids) - 1 else ""}\n'
            for k, i in enumerate(ids))
        return f'  "{key}": {{\n    "stable": "{stable}",\n    "channels": [\n{entries}    ]\n  }}'
    return ("{\n" + section("app", "app-v0.1.0", "app-v", app_ids, "0.2.0") + ",\n" +
            section("companion", "companion-v2.1.0", "companion-v", companion_ids, "2.2.0") +
            f',\n  "data": {{\n    "stable": "{data}"\n  }}\n}}\n')


class AppTests(Base):
    # --- bumps of a channel version: direct on the channel branch ---

    def test_bump_channel_real_for_the_app(self):
        async def body(app, pilot):
            select(app, "x")
            await pilot.press("b")
            screen = await modal(app, pilot, AskScreen)
            self.assertEqual(screen.value, "0.2.0-x.1")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Bump app to 0.2.0-x.1")
            await answer(app, pilot, False, expect="Push channel/x and app-v0.2.0-x.1")
            await idle(app, pilot)

        self.run_app(body)
        w = self.repo.work
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(w, "log", "-1", "--format=%s", "channel/x"), "Bump app version to 0.2.0-x.1")
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0-x.1"), "tag")
        self.assertEqual(git(w, "tag", "-l", "companion-v*"), "companion-v2.1.0")
        self.assertEqual(git(w, "tag", "-l", "v0.*"), "")
        # Every file the app reports its version from moved, and nothing else.
        changed = git(w, "diff", "--name-only", "main", "channel/x").split("\n")
        self.assertEqual(sorted(changed), sorted(core.version_files(core.APP)))
        self.assertIn('version = "0.2.0-x.1"', git(w, "show", "channel/x:app/src-tauri/Cargo.lock"))
        self.assertIn('"version": "0.2.0-x.1"', git(w, "show", "channel/x:package.json"))
        self.assertIn('"version": "0.2.0-x.1"', git(w, "show", "channel/x:app/package.json"))
        self.assertIn('version = "2.1.0"', git(w, "show", "channel/x:companion/src-tauri/Cargo.toml"))
        self.assertEqual(git(w, "status", "--porcelain"), "")
        # Nothing pushed.
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0-x.1"), "")

    def test_bump_channel_pushes_the_channel_branch_and_the_tag_not_main(self):
        async def body(app, pilot):
            select(app, "x")
            await pilot.press("b")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Bump app to 0.2.0-x.1")
            await answer(app, pilot, True, expect="Push channel/x and app-v0.2.0-x.1")
            await answer(app, pilot, False, expect="Watch the CI build")
            await idle(app, pilot)

        main_before = git(self.repo.origin, "rev-parse", "main")
        self.run_app(body)
        self.assertEqual([c[2:] for c in pushes(self.commands)],
                         [["origin", "channel/x"], ["origin", "app-v0.2.0-x.1"]])
        self.assertEqual(git(self.repo.origin, "rev-parse", "main"), main_before)
        self.assertEqual(git(self.repo.origin, "log", "-1", "--format=%s", "channel/x"), "Bump app version to 0.2.0-x.1")
        self.assertEqual(git(self.repo.origin, "cat-file", "-t", "app-v0.2.0-x.1"), "tag")

    def test_bump_channel_real_for_the_companion(self):
        async def body(app, pilot):
            await pilot.press("a")
            self.assertEqual(app.product, "companion")
            select(app, "x")
            await pilot.press("b")
            screen = await modal(app, pilot, AskScreen)
            self.assertEqual(screen.value, "2.2.0-x.1")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Bump companion to 2.2.0-x.1")
            await answer(app, pilot, False, expect="Push channel/x and companion-v2.2.0-x.1")
            await idle(app, pilot)

        self.run_app(body)
        w = self.repo.work
        self.assertEqual(git(w, "log", "-1", "--format=%s", "channel/x"), "Bump companion version to 2.2.0-x.1")
        self.assertEqual(git(w, "cat-file", "-t", "companion-v2.2.0-x.1"), "tag")
        changed = git(w, "diff", "--name-only", "main", "channel/x").split("\n")
        self.assertEqual(sorted(changed), sorted(core.version_files(core.COMPANION)))
        lock = git(w, "show", "channel/x:companion/src-tauri/Cargo.lock")
        self.assertIn('name = "quartermaster-companion"\nversion = "2.2.0-x.1"', lock)
        self.assertIn('name = "quartermaster"\nversion = "9.9.9"', lock)  # not ours
        self.assertEqual(git(w, "show", "channel/x:app/src-tauri/Cargo.toml").count('"0.1.0"'), 1)
        self.assertEqual(git(w, "status", "--porcelain"), "")

    def test_bump_channel_dry_run_changes_nothing(self):
        before = git(self.repo.work, "show-ref")

        async def body(app, pilot):
            await pilot.press("a")
            select(app, "x")
            await pilot.press("b")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Bump companion to")
            await answer(app, pilot, True, expect="Push channel/x")
            await answer(app, pilot, True, expect="Watch the CI build")
            await idle(app, pilot)
            log = log_text(app)
            self.assertIn("[dry-run] $ git checkout channel/x", log)
            self.assertIn("[dry-run] $ git tag -a companion-v2.2.0-x.1", log)
            self.assertIn("[dry-run] $ git push origin companion-v2.2.0-x.1", log)
            self.assertIn("[dry-run] $ gh run list --workflow build-companion.yml", log)
            self.assertIn("[dry-run] $ git checkout main", log)

        self.run_app(body, dry_run=True)
        self.assertEqual(git(self.repo.work, "show-ref"), before)
        self.assertEqual(git(self.repo.work, "status", "--porcelain"), "")

    def test_bump_channel_pull_conflict_is_undone(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "bot\n", branch="channel/x")
        git(w, "checkout", "-q", "channel/x")
        self.repo.write("README.md", "local\n")
        self.repo.commit("local readme")
        git(w, "checkout", "-q", "main")
        git(w, "fetch", "-q", "origin")
        head = git(w, "rev-parse", "channel/x")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("b")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Switch to channel/x")
            await idle(app, pilot)
            log = log_text(app)
            self.assertIn("Conflicts, pull undone", log)
            self.assertIn("README.md", log)

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "channel/x"), head)
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(w, "tag", "-l", "app-v0.2.0-x.1"), "")

    def test_a_live_version_cannot_be_committed_directly(self):
        with self.assertRaises(actions.Stop):
            asyncio.run(actions.bump(mock.Mock(dry_run=True), core.APP, core.Version(0, 2, 0), "main"))

    # --- bump live: through a pull request ---

    async def to_gate(self, app, pilot, version="0.2.0", prod="app", key="l"):
        """Bump live up to the first look at the pull request."""
        await pilot.press(key)
        await answer(app, pilot, True, AskScreen)
        await answer(app, pilot, True, expect="Fetch origin")
        await answer(app, pilot, True, expect=f"Bump {prod} to {version} (pull request)")

    async def merge_and_tag(self, app, pilot, tag):
        await choose(app, pilot, "Merge now")
        await answer(app, pilot, True, expect="Merge PR #")
        await answer(app, pilot, True, expect=f"Tag {tag} on ")
        await answer(app, pilot, False, expect="Watch the CI build")

    def test_bump_live_through_a_pull_request_then_the_tag_on_the_squash_commit(self):
        w = self.repo.work
        local_main = git(w, "rev-parse", "main")
        self.gh.checks = CHECKS_PENDING

        async def body(app, pilot):
            await pilot.press("l")
            screen = await modal(app, pilot, AskScreen)
            self.assertEqual(screen.value, "0.2.0")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Bump app to 0.2.0 (pull request)")
            # The checks are still running: wait, refresh, then merge.
            await choose(app, pilot, "Refresh", expect="PR #1")
            self.gh.checks = CHECKS_OK
            await choose(app, pilot, "Refresh")
            screen = await choose(app, pilot, "Merge now", expect="1 passed")
            await answer(app, pilot, True, expect="Merge PR #1 (release/app-v0.2.0)")
            await answer(app, pilot, True, expect="Tag app-v0.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await idle(app, pilot)
            self.assertIn("✓ Bump live: done", log_text(app))

        self.run_app(body)
        # The pull request: from the release branch to main, with a clear title and body.
        create = next(c for c in self.commands if c[:3] == ["gh", "pr", "create"])
        self.assertEqual(create[3:7], ["--base", "main", "--head", "release/app-v0.2.0"])
        self.assertEqual(create[create.index("--title") + 1], "Bump app version to 0.2.0")
        self.assertIn("app-v0.2.0", create[create.index("--body") + 1])
        self.assertIn(["gh", "pr", "merge", "release/app-v0.2.0", "--squash", "--delete-branch"], self.commands)
        # The branch was cut from origin/main and holds exactly the bump; main got one squash commit.
        squash = git(w, "rev-parse", "origin/main")
        self.assertEqual(git(w, "log", "-1", "--format=%s", "origin/main"), "Bump app version to 0.2.0")
        self.assertEqual(sorted(git(w, "diff", "--name-only", "origin/main~1", "origin/main").split("\n")),
                         sorted(core.version_files(core.APP)))
        for path in core.version_files(core.APP):
            self.assertIn('"0.2.0"', git(w, "show", f"origin/main:{path}"), path)
        # The tag is annotated, on the squash commit, pushed.
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0"), "tag")
        self.assertEqual(git(w, "rev-parse", "app-v0.2.0^{commit}"), squash)
        self.assertEqual(git(w, "tag", "-l", "--format=%(contents:subject)", "app-v0.2.0"), "Quartermaster app 0.2.0")
        self.assertEqual(git(self.repo.origin, "rev-parse", "app-v0.2.0^{commit}"), squash)
        # The tool left the local main and the checkout alone; the branch is gone; the companion untouched.
        self.assertEqual(git(w, "rev-parse", "main"), local_main)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(w, "branch", "--list", "release/*"), "")
        self.assertEqual(git(self.repo.origin, "branch", "--list", "release/*"), "")
        self.assertEqual(git(w, "tag", "-l", "companion-v*"), "companion-v2.1.0")

    def test_bump_live_for_the_companion(self):
        async def body(app, pilot):
            await pilot.press("a")
            await self.to_gate(app, pilot, "2.2.0", "companion")
            await self.merge_and_tag(app, pilot, "companion-v2.2.0")
            await idle(app, pilot)

        self.run_app(body)
        w = self.repo.work
        self.assertEqual(git(w, "rev-parse", "companion-v2.2.0^{commit}"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(sorted(git(w, "diff", "--name-only", "origin/main~1", "origin/main").split("\n")),
                         sorted(core.version_files(core.COMPANION)))
        self.assertEqual(git(w, "tag", "-l", "app-v*"), "app-v0.1.0")

    def test_a_scratch_file_is_not_part_of_the_bump_commit(self):
        self.repo.write("scratch.txt", "x")  # untracked: neither blocks nor is committed

        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(body)
        files = git(self.repo.origin, "show", "--name-only", "--format=", "release/app-v0.2.0").split("\n")
        self.assertEqual(sorted(files), sorted(core.version_files(core.APP)))
        self.assertTrue((self.repo.work / "scratch.txt").exists())

    def test_the_bump_branch_is_cut_from_origin_main_not_the_local_main(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "v0.1.0\n")  # on origin, not fetched yet
        self.repo.write("feature.txt", "x\n")
        self.repo.commit("local work on main")  # never pushed: main takes no pushes
        local_main = git(w, "rev-parse", "main")

        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "show", "release/app-v0.2.0:README.md"), "v0.1.0")
        self.assertFalse(git(self.repo.origin, "ls-tree", "release/app-v0.2.0", "feature.txt"))
        self.assertEqual(git(w, "rev-parse", "main"), local_main)

    def test_declining_the_merge_leaves_the_pull_request_open_and_untagged(self):
        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, False, expect="Merge PR #1")
            await choose(app, pilot, "Leave it")  # asked again: not merged by a no
            await idle(app, pilot)

        main = git(self.repo.origin, "rev-parse", "main")
        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "rev-parse", "main"), main)
        self.assertEqual(self.gh.prs["release/app-v0.2.0"]["state"], "OPEN")
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")
        self.assertFalse([c for c in self.commands if c[:3] == ["gh", "pr", "merge"]])

    def test_a_refused_merge_is_reported_and_nothing_is_tagged(self):
        self.gh.merge_blocked = True

        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, True, expect="Merge PR #1")
            self.assertIn("did not go through", log_text(app))
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")
        self.assertEqual(git(self.repo.origin, "log", "-1", "--format=%s", "main"), "init")

    def test_a_pull_request_with_failing_checks_says_so_in_the_merge_dialog(self):
        self.gh.checks = [{"__typename": "CheckRun", "name": "tests", "status": "COMPLETED", "conclusion": "FAILURE"}]

        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Merge now", expect="1 failed")
            screen = await modal(app, pilot, ConfirmScreen)
            self.assertIn("Not clean", screen.note)
            await answer(app, pilot, False)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(body)

    def test_leaving_at_the_gate_is_picked_up_later_merge_then_tag(self):
        w = self.repo.work

        async def first(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(first)
        self.assertEqual(self.gh.prs["release/app-v0.2.0"]["state"], "OPEN")
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")

        async def second(app, pilot):
            self.assertIn("pull request #1 (release/app-v0.2.0) is open", "\n".join(app.live_lines()))
            await pilot.press("l")
            screen = await choose(app, pilot, "pull request #1", expect="Unfinished release work")
            self.assertEqual(screen.options[-1], actions.UNFINISHED_NEW)
            await self.merge_and_tag(app, pilot, "app-v0.2.0")
            await idle(app, pilot)

        self.run_app(second)
        self.assertEqual(git(w, "rev-parse", "app-v0.2.0^{commit}"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(self.repo.origin, "rev-parse", "app-v0.2.0^{commit}"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(w, "log", "-1", "--format=%s", "origin/main"), "Bump app version to 0.2.0")

    def test_a_bump_merged_elsewhere_is_detected_and_offered_for_tagging(self):
        w = self.repo.work

        async def first(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(first)
        self.gh.do_merge("release/app-v0.2.0", delete=False)  # merged in the browser; the branch stays
        git(w, "fetch", "-q", "origin")

        async def second(app, pilot):
            self.assertEqual([(p.kind, p.product, str(p.version)) for p in app.snap.pending],
                             [("untagged", "app", "0.2.0")])
            self.assertIn("app-v0.2.0 is not tagged", "\n".join(app.live_lines()))
            await pilot.press("l")
            await choose(app, pilot, "app 0.2.0 is on main")
            await answer(app, pilot, True, expect="Tag app-v0.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await idle(app, pilot)

        self.run_app(second)
        self.assertEqual(git(w, "rev-parse", "app-v0.2.0^{commit}"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(self.repo.origin, "cat-file", "-t", "app-v0.2.0"), "tag")

        async def third(app, pilot):
            self.assertEqual(app.snap.pending, [])  # tagged: nothing left

        self.run_app(third)

    def test_a_declined_tag_is_offered_again(self):
        async def first(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, True, expect="Merge PR #1")
            await answer(app, pilot, False, expect="Tag app-v0.2.0 on ")
            await idle(app, pilot)
            self.assertIn("Not tagged", log_text(app))

        self.run_app(first)
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")

        async def second(app, pilot):
            self.assertEqual([p.kind for p in app.snap.pending], ["untagged"])
            await pilot.press("l")
            await choose(app, pilot, "app 0.2.0 is on main")
            await answer(app, pilot, True, expect="Tag app-v0.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await idle(app, pilot)

        self.run_app(second)
        self.assertEqual(git(self.repo.origin, "rev-parse", "app-v0.2.0^{commit}"), git(self.repo.origin, "rev-parse", "main"))

    def test_a_pushed_release_branch_without_a_pull_request_is_continued(self):
        w = self.repo.work

        async def first(app, pilot):
            await self.to_gate(app, pilot)
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(first)
        del self.gh.prs["release/app-v0.2.0"]  # the pull request was never made / got lost

        async def second(app, pilot):
            self.assertEqual([(p.kind, p.branch) for p in app.snap.pending], [("branch", "release/app-v0.2.0")])
            await pilot.press("l")
            await choose(app, pilot, "release/app-v0.2.0 is pushed")
            await answer(app, pilot, True, expect="Open the pull request of release/app-v0.2.0")
            await self.merge_and_tag(app, pilot, "app-v0.2.0")
            await idle(app, pilot)

        self.run_app(second)
        self.assertEqual(git(w, "rev-parse", "app-v0.2.0^{commit}"), git(w, "rev-parse", "origin/main"))

    def test_a_squash_commit_that_does_not_carry_the_version_everywhere_is_not_tagged(self):
        # A "bump" that only touched Cargo.toml landed on main by some other road.
        self.repo.bot_commit("app/src-tauri/Cargo.toml", APP_TOML.replace("0.1.0", "0.2.0"))
        git(self.repo.work, "fetch", "-q", "origin")

        async def body(app, pilot):
            self.assertEqual([p.kind for p in app.snap.pending], ["untagged"])
            await pilot.press("l")
            await choose(app, pilot, "app 0.2.0 is on main")
            await idle(app, pilot)
            self.assertIn("does not carry exactly 0.2.0", log_text(app))
            self.assertIn("not tagging", log_text(app))

        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")

    def test_bump_live_dry_run_prints_the_whole_flow_and_changes_nothing(self):
        before = git(self.repo.work, "show-ref")
        origin_before = git(self.repo.origin, "show-ref")

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Bump app to 0.2.0 (pull request)")
            await answer(app, pilot, True, expect="Merge release/app-v0.2.0")
            await idle(app, pilot)
            log = log_text(app).replace(chr(10), "")  # the log wraps long lines
            for line in ["[dry-run] $ git fetch --prune origin",
                         "[dry-run] $ git checkout --no-track -b release/app-v0.2.0 origin/main",
                         "[dry-run] $ git push -u origin release/app-v0.2.0",
                         "[dry-run] $ gh pr create --base main --head release/app-v0.2.0",
                         "[dry-run] $ gh pr merge release/app-v0.2.0 --squash --delete-branch",
                         "[dry-run] $ git tag -a app-v0.2.0",
                         "<squash commit on origin/main>",
                         "[dry-run] $ git push origin app-v0.2.0",
                         "[dry-run] $ git checkout main"]:
                self.assertIn(line, log)

        self.run_app(body, dry_run=True)
        self.assertEqual(git(self.repo.work, "show-ref"), before)
        self.assertEqual(git(self.repo.origin, "show-ref"), origin_before)
        self.assertEqual(git(self.repo.work, "status", "--porcelain"), "")
        self.assertEqual(self.gh.prs, {})

    def test_bump_live_refuses_files_that_disagree(self):
        self.repo.bot_commit("app/package.json", APP_PKG.replace("0.1.0", "0.0.9"))

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Fetch origin")
            await idle(app, pilot)
            self.assertIn("app/package.json was not updated", log_text(app))

        self.run_app(body)
        self.assertEqual(git(self.repo.work, "branch", "--list", "release/*"), "")
        self.assertEqual(git(self.repo.origin, "branch", "--list", "release/*"), "")

    def test_bump_live_stops_when_the_release_branch_exists(self):
        git(self.repo.work, "branch", "release/app-v0.2.0")

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await idle(app, pilot)
            self.assertIn("release/app-v0.2.0 exists already", log_text(app))

        self.run_app(body)

    def test_a_failed_commit_removes_the_local_branch_again(self):
        w = self.repo.work
        # Provoke a failure of the commit (a pre-commit hook that refuses) before anything is pushed.
        (w / ".git" / "hooks" / "pre-commit").write_bytes(b"#!/bin/sh\nexit 1\n")

        async def body(app, pilot):
            await self.to_gate(app, pilot)
            await idle(app, pilot)
            self.assertIn("Bump failed; the local branch is removed again", log_text(app))

        self.run_app(body)
        self.assertEqual(git(w, "branch", "--list", "release/*"), "")
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(self.repo.origin, "branch", "--list", "release/*"), "")

    def test_the_two_apps_do_not_share_proposals(self):
        async def body(app, pilot):
            await pilot.press("l")
            self.assertEqual((await modal(app, pilot, AskScreen)).value, "0.2.0")
            await click(app, pilot, "#cancel")
            await idle(app, pilot)
            await pilot.press("a")
            await pilot.press("l")
            self.assertEqual((await modal(app, pilot, AskScreen)).value, "2.2.0")
            await click(app, pilot, "#cancel")
            await idle(app, pilot)

        self.run_app(body)

    def test_bump_live_rejects_a_channel_version_and_old_ones(self):
        from releasectl.actions import _check_live_version

        async def body(app, pilot):
            self.assertEqual(_check_live_version(core.APP, "0.2.0-x.1", app.snap), "x.y.z")
            self.assertEqual(_check_live_version(core.APP, "0.1.0", app.snap), "not above live 0.1.0")
            self.assertIsNone(_check_live_version(core.APP, "0.2.0", app.snap))
            # The other app's version line is its own.
            self.assertIsNone(_check_live_version(core.COMPANION, "2.2.0", app.snap))
            self.assertEqual(_check_live_version(core.COMPANION, "2.1.0", app.snap), "not above live 2.1.0")
            await pilot.press("l")
            screen = await modal(app, pilot, AskScreen)
            screen.query_one("Input").value = "0.1.0"
            await click(app, pilot, "#ok")
            await pilot.pause(0.1)
            self.assertIn("not above live", str(screen.query_one("#error").content))
            await click(app, pilot, "#cancel")
            await idle(app, pilot)

        before = git(self.repo.work, "show-ref")
        self.run_app(body)
        self.assertEqual(git(self.repo.work, "show-ref"), before)

    # --- channels ---

    def test_new_channel_is_cut_from_origin_main(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "bot\n")  # on origin only
        self.repo.write("feature.txt", "x\n")
        self.repo.commit("local work on main")  # the local main is not what a channel starts from
        git(w, "checkout", "-q", "channel/x")
        local_main = git(w, "rev-parse", "main")

        async def body(app, pilot):
            await pilot.press("n")
            screen = await modal(app, pilot, AskScreen)
            screen.query_one("Input").value = "y"
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Create channel/y")
            await answer(app, pilot, True, expect="Push channel/y")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "channel/x")
        self.assertEqual(git(w, "show", "channel/y:README.md"), "bot")
        self.assertFalse(git(w, "ls-tree", "channel/y", "feature.txt"))
        self.assertEqual(git(w, "rev-parse", "channel/y"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(self.repo.origin, "rev-parse", "channel/y"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(w, "rev-parse", "main"), local_main)

    def test_a_new_channel_shows_up_for_both_apps(self):
        async def body(app, pilot):
            self.assertEqual([r.id for r in app.active_rows()], ["x"])
            await pilot.press("a")
            self.assertEqual([r.id for r in app.active_rows()], ["x"])
            self.assertEqual(app.channels_panel.border_title, "Channels of the companion")

        self.run_app(body)

    def test_new_channel_rejects_an_id_either_app_uses(self):
        self.releases = dict(RELEASES, **{"companion-v2.2.0-only.1": core.PRERELEASE})

        async def body(app, pilot):
            await pilot.press("n")
            screen = await modal(app, pilot, AskScreen)
            screen.query_one("Input").value = "only"
            await click(app, pilot, "#ok")
            await pilot.pause(0.1)
            self.assertIn("exists", str(screen.query_one("#error").content))
            await click(app, pilot, "#cancel")
            await idle(app, pilot)

        self.run_app(body)

    def test_sync_merges_origin_main_into_the_channel_and_pushes_the_channel(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "from main\n")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("s")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Merge origin/main into channel/x")
            await answer(app, pilot, True, expect="Push channel/x")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "show", "channel/x:README.md"), "from main")
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual([c[2:] for c in pushes(self.commands)], [["origin", "channel/x"]])

    def test_sync_conflict_is_aborted(self):
        w = self.repo.work
        git(w, "checkout", "-q", "channel/x")
        self.repo.write("app/package.json", APP_PKG.replace("true", "false"))
        self.repo.commit("channel change")
        git(w, "checkout", "-q", "main")
        self.repo.bot_commit("app/package.json", APP_PKG.replace('"private": true', '"private": 1'))

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("s")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Merge origin/main into channel/x")
            await idle(app, pilot)
            self.assertIn("Conflicts, merge aborted", log_text(app))

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertFalse((w / ".git" / "MERGE_HEAD").exists())
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(w, "log", "-1", "--format=%s", "channel/x"), "channel change")

    # --- the feed: read from the channels branch, removal through the workflow ---

    def test_the_feed_is_read_from_the_channels_branch_not_from_main(self):
        decoy = '{"app": {"stable": "app-v9.9.9", "channels": [{"id": "z", "tag": "app-v9.9.9-z.1"}]}}\n'
        self.repo.bot_commit("channels.json", decoy)  # an old copy on main: ignored
        self.repo.channels_branch(channels_text(["x"], []))
        self.releases = dict(RELEASES, **{"app-v0.2.0-x.1": core.PRERELEASE})

        async def body(app, pilot):
            self.assertTrue(app.snap.channels_file)
            self.assertIsNone(app.snap.channels_error)
            self.assertEqual(core.stable_of(app.snap.channels_doc, "app"), "app-v0.1.0")
            rows = {r.id: r for r in app.active_rows()}
            self.assertEqual(sorted(rows), ["x"])
            self.assertTrue(rows["x"].listed)
            self.assertEqual(rows["x"].listed_tag, "app-v0.2.0-x.1")
            self.assertIn("channels.json stable", "\n".join(app.live_lines()))

        self.run_app(body)

    def test_no_channels_branch_means_nothing_released_yet_and_no_error(self):
        async def body(app, pilot):
            self.assertFalse(app.snap.channels_file)
            self.assertIsNone(app.snap.channels_error)
            self.assertEqual(app.snap.channels_doc, {})
            self.assertIn("Nothing released yet", "\n".join(app.live_lines()))

        self.run_app(body)

    def test_a_channels_branch_without_the_file_is_nothing_released_too(self):
        bot = self.repo._bot()
        git(bot, "checkout", "-q", "--orphan", "channels")
        git(bot, "rm", "-rf", "-q", ".")
        (bot / "other.txt").write_text("x")
        git(bot, "add", "other.txt")
        git(bot, "commit", "-q", "-m", "x")
        git(bot, "push", "-q", "origin", "channels")
        git(self.repo.work, "fetch", "-q", "origin")

        async def body(app, pilot):
            self.assertFalse(app.snap.channels_file)
            self.assertIsNone(app.snap.channels_error)

        self.run_app(body)

    def test_remove_channel_starts_the_workflow_and_commits_nothing(self):
        w = self.repo.work
        self.repo.channels_branch(channels_text(["x", "y"], ["x"]))
        refs = git(self.repo.origin, "show-ref")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            screen = await modal(app, pilot, ConfirmScreen)
            self.assertIn("Remove the x channel of the app", screen.title_text)
            self.assertTrue(screen.sensitive)
            self.assertIn("channels.yml", " ".join(screen.cmds[0]))
            self.assertIn("The feed changes when that run is through", screen.note)
            await click(app, pilot, "#ok")
            await answer(app, pilot, False, expect="Watch the channels.yml run")
            await idle(app, pilot)
            log = log_text(app)
            self.assertIn("still listed for the companion", log)
            self.assertIn("The feed changes when the run is through", log)

        self.run_app(body)
        self.assertEqual(self.gh.dispatches, [["gh", "workflow", "run", "channels.yml", "-f", "product=app",
                                               "-f", "channel=x", "-f", "action=remove"]])
        # No commit, no push, no ref moved anywhere: CI changes the feed.
        self.assertEqual(git(self.repo.origin, "show-ref"), refs)
        self.assertEqual(pushes(self.commands), [])
        self.assertFalse([c for c in self.commands if c[:2] in (["git", "commit"], ["git", "add"])])
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "channel/x")

    def test_remove_for_the_companion_names_the_companion(self):
        self.repo.channels_branch(channels_text(["x"], ["x"]))

        async def body(app, pilot):
            await pilot.press("a")
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, True, expect="Remove the x channel of the companion")
            await answer(app, pilot, False, expect="Watch the channels.yml run")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(self.gh.dispatches[0][4:], ["-f", "product=companion", "-f", "channel=x", "-f", "action=remove"])

    def test_remove_channel_then_the_merged_branch_is_offered(self):
        w = self.repo.work
        self.repo.channels_branch(channels_text(["x", "y"], ["y"]))

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, True, expect="Remove the x channel of the app")
            await answer(app, pilot, False, expect="Watch the channels.yml run")
            await answer(app, pilot, True, expect="Delete local channel/x")
            await answer(app, pilot, False, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(len(self.gh.dispatches), 1)
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "")
        self.assertIn("channel/x", git(self.repo.origin, "branch", "--list", "channel/x"))

    def test_remove_channel_branch_delete_on_origin_is_a_channel_branch_push(self):
        self.repo.channels_branch(channels_text(["x"], []))

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, True, expect="Remove the x channel")
            await answer(app, pilot, False, expect="Watch the channels.yml run")
            await answer(app, pilot, False, expect="Delete local channel/x")
            await answer(app, pilot, True, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual([c[2:] for c in pushes(self.commands)], [["origin", "--delete", "channel/x"]])
        self.assertEqual(git(self.repo.origin, "branch", "--list", "channel/x"), "")

    def test_a_failed_workflow_start_is_reported(self):
        self.repo.channels_branch(channels_text(["x"], []))

        async def body(app, pilot):
            app.fail_on = "gh"
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, True, expect="Remove the x channel")
            await idle(app, pilot)
            self.assertIn("The workflow was not started", log_text(app))

        self.run_app(body)

    def test_remove_an_unlisted_channel_stops(self):
        self.repo.channels_branch(channels_text(["y"], ["y"]))

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await idle(app, pilot)
            self.assertIn("x is not in channels.json for the app", log_text(app))

        self.run_app(body)
        self.assertEqual(self.gh.dispatches, [])

    def test_remove_dry_run_prints_the_workflow_call_and_runs_nothing(self):
        self.repo.channels_branch(channels_text(["x"], ["x"]))

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, True, expect="Remove the x channel")
            await answer(app, pilot, True, expect="Watch the channels.yml run")
            await idle(app, pilot)
            log = log_text(app).replace("\n", "")  # the log wraps long lines
            self.assertIn("[dry-run] $ gh workflow run channels.yml -f product=app -f channel=x -f action=remove", log)
            self.assertIn("[dry-run] $ gh run list --workflow channels.yml --event workflow_dispatch", log)

        self.run_app(body, dry_run=True)
        self.assertEqual(self.gh.dispatches, [])

    # --- finalize: a channel to main through one pull request ---

    def finalize_releases(self, **tags):
        self.releases = dict(RELEASES, **{t: core.PRERELEASE for t in tags})

    async def finalize_to_gate(self, app, pilot, versions, switch=True):
        """f up to the first look at the pull request; `versions` are the proposals asked, in order."""
        select(app, "x")
        await pilot.press("f")
        await answer(app, pilot, True, expect="Fetch origin")
        for prod, version in versions:
            screen = await modal(app, pilot, AskScreen)
            self.assertIn(f"{prod} live version", screen.title_text)
            self.assertEqual(screen.value, version)
            await click(app, pilot, "#ok")
        await answer(app, pilot, True, expect="Switch to channel/x")
        await answer(app, pilot, True, expect="Finalize x: bump, push, pull request")

    def test_finalize_one_pull_request_bumps_merges_tags_and_offers_the_branch_for_deletion(self):
        w = self.repo.work
        self.repo.channel_versions(app="0.2.0-x.1", companion="2.2.0-x.1")
        self.finalize_releases(**{"app-v0.2.0-x.1": 1, "companion-v2.2.0-x.1": 1})
        local_main = git(w, "rev-parse", "main")

        async def body(app, pilot):
            await self.finalize_to_gate(app, pilot, [("app", "0.2.0"), ("companion", "2.2.0")])
            await choose(app, pilot, "Merge now", expect="Finalize x")
            await answer(app, pilot, True, expect="Merge PR #1 (channel/x)")
            await answer(app, pilot, True, expect="Tag app-v0.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await answer(app, pilot, True, expect="Tag companion-v2.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            screen = await modal(app, pilot, ConfirmScreen)
            self.assertIn("Delete local channel/x", screen.title_text)
            self.assertIn("Squash-merged", screen.note)  # not an ancestor of main: -D, said so
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Delete channel/x on origin")
            await idle(app, pilot)
            self.assertIn("✓ Finalize: done", log_text(app))

        self.run_app(body)
        # One pull request channel/x -> main with a title that names the versions.
        create = next(c for c in self.commands if c[:3] == ["gh", "pr", "create"])
        self.assertEqual(create[3:7], ["--base", "main", "--head", "channel/x"])
        self.assertEqual(create[create.index("--title") + 1], "Finalize channel x: app 0.2.0, companion 2.2.0")
        self.assertIn(["gh", "pr", "merge", "channel/x", "--squash"], [c[:5] for c in self.commands])
        merge = next(c for c in self.commands if c[:3] == ["gh", "pr", "merge"])
        self.assertNotIn("--delete-branch", merge)  # the branch is offered, not deleted behind the user's back
        # main: one squash commit with the channel's work and both live versions.
        squash = git(w, "rev-parse", "origin/main")
        self.assertEqual(git(w, "show", "origin/main:feature.txt"), "from the channel")
        for path in core.version_files(core.APP):
            self.assertIn('"0.2.0"', git(w, "show", f"origin/main:{path}"), path)
        for path in core.version_files(core.COMPANION):
            self.assertIn('"2.2.0"', git(w, "show", f"origin/main:{path}"), path)
        for tag in ("app-v0.2.0", "companion-v2.2.0"):
            self.assertEqual(git(w, "cat-file", "-t", tag), "tag")
            self.assertEqual(git(w, "rev-parse", f"{tag}^{{commit}}"), squash)
            self.assertEqual(git(self.repo.origin, "rev-parse", f"{tag}^{{commit}}"), squash)
        # The channel ended: branch gone locally and on origin; local main and the checkout untouched.
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "")
        self.assertEqual(git(self.repo.origin, "branch", "--list", "channel/x"), "")
        self.assertEqual(git(w, "rev-parse", "main"), local_main)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(w, "status", "--porcelain"), "")
        # The channel branch was pushed (no -u: origin had it), nothing else but tags and the deletion.
        self.assertEqual([c[2:] for c in pushes(self.commands)],
                         [["origin", "channel/x"], ["origin", "app-v0.2.0"], ["origin", "companion-v2.2.0"],
                          ["origin", "--delete", "channel/x"]])

    def test_finalize_the_bump_commits_are_the_last_commits_of_the_channel(self):
        self.repo.channel_versions(app="0.2.0-x.1", companion="2.2.0-x.1")
        self.finalize_releases(**{"app-v0.2.0-x.1": 1, "companion-v2.2.0-x.1": 1})
        w = self.repo.work

        async def body(app, pilot):
            await self.finalize_to_gate(app, pilot, [("app", "0.2.0"), ("companion", "2.2.0")])
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(self.repo.origin, "log", "-2", "--format=%s", "channel/x").split("\n"),
                         ["Bump companion version to 2.2.0", "Bump app version to 0.2.0"])
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")
        self.assertEqual(self.gh.prs["channel/x"]["state"], "OPEN")

    def test_finalize_only_asks_for_the_apps_the_channel_carried(self):
        w = self.repo.work
        self.repo.channel_versions(companion="2.2.0-x.1")
        self.finalize_releases(**{"companion-v2.2.0-x.1": 1})

        async def body(app, pilot):
            # The active app is the app, which the channel never touched: only the companion is asked.
            await self.finalize_to_gate(app, pilot, [("companion", "2.2.0")])
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, True, expect="Merge PR #1")
            await answer(app, pilot, True, expect="Tag companion-v2.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await answer(app, pilot, False, expect="Delete local channel/x")
            await answer(app, pilot, False, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "tag", "-l", "*-v*"), "app-v0.1.0\ncompanion-v2.1.0\ncompanion-v2.2.0\ncompanion-v2.2.0-x.1")
        self.assertIn('version = "0.1.0"', git(w, "show", "origin/main:app/src-tauri/Cargo.toml"))
        self.assertEqual(git(w, "rev-parse", "companion-v2.2.0^{commit}"), git(w, "rev-parse", "origin/main"))
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "channel/x")  # kept on a no

    def test_finalize_esc_on_a_version_cancels_everything(self):
        self.repo.channel_versions(app="0.2.0-x.1")
        self.finalize_releases(**{"app-v0.2.0-x.1": 1})
        before = git(self.repo.work, "show-ref", "--heads", "--tags")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("f")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, False, AskScreen)
            await idle(app, pilot)
            self.assertIn("skipped: Finalize x: app live version", log_text(app))

        self.run_app(body)
        self.assertEqual(git(self.repo.work, "show-ref", "--heads", "--tags"), before)
        self.assertEqual(self.gh.prs, {})

    def test_finalize_continues_an_open_pull_request_of_the_channel(self):
        w = self.repo.work
        self.repo.channel_versions(app="0.2.0-x.1", companion="2.2.0-x.1")
        self.finalize_releases(**{"app-v0.2.0-x.1": 1, "companion-v2.2.0-x.1": 1})

        async def first(app, pilot):
            await self.finalize_to_gate(app, pilot, [("app", "0.2.0"), ("companion", "2.2.0")])
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)

        self.run_app(first)

        async def second(app, pilot):
            self.assertIn("pull request #1 (channel/x) is open", "\n".join(app.live_lines()))
            select(app, "x")
            await pilot.press("f")
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, True, expect="Merge PR #1 (channel/x)")
            # The versions are not asked again: whatever the squash commit carries untagged gets its tag.
            await answer(app, pilot, True, expect="Tag app-v0.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await answer(app, pilot, True, expect="Tag companion-v2.2.0 on ")
            await answer(app, pilot, False, expect="Watch the CI build")
            await answer(app, pilot, False, expect="Delete local channel/x")
            await answer(app, pilot, False, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(second)
        squash = git(w, "rev-parse", "origin/main")
        self.assertEqual(git(w, "rev-parse", "app-v0.2.0^{commit}"), squash)
        self.assertEqual(git(w, "rev-parse", "companion-v2.2.0^{commit}"), squash)
        self.assertEqual(len(self.gh.prs), 1)  # no second pull request

    def test_finalize_dry_run_prints_everything_and_changes_nothing(self):
        self.repo.channel_versions(app="0.2.0-x.1")
        self.finalize_releases(**{"app-v0.2.0-x.1": 1})
        before = git(self.repo.work, "show-ref")
        origin_before = git(self.repo.origin, "show-ref")

        async def body(app, pilot):
            await self.finalize_to_gate(app, pilot, [("app", "0.2.0")])
            await answer(app, pilot, True, expect="Merge channel/x")
            await idle(app, pilot)
            log = log_text(app).replace(chr(10), "")  # the log wraps long lines
            for line in ["[dry-run] $ git checkout channel/x",
                         "[dry-run] $ git commit -q -m 'Bump app version to 0.2.0'",
                         "[dry-run] $ git push origin channel/x",
                         "[dry-run] $ gh pr create --base main --head channel/x --title 'Finalize channel x: app 0.2.0'",
                         "[dry-run] $ gh pr merge channel/x --squash",
                         "[dry-run] $ git tag -a app-v0.2.0",
                         "[dry-run] $ git push origin app-v0.2.0"]:
                self.assertIn(line, log)

        self.run_app(body, dry_run=True)
        self.assertEqual(git(self.repo.work, "show-ref"), before)
        self.assertEqual(git(self.repo.origin, "show-ref"), origin_before)
        self.assertEqual(self.gh.prs, {})

    def test_finalize_a_channel_that_was_never_pushed_pushes_it_with_upstream(self):
        w = self.repo.work
        git(w, "branch", "channel/z")
        git(w, "checkout", "-q", "channel/z")
        self.repo.write("feature.txt", "z\n")
        self.repo.commit("z work")
        git(w, "checkout", "-q", "main")

        async def body(app, pilot):
            select(app, "z")
            await pilot.press("f")
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Switch to channel/z")
            await answer(app, pilot, True, expect="Finalize z: bump, push, pull request")
            await choose(app, pilot, "Leave it")
            await idle(app, pilot)
            self.assertIn("carries no app version", log_text(app))

        self.run_app(body)
        self.assertEqual([c[2:] for c in pushes(self.commands)], [["-u", "origin", "channel/z"]])
        self.assertEqual(self.gh.prs["channel/z"]["title"], "Finalize channel z")

    def test_dirty_tree_refuses_switch(self):
        self.repo.write("app/package.json", APP_PKG + " ")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("s")
            await idle(app, pilot)
            self.assertIn("Working tree has changes", log_text(app))

        self.run_app(body)
        self.assertEqual(git(self.repo.work, "rev-parse", "--abbrev-ref", "HEAD"), "main")

    # --- screen ---

    def test_live_panel_shows_both_apps_and_the_data(self):
        self.releases = dict(RELEASES, **{"data-4.10.2.12913470-1": core.RELEASE})
        self.repo.channels_branch(channels_text([], []))

        async def body(app, pilot):
            text = "\n".join(app.live_lines())
            self.assertIn("app", text)
            self.assertIn("companion", text)
            self.assertIn("0.1.0", text)
            self.assertIn("2.1.0", text)
            self.assertIn("data-4.10.2.12913470-1", text)
            self.assertIn("channels.json stable", text)
            self.assertEqual(app.sub_title, "working on: app")
            await pilot.press("a")
            self.assertEqual(app.sub_title, "working on: companion")
            await pilot.press("a")
            self.assertEqual(app.product, "app")

        self.run_app(body)

    def test_only_remote_steps_say_they_write_to_github(self):
        from releasectl.app import remote_write
        self.assertTrue(remote_write(["git", "push", "origin", "channel/x"]))
        self.assertTrue(remote_write(["gh", "release", "edit", "app-v1.0.0"]))
        self.assertTrue(remote_write(["gh", "release", "create", "data-1-1"]))
        self.assertTrue(remote_write(["gh", "pr", "merge", "release/app-v1.0.0", "--squash"]))
        self.assertTrue(remote_write(["gh", "workflow", "run", "channels.yml"]))
        self.assertFalse(remote_write(["git", "commit", "-q", "-m", "x"]))
        self.assertFalse(remote_write(["git", "tag", "-a", "app-v1.0.0", "-m", "x"]))
        self.assertFalse(remote_write(["pnpm", "data:pack"]))

    def test_outcome_lines(self):
        self.releases = None

        async def body(app, pilot):
            # Done: a fetch from the local origin.
            await pilot.press("g")
            await answer(app, pilot, True, expect="Fetch origin")
            await idle(app, pilot)
            # Cancelled: Bump live, Esc on the version.
            await pilot.press("l")
            await answer(app, pilot, False, AskScreen)
            await idle(app, pilot)
            # Failed: Notes without GitHub.
            await pilot.press("e")
            await idle(app, pilot)
            log = log_text(app)
            for line in ["▶ Fetch", "✓ Fetch: done", "▶ Bump live", "– Bump live: cancelled",
                         "▶ Notes", "✗ Notes: failed – GitHub not reachable"]:
                self.assertIn(line, log)

        self.run_app(body)

    def test_partly_done_names_the_skipped_step(self):
        async def body(app, pilot):
            await pilot.press("b")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Bump app to 0.2.0-x.1")
            await answer(app, pilot, False, expect="Push channel/x and app-v0.2.0-x.1")
            await idle(app, pilot)
            self.assertIn("✓ Bump channel: done, skipped: Push channel/x and app-v0.2.0-x.1?", log_text(app))

        self.run_app(body)

    def test_notes_without_github_stops(self):
        self.releases = None

        async def body(app, pilot):
            await pilot.press("e")
            await idle(app, pilot)
            self.assertIn("GitHub not reachable", log_text(app))

        self.run_app(body)


class NoPushToMain(Base):
    """The tool contains no way to push the default branch."""

    def test_the_test_origin_really_refuses_main(self):
        w = self.repo.work
        self.repo.write("x.txt", "x")
        self.repo.commit("direct")
        p = git(w, "push", "origin", "main", check=False)
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("main is protected", p.stderr)
        # ... while the ruleset's counterpart (merging) and a channel push work.
        self.assertEqual(git(w, "push", "-q", "origin", "main:channel/x", check=False).returncode, 0)

    def test_git_push_is_built_in_one_place_and_refuses_main(self):
        for ref in ["main", "master", "refs/heads/main", "HEAD:main", "+main", "HEAD"]:
            with self.assertRaises(ValueError, msg=ref):
                actions.git_push(ref)
        with self.assertRaises(ValueError):
            actions.git_push("channel/x", "main")
        with self.assertRaises(ValueError):
            actions.git_push("main", delete=True)
        self.assertEqual(actions.git_push("channel/x"), ["git", "push", "origin", "channel/x"])
        self.assertEqual(actions.git_push("channel/x", upstream=True), ["git", "push", "-u", "origin", "channel/x"])
        self.assertEqual(actions.git_push("channel/x", delete=True), ["git", "push", "origin", "--delete", "channel/x"])
        self.assertEqual(actions.git_push("app-v1.0.0"), ["git", "push", "origin", "app-v1.0.0"])

    def test_the_source_builds_a_push_only_in_git_push(self):
        package = Path(actions.__file__).parent
        sources = {p.name: p.read_text(encoding="utf-8") for p in package.glob("*.py")}
        self.assertEqual(sources["actions.py"].count('"git", "push"'), 1)
        for name, text in sources.items():
            if name == "actions.py":
                continue
            for line in text.splitlines():  # app.py only compares a command, it builds none
                if '"git", "push"' in line:
                    self.assertIn("cmd[:2] ==", line, name)

    def test_a_complete_live_bump_changes_main_only_by_the_merge(self):
        async def body(app, pilot):
            await pilot.press("a")
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Fetch origin")
            await answer(app, pilot, True, expect="Bump companion to 2.2.0")
            await choose(app, pilot, "Merge now")
            await answer(app, pilot, True, expect="Merge PR #1")
            await answer(app, pilot, True, expect="Tag companion-v2.2.0")
            await answer(app, pilot, False, expect="Watch the CI build")
            await idle(app, pilot)

        self.run_app(body)
        self.assertTrue(pushes(self.commands))
        self.assertEqual(git(self.repo.origin, "log", "--format=%s", "-1", "main"), "Bump companion version to 2.2.0")


class PublishTests(Base):
    """Publishing drafts and the data release, with gh / pnpm faked."""
    app_class = FakeCtl
    releases = {**RELEASES,
                "app-v0.2.0": core.DRAFT, "app-v0.2.0-x.1": core.DRAFT,
                "companion-v2.2.0": core.DRAFT,
                "data-4.10.2.12913470-1": core.RELEASE, "data-4.10.2.12913470-2": core.DRAFT}

    def pick_draft(self, app, tag):
        app.drafts_table.move_cursor(row=[d.tag for d in app.snap.drafts].index(tag))

    def publish(self, tag, expect_cmd):
        async def body(app, pilot):
            self.pick_draft(app, tag)
            await pilot.press("p")
            await answer(app, pilot, True, expect=f"Publish {tag}")
            await idle(app, pilot)
            self.assertEqual(app.calls, [expect_cmd])

        self.run_app(body)

    def test_publish_an_app_channel_draft_as_prerelease(self):
        self.publish("app-v0.2.0-x.1", ["gh", "release", "edit", "app-v0.2.0-x.1", "--draft=false", "--prerelease"])

    def test_publish_a_live_draft_is_not_forced_latest(self):
        self.publish("companion-v2.2.0", ["gh", "release", "edit", "companion-v2.2.0",
                                          "--draft=false", "--prerelease=false"])

    def test_publish_a_data_draft_never_becomes_latest(self):
        self.publish("data-4.10.2.12913470-2", ["gh", "release", "edit", "data-4.10.2.12913470-2",
                                                "--draft=false", "--prerelease=false", "--latest=false"])

    def test_drafts_panel_lists_every_kind(self):
        async def body(app, pilot):
            self.assertEqual([(d.tag, d.label) for d in app.snap.drafts], [
                ("app-v0.2.0", "app live"), ("app-v0.2.0-x.1", "app channel x"),
                ("companion-v2.2.0", "companion live"), ("data-4.10.2.12913470-2", "data")])
            self.assertEqual(app.drafts_table.row_count, 4)

        self.run_app(body)

    def test_publish_without_a_selection_target_stops(self):
        self.releases = dict(RELEASES)

        async def body(app, pilot):
            await pilot.press("p")
            await idle(app, pilot)
            self.assertIn("No drafts", log_text(app))

        self.run_app(body)

    # --- data release ---

    def prepare_data(self, stable="data-4.10.2.12913470-1"):
        root = self.repo.work
        (root / "local" / "snapshots").mkdir(parents=True)
        head = ('{"schemaVersion":7,"game":{"channel":"LIVE","build":12913470,"label":"4.10.2.12913470",'
                '"manifest":{"Data":{"Branch":"b"}}},"rawRecords":[]}')
        with gzip.open(root / "local" / "snapshots" / "catalog-live.json.gz", "wb") as f:
            f.write(head.encode())
        (root / "local" / "thumbs").mkdir(parents=True)
        (root / "local" / "thumbs" / "thumbs.json").write_text("{}")
        if stable:
            self.repo.channels_branch(json.dumps({"data": {"stable": stable}}) + "\n")
        self.releases = dict(RELEASES, **{"data-4.10.2.12913470-1": core.RELEASE})

    async def walk_data_dialogs(self, app, pilot, expect_n, create):
        await pilot.press("t")
        snapshot = await modal(app, pilot, AskScreen)
        self.assertTrue(snapshot.value.endswith("catalog-live.json.gz"))
        await click(app, pilot, "#ok")
        thumbs = await modal(app, pilot, AskScreen)
        self.assertTrue(thumbs.value.replace("\\", "/").endswith("local/thumbs"))
        await click(app, pilot, "#ok")
        n = await modal(app, pilot, AskScreen)
        self.assertEqual(n.value, expect_n)
        await click(app, pilot, "#ok")
        await answer(app, pilot, True, expect=f"Build data-4.10.2.12913470-{expect_n}")
        if create is None:
            return
        await answer(app, pilot, create, expect="Create the draft release")
        await idle(app, pilot)

    def test_data_release_on_top_of_data_stable(self):
        self.prepare_data()
        root = self.repo.work

        async def body(app, pilot):
            await self.walk_data_dialogs(app, pilot, "2", create=True)
            out = root / "local" / "data-release" / "data-4.10.2.12913470-2"
            download, pack, create = app.calls
            self.assertEqual(download[:4], ["gh", "release", "download", "data-4.10.2.12913470-1"])
            self.assertEqual([download[i + 1] for i, a in enumerate(download) if a == "--pattern"],
                             ["manifest.json", "thumbs-update.zip"])
            self.assertEqual(Path(download[download.index("--dir") + 1]), out / "previous")
            self.assertEqual(pack[:2], ["pnpm", "data:pack"])
            self.assertEqual(Path(pack[pack.index("--snapshot") + 1]).name, "catalog-live.json.gz")
            self.assertEqual(pack[pack.index("--n") + 1], "2")
            self.assertEqual(Path(pack[pack.index("--previous") + 1]), out / "previous")
            self.assertEqual(Path(pack[pack.index("--out") + 1]), out / "out")
            self.assertEqual(create[:4], ["gh", "release", "create", "data-4.10.2.12913470-2"])
            self.assertEqual([Path(a).name for a in create[4:8]], [
                "manifest.json", "quartermaster-data-4.10.2.12913470-2.zip",
                "catalog.json.gz", "thumbs-update.zip"])
            self.assertIn("--draft", create)
            self.assertEqual(create[create.index("--title") + 1], "data-4.10.2.12913470-2")
            self.assertIn("Previous: data-4.10.2.12913470-1", create[create.index("--notes") + 1])
            log = log_text(app)
            self.assertIn("delta      2.0 KiB (5 new pictures", log)
            self.assertIn("Draft created", log)

        self.run_app(body)

    def test_a_first_data_release_has_no_predecessor(self):
        self.prepare_data(stable=None)
        self.releases = dict(RELEASES)

        async def body(app, pilot):
            await self.walk_data_dialogs(app, pilot, "1", create=True)
            pack, create = app.calls
            self.assertNotIn("--previous", pack)
            self.assertEqual(create[3], "data-4.10.2.12913470-1")
            self.assertIn("First release", create[create.index("--notes") + 1])

        self.run_app(body)

    def test_declining_the_draft_creates_nothing(self):
        self.prepare_data()

        async def body(app, pilot):
            await self.walk_data_dialogs(app, pilot, "2", create=False)
            self.assertEqual([c[:2] for c in app.calls], [["gh", "release"], ["pnpm", "data:pack"]])
            self.assertNotIn("create", [c[2] for c in app.calls])
            self.assertIn("Not created", log_text(app))

        self.run_app(body)

    def test_a_failed_build_creates_nothing(self):
        self.prepare_data()

        async def body(app, pilot):
            app.fail_on = "pnpm"
            await self.walk_data_dialogs(app, pilot, "2", create=None)
            await idle(app, pilot)
            self.assertIn("The build failed", log_text(app))
            self.assertEqual([c[0] for c in app.calls], ["gh", "pnpm"])

        self.run_app(body)

    def test_data_release_dry_run_runs_nothing(self):
        self.prepare_data()

        async def body(app, pilot):
            await self.walk_data_dialogs(app, pilot, "2", create=None)
            await idle(app, pilot)
            self.assertEqual(app.calls, [])
            log = log_text(app)
            self.assertIn("[dry-run] $ gh release download data-4.10.2.12913470-1", log)
            self.assertIn("[dry-run] $ pnpm data:pack", log)
            self.assertIn("[dry-run] then: show the built assets", log)

        self.run_app(body, dry_run=True)
        self.assertFalse((self.repo.work / "local" / "data-release").exists())

    def test_data_stable_without_its_release_stops(self):
        self.prepare_data(stable="data-4.10.2.12913470-1")
        self.releases = dict(RELEASES)

        async def body(app, pilot):
            await pilot.press("t")
            for _ in range(3):
                await answer(app, pilot, True, AskScreen)
            await idle(app, pilot)
            self.assertIn("GitHub has no such release", log_text(app))
            self.assertEqual(app.calls, [])

        self.run_app(body)

    def test_data_release_needs_github(self):
        self.releases = None

        async def body(app, pilot):
            await pilot.press("t")
            await idle(app, pilot)
            self.assertIn("GitHub not reachable", log_text(app))

        self.run_app(body)

    def test_n_must_be_a_new_tag(self):
        self.prepare_data()

        async def body(app, pilot):
            await pilot.press("t")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, AskScreen)
            screen = await modal(app, pilot, AskScreen)
            screen.query_one("Input").value = "1"
            await click(app, pilot, "#ok")
            await pilot.pause(0.1)
            self.assertIn("tag exists", str(screen.query_one("#error").content))
            screen.query_one("Input").value = "0"
            await click(app, pilot, "#ok")
            await pilot.pause(0.1)
            self.assertIn("whole number", str(screen.query_one("#error").content))
            await click(app, pilot, "#cancel")
            await idle(app, pilot)

        self.run_app(body)


class Helpers(unittest.TestCase):
    def test_snapshot_label_from_gz_and_plain_and_late_key(self):
        tmp = Path(tempfile.mkdtemp(prefix="releasectl-test-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        head = '{"game":{"build":1,"label":"4.1.2.3","manifest":{}},"x":1}'
        (tmp / "a.json").write_text(head)
        with gzip.open(tmp / "a.json.gz", "wb") as f:
            f.write(head.encode())
        late = '{"game":{"manifest":{"a":1},"label":"4.9"}}'  # beyond the head pattern: the whole file is parsed
        (tmp / "b.json").write_text(late)
        (tmp / "c.json").write_text('{"nothing": 1}')
        self.assertEqual(actions.snapshot_label(tmp / "a.json"), "4.1.2.3")
        self.assertEqual(actions.snapshot_label(tmp / "a.json.gz"), "4.1.2.3")
        self.assertEqual(actions.snapshot_label(tmp / "b.json"), "4.9")
        self.assertIsNone(actions.snapshot_label(tmp / "c.json"))

    def test_newest_snapshot_and_thumbs_default(self):
        import os
        tmp = Path(tempfile.mkdtemp(prefix="releasectl-test-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        self.assertIsNone(actions.newest_snapshot(tmp))
        folder = tmp / "local" / "snapshots"
        folder.mkdir(parents=True)
        old, new = folder / "old.json.gz", folder / "new.json"
        old.write_bytes(b"x")
        new.write_bytes(b"x")
        (folder / "notes.txt").write_text("x")
        os.utime(old, (1, 1))
        self.assertEqual(actions.newest_snapshot(tmp), new)
        self.assertEqual(actions.default_thumbs(tmp, env={}), tmp / "local" / "thumbs")
        self.assertEqual(actions.default_thumbs(tmp, env={"THUMBS_DIR": "D:/t"}), Path("D:/t"))

    def test_editor_command(self):
        self.assertEqual(actions.editor_command("n.md", env={}, platform="win32"), (["notepad", "n.md"], False))
        self.assertEqual(actions.editor_command("n.md", env={}, platform="linux"), (["nano", "n.md"], True))
        self.assertEqual(actions.editor_command("n.md", env={"EDITOR": "vim"}, platform="linux"),
                         (["vim", "n.md"], True))
        self.assertEqual(actions.editor_command("n.md", env={"VISUAL": "code --wait", "EDITOR": "vim"},
                                                platform="win32"), (["code", "--wait", "n.md"], True))


if __name__ == "__main__":
    unittest.main()
