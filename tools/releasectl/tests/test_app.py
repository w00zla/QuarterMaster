"""Headless UI tests against a throwaway git repo (temp dir + local bare
origin; no network). GitHub is replaced: `repo.releases` returns a canned
state, and every `gh` / `pnpm` command an action runs is recorded and faked
by FakeCtl instead of being run."""

import asyncio
import gzip
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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


def git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True,
                          text=True).stdout.strip()


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

    def write(self, path, text):
        p = self.work / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)

    def bot_commit(self, path, text, branch="main"):
        """A commit straight onto origin, like CI writing channels.json / README."""
        bot = self.tmp / "bot"
        if not bot.exists():
            git(self.tmp, "clone", "-q", str(self.origin), str(bot))
            for k, val in [("user.name", "bot"), ("user.email", "b@b"),
                           ("commit.gpgsign", "false")]:
                git(bot, "config", k, val)
        git(bot, "checkout", "-q", branch)
        git(bot, "pull", "-q", "origin", branch)
        (bot / path).write_text(text)
        git(bot, "add", "-A")
        git(bot, "commit", "-q", "-m", f"bot: {path}")
        git(bot, "push", "-q", "origin", branch)

    def commit(self, msg):
        git(self.work, "add", "-A")
        git(self.work, "commit", "-q", "-m", msg)

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class FakeCtl(ReleaseCtl):
    """The app with `gh` and `pnpm` steps recorded instead of run (git runs for real)."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.calls: list[list[str]] = []
        self.fail_on: str | None = None  # a command word that fails, e.g. "pnpm"

    async def _execute(self, cmd):
        if isinstance(cmd, list) and cmd[0] in ("gh", "pnpm") and not self.dry_run:
            self.calls.append(cmd)
            self.log_line("$ " + actions.show(cmd), "cyan")
            if self.fail_on == cmd[0]:
                return False, "failed"
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
    app_class = ReleaseCtl

    def setUp(self):
        self.repo = Repo()
        patch = mock.patch.object(repo, "releases", lambda root: (
            (dict(self.releases), None) if self.releases is not None else (None, "no GitHub in tests")))
        patch.start()
        self.addCleanup(patch.stop)
        self.addCleanup(self.repo.cleanup)

    def run_app(self, body, dry_run=False, app_class=None):
        async def go():
            app = (app_class or self.app_class)(self.repo.work, dry_run=dry_run)
            async with app.run_test(size=(160, 50)) as pilot:
                for _ in range(200):
                    await pilot.pause(0.02)
                    if app.snap.views:
                        break
                await body(app, pilot)
        asyncio.run(go())


class AppTests(Base):
    # --- bumps ---

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

    def test_bump_live_real(self):
        w = self.repo.work
        git(w, "checkout", "-q", "channel/x")

        async def body(app, pilot):
            await pilot.press("l")
            screen = await modal(app, pilot, AskScreen)
            self.assertEqual(screen.value, "0.2.0")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Switch to main")
            await answer(app, pilot, True, expect="Bump app to 0.2.0")
            await answer(app, pilot, False, expect="Push main")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "channel/x")
        self.assertEqual(git(w, "log", "-1", "--format=%s", "main"), "Bump app version to 0.2.0")
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0"), "tag")
        self.assertIn('version = "0.2.0"', git(w, "show", "main:app/src-tauri/Cargo.toml"))
        self.assertEqual(git(self.repo.origin, "tag", "-l", "app-v0.2.0"), "")

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

    def test_a_dirty_tracked_file_blocks_but_an_untracked_one_does_not(self):
        w = self.repo.work
        self.repo.write("scratch.txt", "x")  # untracked

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Bump app to 0.2.0")
            await answer(app, pilot, False, expect="Push main")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0"), "tag")
        self.assertEqual(git(w, "show", "--stat", "--format=", "main").count("scratch"), 0)

    def test_bump_live_pulls_a_diverged_main(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "v0.1.0\n")
        self.repo.write("feature.txt", "x\n")
        self.repo.commit("local work")
        git(w, "fetch", "-q", "origin")

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Bump app to 0.2.0")
            await answer(app, pilot, False, expect="Push main")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual((w / "README.md").read_text(), "v0.1.0\n")
        self.assertEqual(git(w, "log", "-1", "--format=%s"), "Bump app version to 0.2.0")
        self.assertTrue(git(w, "log", "--format=%s").count("Merge branch"))
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0"), "tag")

    def test_bump_live_pull_conflict_is_undone(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "bot\n")
        self.repo.write("README.md", "local\n")
        self.repo.commit("local readme")
        head = git(w, "rev-parse", "HEAD")

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await idle(app, pilot)
            log = log_text(app)
            self.assertIn("Conflicts, pull undone", log)
            self.assertIn("README.md", log)

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "HEAD"), head)
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(w, "tag", "-l", "app-v0.2.0"), "")

    def test_bump_refuses_files_that_disagree(self):
        self.repo.write("app/package.json", APP_PKG.replace("0.1.0", "0.0.9"))
        self.repo.commit("drift")

        async def body(app, pilot):
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await idle(app, pilot)
            self.assertIn("app/package.json was not updated", log_text(app))

        self.run_app(body)
        self.assertEqual(git(self.repo.work, "tag", "-l", "app-v0.2.0"), "")

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

    def test_new_channel_offers_a_pull_of_a_diverged_main(self):
        w = self.repo.work
        self.repo.bot_commit("README.md", "bot\n")
        self.repo.write("feature.txt", "x\n")
        self.repo.commit("local work")
        git(w, "checkout", "-q", "channel/x")

        async def body(app, pilot):
            await pilot.press("n")
            screen = await modal(app, pilot, AskScreen)
            screen.query_one("Input").value = "y"
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Update main from origin")
            await answer(app, pilot, True, expect="main has diverged")
            await answer(app, pilot, True, expect="Switch to main")
            await answer(app, pilot, True, expect="Create channel/y")
            await answer(app, pilot, False, expect="Push channel/y")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "channel/x")
        self.assertEqual(git(w, "show", "channel/y:README.md"), "bot")
        self.assertEqual(git(w, "show", "channel/y:feature.txt"), "x")

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

    def test_sync_conflict_is_aborted(self):
        w = self.repo.work
        git(w, "checkout", "-q", "channel/x")
        self.repo.write("app/package.json", APP_PKG.replace("true", "false"))
        self.repo.commit("channel change")
        git(w, "checkout", "-q", "main")
        self.repo.write("app/package.json", APP_PKG.replace('"private": true', '"private": 1'))
        self.repo.commit("main change")

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("s")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Switch to channel/x")
            await answer(app, pilot, True, expect="Merge main into channel/x")
            await idle(app, pilot)
            self.assertIn("Conflicts, merge aborted", log_text(app))

        self.run_app(body)
        self.assertEqual(git(w, "rev-parse", "--abbrev-ref", "HEAD"), "main")
        self.assertFalse((w / ".git" / "MERGE_HEAD").exists())
        self.assertEqual(git(w, "status", "--porcelain"), "")
        self.assertEqual(git(w, "log", "-1", "--format=%s", "channel/x"), "channel change")

    def channels_file(self, app_ids, companion_ids):
        def section(key, stable, prefix, ids, ver):
            entries = "".join(
                f'      {{\n        "id": "{i}",\n        "tag": "{prefix}{ver}-{i}.1"\n      }}{"," if k < len(ids) - 1 else ""}\n'
                for k, i in enumerate(ids))
            return f'  "{key}": {{\n    "stable": "{stable}",\n    "channels": [\n{entries}    ]\n  }}'
        text = ("{\n" + section("app", "app-v0.1.0", "app-v", app_ids, "0.2.0") + ",\n" +
                section("companion", "companion-v2.1.0", "companion-v", companion_ids, "2.2.0") +
                ',\n  "data": {\n    "stable": "data-4.10.2.12913470-1"\n  }\n}\n')
        self.repo.write("channels.json", text)
        self.repo.commit("list channels")
        git(self.repo.work, "push", "-q", "origin", "main")
        return text

    def test_remove_channel_of_one_app_keeps_the_other_and_the_branch(self):
        w = self.repo.work
        self.channels_file(["x", "y"], ["x"])

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Commit on main")
            await answer(app, pilot, True, expect="Push main")
            await idle(app, pilot)
            self.assertIn("still listed for the companion", log_text(app))

        self.run_app(body)
        self.assertEqual(git(w, "log", "-1", "--format=%s", "origin/main"),
                         "Remove the x channel of the app")
        doc = json.loads((w / "channels.json").read_text())
        self.assertEqual([e["id"] for e in doc["app"]["channels"]], ["y"])
        self.assertEqual([e["id"] for e in doc["companion"]["channels"]], ["x"])
        self.assertEqual(doc["data"], {"stable": "data-4.10.2.12913470-1"})
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "channel/x")

    def test_remove_channel_and_branch(self):
        w = self.repo.work
        self.channels_file(["x", "y"], ["y"])

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Commit on main")
            await answer(app, pilot, True, expect="Push main")
            await answer(app, pilot, True, expect="Delete local channel/x")
            await answer(app, pilot, False, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(body)
        doc = json.loads((w / "channels.json").read_text())
        self.assertEqual([e["id"] for e in doc["app"]["channels"]], ["y"])
        self.assertEqual(git(w, "branch", "--list", "channel/x"), "")
        self.assertIn("channel/x", git(self.repo.origin, "branch", "--list", "channel/x"))

    def test_remove_keeps_the_files_format(self):
        w = self.repo.work
        text = self.channels_file(["x", "y"], ["y"])

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Commit on main")
            await answer(app, pilot, False, expect="Push main")
            await answer(app, pilot, False, expect="Delete local channel/x")
            await answer(app, pilot, False, expect="Delete channel/x on origin")
            await idle(app, pilot)

        self.run_app(body)
        # Only the removed entry differs: the rest of the document stays byte for byte.
        expected = core.dump_channels(core.remove_channel(core.load_channels(text), "app", "x"))
        self.assertEqual((w / "channels.json").read_text(), expected)
        self.assertEqual(git(w, "log", "-1", "--format=%s", "main"), "Remove the x channel of the app")

    def test_remove_an_unlisted_channel_stops(self):
        self.channels_file(["y"], ["y"])

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("x")
            await idle(app, pilot)
            self.assertIn("x is not in channels.json for the app", log_text(app))

        self.run_app(body)

    def test_finalize_offers_a_live_bump_for_each_app_the_channel_covers(self):
        w = self.repo.work
        git(w, "checkout", "-q", "channel/x")
        self.repo.write("feature.txt", "from the channel\n")
        self.repo.commit("channel work")
        git(w, "tag", "-a", "app-v0.2.0-x.1", "-m", "t")
        git(w, "tag", "-a", "companion-v2.2.0-x.1", "-m", "t")
        git(w, "checkout", "-q", "main")
        self.releases = dict(RELEASES, **{"app-v0.2.0-x.1": core.PRERELEASE,
                                          "companion-v2.2.0-x.1": core.PRERELEASE})

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("f")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Merge channel/x into main")
            screen = await modal(app, pilot, AskScreen)
            self.assertIn("Bump app live", screen.title_text)
            self.assertEqual(screen.value, "0.2.0")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Bump app to 0.2.0")
            await answer(app, pilot, False, expect="Push main and app-v0.2.0")
            screen = await modal(app, pilot, AskScreen)
            self.assertIn("Bump companion live", screen.title_text)
            self.assertEqual(screen.value, "2.2.0")
            await click(app, pilot, "#ok")
            await answer(app, pilot, True, expect="Bump companion to 2.2.0")
            await answer(app, pilot, False, expect="Push main and companion-v2.2.0")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "cat-file", "-t", "app-v0.2.0"), "tag")
        self.assertEqual(git(w, "cat-file", "-t", "companion-v2.2.0"), "tag")
        self.assertEqual((w / "feature.txt").read_text(), "from the channel\n")
        self.assertIn('version = "0.2.0"', (w / "app/src-tauri/Cargo.toml").read_text())
        self.assertIn('version = "2.2.0"', (w / "companion/src-tauri/Cargo.toml").read_text())
        self.assertEqual(git(w, "status", "--porcelain"), "")

    def test_finalize_skips_the_app_the_channel_never_covered(self):
        w = self.repo.work
        git(w, "checkout", "-q", "channel/x")
        self.repo.write("feature.txt", "x\n")
        self.repo.commit("channel work")
        git(w, "tag", "-a", "companion-v2.2.0-x.1", "-m", "t")
        git(w, "checkout", "-q", "main")
        self.releases = dict(RELEASES, **{"companion-v2.2.0-x.1": core.PRERELEASE})

        async def body(app, pilot):
            select(app, "x")
            await pilot.press("f")
            await answer(app, pilot, False, expect="Update main")
            await answer(app, pilot, True, expect="Merge channel/x into main")
            # The app is active but the channel has no app version: it is still asked first (the user chose it) ...
            screen = await modal(app, pilot, AskScreen)
            self.assertIn("Bump app live", screen.title_text)
            await click(app, pilot, "#cancel")
            # ... the companion has one: asked second.
            screen = await modal(app, pilot, AskScreen)
            self.assertIn("Bump companion live", screen.title_text)
            await click(app, pilot, "#cancel")
            await answer(app, pilot, False, expect="Push main")
            await idle(app, pilot)

        self.run_app(body)
        self.assertEqual(git(w, "tag", "-l", "*-v*"), "app-v0.1.0\ncompanion-v2.1.0\ncompanion-v2.2.0-x.1")

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
        self.channels_file([], [])

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
        self.assertTrue(remote_write(["git", "push", "origin", "main"]))
        self.assertTrue(remote_write(["gh", "release", "edit", "app-v1.0.0"]))
        self.assertTrue(remote_write(["gh", "release", "create", "data-1-1"]))
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
            await pilot.press("l")
            await answer(app, pilot, True, AskScreen)
            await answer(app, pilot, True, expect="Switch to main")
            await answer(app, pilot, True, expect="Bump app to 0.2.0")
            await answer(app, pilot, False, expect="Push main")
            await idle(app, pilot)
            self.assertIn("✓ Bump live: done, skipped: Push main and app-v0.2.0?", log_text(app))

        git(self.repo.work, "checkout", "-q", "channel/x")
        self.run_app(body)

    def test_notes_without_github_stops(self):
        self.releases = None

        async def body(app, pilot):
            await pilot.press("e")
            await idle(app, pilot)
            self.assertIn("GitHub not reachable", log_text(app))

        self.run_app(body)


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
            self.repo.bot_commit("channels.json", json.dumps({"data": {"stable": stable}}) + "\n")
            git(root, "fetch", "-q", "origin")
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
