"""Unit tests for the pure release logic (no git, no network)."""

import json
import unittest
from datetime import datetime, timezone

from releasectl import core
from releasectl.core import APP, COMPANION, Version as V


def v(text):
    parsed = V.parse(text)
    assert parsed is not None, text
    return parsed


class VersionParse(unittest.TestCase):
    def test_live_and_channel(self):
        self.assertEqual(v("0.17.0"), V(0, 17, 0))
        self.assertEqual(v("v0.18.0-joysticks.2"), V(0, 18, 0, "joysticks", 2))
        self.assertEqual(str(v("v1.2.3-a-b.10")), "1.2.3-a-b.10")

    def test_rejects(self):
        for bad in ["", "1.2", "1.2.3.4", "01.2.3", "1.2.3-", "1.2.3-x",
                    "1.2.3-x.01", "1.2.3-X.1", "1.2.3-1x.1", "1.2.3-stable.1",
                    "1.2.3-x.y.1", "1.2.3-" + "a" * 33 + ".1", "prerelease-version",
                    " 1.2.3", "1.2.3 "]:
            self.assertIsNone(V.parse(bad), bad)

    def test_id_length_limit(self):
        self.assertIsNotNone(V.parse("1.2.3-" + "a" * 32 + ".1"))

    def test_n_zero_is_valid_shape(self):
        self.assertEqual(v("1.0.0-x.0").n, 0)


class VersionOrder(unittest.TestCase):
    def test_prerelease_before_release(self):
        self.assertLess(v("0.17.0-x.3"), v("0.17.0"))
        self.assertLess(v("0.17.0"), v("0.18.0-x.1"))

    def test_numeric_n(self):
        self.assertLess(v("1.0.0-x.2"), v("1.0.0-x.10"))

    def test_core_numeric(self):
        self.assertLess(v("0.9.0"), v("0.10.0"))
        self.assertLess(v("0.10.9"), v("0.10.10"))

    def test_channels_ascii(self):
        self.assertLess(v("1.0.0-a.9"), v("1.0.0-b.1"))

    def test_sorting(self):
        tags = ["0.2.0", "0.17.0", "0.17.0-x.1", "0.10.0", "0.17.0-x.12", "0.17.0-x.2"]
        self.assertEqual([str(x) for x in sorted(map(v, tags))],
                         ["0.2.0", "0.10.0", "0.17.0-x.1", "0.17.0-x.2",
                          "0.17.0-x.12", "0.17.0"])


class ChannelId(unittest.TestCase):
    def test_valid(self):
        for ok in ["x", "joysticks", "a1", "a-b", "a" * 32]:
            self.assertIsNone(core.validate_channel_id(ok), ok)

    def test_invalid(self):
        for bad in ["", "1a", "-a", "A", "a_b", "a.b", "a" * 33, "stable", "a b"]:
            self.assertIsNotNone(core.validate_channel_id(bad), bad)


class NextVersions(unittest.TestCase):
    def test_live_proposal_follows_the_higher_of_release_and_tag(self):
        self.assertEqual(core.live_proposal(v("0.16.1"), v("0.16.3")), v("0.17.0"))
        self.assertEqual(core.live_proposal(v("0.17.0"), None), v("0.18.0"))
        self.assertEqual(core.live_proposal(None, v("0.3.2")), v("0.4.0"))
        self.assertEqual(core.live_proposal(None, None), v("0.1.0"))

    def test_first_channel_version_is_next_minor_of_live(self):
        self.assertEqual(core.next_channel_version("x", [], v("0.16.1")), v("0.17.0-x.1"))

    def test_next_n(self):
        self.assertEqual(core.next_channel_version("x", [v("0.17.0-x.1"), v("0.17.0-x.2")], v("0.16.1")),
                         v("0.17.0-x.3"))

    def test_other_channels_ignored(self):
        self.assertEqual(core.next_channel_version("x", [v("0.19.0-y.4")], v("0.16.1")),
                         v("0.17.0-x.1"))

    def test_base_released_moves_to_next_minor(self):
        self.assertEqual(core.next_channel_version("x", [v("0.17.0-x.3")], v("0.17.0")),
                         v("0.18.0-x.1"))
        self.assertEqual(core.next_channel_version("x", [v("0.17.0-x.3")], v("0.17.2")),
                         v("0.18.0-x.1"))

    def test_no_live_at_all(self):
        self.assertEqual(core.next_channel_version("x", [], None), v("0.1.0-x.1"))
        self.assertEqual(core.next_channel_version("x", [v("0.3.0-x.1")], None), v("0.3.0-x.2"))

    def test_next_live(self):
        self.assertEqual(core.next_live(v("0.17.0"), v("0.18.0-x.2")), v("0.18.0"))
        self.assertEqual(core.next_live(v("0.18.0"), v("0.18.0-x.2")), v("0.19.0"))
        self.assertEqual(core.next_live(v("0.17.0"), None), v("0.18.0"))


class Products(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(APP.tag(v("0.2.0")), "app-v0.2.0")
        self.assertEqual(COMPANION.tag(v("2.2.0-beta.1")), "companion-v2.2.0-beta.1")
        self.assertEqual(APP.parse("app-v0.2.0-beta.3"), v("0.2.0-beta.3"))

    def test_a_product_never_parses_a_foreign_tag(self):
        for tag in ["companion-v2.1.0", "v0.2.0", "data-4.10.2.12913470-1", "app-v", "app-0.2.0",
                    "app-vv0.2.0", "xapp-v0.2.0", "app-v0.2"]:
            self.assertIsNone(APP.parse(tag), tag)
        self.assertIsNone(COMPANION.parse("app-v0.2.0"))

    def test_product_of_tag(self):
        self.assertIs(core.product_of_tag("app-v1.0.0"), APP)
        self.assertIs(core.product_of_tag("companion-v1.0.0-x.1"), COMPANION)
        self.assertIsNone(core.product_of_tag("data-4.10.2.12913470-1"))
        self.assertIsNone(core.product_of_tag("v1.0.0"))

    def test_messages(self):
        self.assertEqual(core.commit_message(APP, v("0.17.0")), "Bump app version to 0.17.0")
        self.assertEqual(core.commit_message(COMPANION, v("2.2.0")), "Bump companion version to 2.2.0")
        self.assertEqual(core.tag_message(COMPANION, v("2.2.0-x.1")), "Quartermaster companion 2.2.0-x.1")

    def test_version_files(self):
        self.assertEqual(core.version_files(APP), [
            "app/src-tauri/Cargo.toml", "app/src-tauri/Cargo.lock", "package.json", "app/package.json"])
        self.assertEqual(core.version_files(COMPANION), [
            "companion/src-tauri/Cargo.toml", "companion/src-tauri/Cargo.lock", "companion/package.json"])


class Bump(unittest.TestCase):
    APP_TOML = ('[package]\nname = "quartermaster"\nversion = "0.16.3"\n\n'
                '[dependencies]\nfoo = { version = "1.0" }\n[x]\nversion = "0.16.3"\n')
    APP_LOCK = ('[[package]]\nname = "aaa"\nversion = "0.16.3"\n\n'
                '[[package]]\nname = "quartermaster"\nversion = "0.16.3"\n\n'
                '[[package]]\nname = "quartermaster-companion"\nversion = "0.16.3"\n')
    ROOT_PKG = ('{\n  "name": "sc-quartermaster",\n  "version": "0.16.3",\n'
                '  "dependencies": {\n    "x": {\n      "version": "0.16.3",\n'
                '      "y": 1\n    }\n  }\n}\n')
    APP_PKG = '{\n  "name": "sc-quartermaster-app",\n  "private": true,\n  "version": "0.16.3",\n  "type": "module"\n}\n'

    def app_texts(self):
        return {"app/src-tauri/Cargo.toml": self.APP_TOML, "app/src-tauri/Cargo.lock": self.APP_LOCK,
                "package.json": self.ROOT_PKG, "app/package.json": self.APP_PKG}

    def test_bump_sets_only_our_lines(self):
        out = core.bump_texts(APP, self.app_texts(), "0.17.0-x.1")
        self.assertEqual(out["app/src-tauri/Cargo.toml"],
                         self.APP_TOML.replace('version = "0.16.3"\n\n',
                                               'version = "0.17.0-x.1"\n\n', 1))
        lock = out["app/src-tauri/Cargo.lock"]
        self.assertIn('name = "aaa"\nversion = "0.16.3"', lock)
        self.assertIn('name = "quartermaster"\nversion = "0.17.0-x.1"', lock)
        # The other product's package in the same lock (a prefix of its name is no match).
        self.assertIn('name = "quartermaster-companion"\nversion = "0.16.3"', lock)
        self.assertIn('  "version": "0.17.0-x.1",', out["package.json"])
        self.assertIn('      "version": "0.16.3",', out["package.json"])
        self.assertEqual(out["package.json"].count("0.16.3"), 1)
        self.assertIn('  "version": "0.17.0-x.1",', out["app/package.json"])
        self.assertEqual(out["app/package.json"].count("0.16.3"), 0)

    def test_companion_bump(self):
        toml = '[package]\nname = "quartermaster-companion"\nversion = "2.1.0"\nedition = "2021"\n'
        lock = '[[package]]\nname = "quartermaster"\nversion = "2.1.0"\n\n[[package]]\nname = "quartermaster-companion"\nversion = "2.1.0"\n'
        pkg = '{\n  "name": "sc-quartermaster-companion",\n  "private": true,\n  "version": "2.1.0",\n  "type": "module"\n}\n'
        out = core.bump_texts(COMPANION, {"companion/src-tauri/Cargo.toml": toml,
                                          "companion/src-tauri/Cargo.lock": lock,
                                          "companion/package.json": pkg}, "2.2.0")
        self.assertEqual(set(out), set(core.version_files(COMPANION)))
        self.assertIn('name = "quartermaster-companion"\nversion = "2.2.0"', out["companion/src-tauri/Cargo.lock"])
        self.assertIn('name = "quartermaster"\nversion = "2.1.0"', out["companion/src-tauri/Cargo.lock"])
        self.assertIn('"version": "2.2.0"', out["companion/package.json"])

    def test_crlf_lock(self):
        texts = self.app_texts()
        texts["app/src-tauri/Cargo.lock"] = self.APP_LOCK.replace("\n", "\r\n")
        # '$' does not match before '\r': the lock stays unchanged and the bump refuses.
        with self.assertRaises(ValueError):
            core.bump_texts(APP, texts, "0.17.0")

    def test_files_that_disagree_refuse(self):
        texts = self.app_texts()
        texts["app/package.json"] = self.APP_PKG.replace("0.16.3", "0.16.0")
        with self.assertRaises(ValueError) as e:
            core.bump_texts(APP, texts, "0.17.0")
        self.assertIn("app/package.json", str(e.exception))

    def test_missing_line_raises(self):
        texts = self.app_texts()
        texts["package.json"] = texts["package.json"].replace('"version": "0.16.3"', '"v": 1')
        with self.assertRaises(ValueError):
            core.bump_texts(APP, texts, "0.17.0")

    def test_same_version_raises(self):
        with self.assertRaises(ValueError):
            core.bump_texts(APP, self.app_texts(), "0.16.3")

    def test_no_version_in_toml(self):
        texts = self.app_texts()
        texts["app/src-tauri/Cargo.toml"] = "[package]\n"
        with self.assertRaises(ValueError):
            core.bump_texts(APP, texts, "0.17.0")

    def test_current_version(self):
        self.assertEqual(core.cargo_toml_version(self.APP_TOML), "0.16.3")

    def test_branch_guard(self):
        self.assertIsNone(core.branch_guard(v("0.17.0"), "main"))
        self.assertIsNotNone(core.branch_guard(v("0.17.0"), "channel/x"))
        self.assertIsNone(core.branch_guard(v("0.17.0-x.1"), "channel/x"))
        self.assertIsNotNone(core.branch_guard(v("0.17.0-x.1"), "channel/y"))
        self.assertIsNotNone(core.branch_guard(v("0.17.0-x.1"), "main"))


CHANNELS = ('{\n  "app": {\n    "stable": "app-v0.17.0",\n    "channels": [\n      {\n'
            '        "id": "joysticks",\n        "tag": "app-v0.18.0-joysticks.2"\n      },\n      {\n'
            '        "id": "other",\n        "tag": "app-v0.18.0-other.1"\n      }\n    ]\n  },\n'
            '  "companion": {\n    "stable": "companion-v2.1.0",\n    "channels": [\n      {\n'
            '        "id": "joysticks",\n        "tag": "companion-v2.2.0-joysticks.1"\n      }\n    ]\n  },\n'
            '  "data": {\n    "stable": "data-4.10.2.12913470-2"\n  }\n}\n')


class ChannelsJson(unittest.TestCase):
    def test_missing_file(self):
        self.assertEqual(core.load_channels(None), {})

    def test_roundtrip_is_stable(self):
        self.assertEqual(core.dump_channels(core.load_channels(CHANNELS)), CHANNELS)

    def test_key_order_and_unknown_keys(self):
        doc = {"data": {"stable": "data-1-1"}, "x": 1,
               "companion": {"channels": [], "stable": "companion-v1.0.0"},
               "app": {"channels": [{"tag": "app-v1.0.0-a.1", "extra": 1, "id": "a"}], "stable": "app-v0.9.0"}}
        out = core.dump_channels(doc)
        parsed = json.loads(out)
        self.assertEqual(list(parsed), ["app", "companion", "data", "x"])
        self.assertEqual(list(parsed["app"]), ["stable", "channels"])
        self.assertEqual(list(parsed["app"]["channels"][0]), ["id", "tag", "extra"])
        self.assertTrue(out.endswith("}\n"))

    def test_accessors(self):
        doc = core.load_channels(CHANNELS)
        self.assertEqual(core.stable_of(doc, "app"), "app-v0.17.0")
        self.assertEqual(core.stable_of(doc, "data"), "data-4.10.2.12913470-2")
        self.assertEqual([e["id"] for e in core.channel_entries(doc, "companion")], ["joysticks"])
        self.assertEqual(core.channel_entries({}, "app"), [])
        self.assertIsNone(core.stable_of({}, "app"))
        self.assertIsNone(core.stable_of({"data": {"stable": 5}}, "data"))

    def test_remove_touches_one_product_only(self):
        doc = core.load_channels(CHANNELS)
        out = core.remove_channel(doc, "app", "joysticks")
        self.assertEqual([e["id"] for e in out["app"]["channels"]], ["other"])
        self.assertEqual([e["id"] for e in out["companion"]["channels"]], ["joysticks"])
        self.assertEqual(out["data"], doc["data"])
        self.assertEqual(len(doc["app"]["channels"]), 2)  # input untouched
        with self.assertRaises(KeyError):
            core.remove_channel(doc, "app", "nope")
        with self.assertRaises(KeyError):
            core.remove_channel({"app": {"stable": "app-v1.0.0"}}, "app", "x")

    def test_remove_last_keeps_empty_list(self):
        doc = core.load_channels('{"app": {"stable": "app-v1.0.0", "channels": [{"id": "a", "tag": "app-v1.1.0-a.1"}]}}')
        self.assertEqual(core.dump_channels(core.remove_channel(doc, "app", "a")),
                         '{\n  "app": {\n    "stable": "app-v1.0.0",\n    "channels": []\n  }\n}\n')

    def test_invalid(self):
        for bad in ["[]", '{"app": []}', '{"app": {"channels": {}}}', '{"app": {"channels": [{"tag": "x"}]}}',
                    '{"companion": {"channels": [1]}}', '{"data": 3}', "{"]:
            with self.assertRaises(ValueError, msg=bad):
                core.load_channels(bad)

    def test_sections_are_optional(self):
        self.assertEqual(core.load_channels("{}"), {})
        doc = core.load_channels('{"data": {"stable": "data-1-1"}}')
        self.assertEqual(core.channel_entries(doc, "app"), [])


REL = {
    "app-v0.16.1": core.RELEASE, "app-v0.16.2": core.PRERELEASE, "app-v0.17.0": core.RELEASE,
    "app-v0.18.0-j.1": core.PRERELEASE, "app-v0.18.0-j.2": core.DRAFT, "app-v0.19.0": core.DRAFT,
    "companion-v2.1.0": core.RELEASE, "companion-v2.2.0-j.1": core.PRERELEASE,
    "companion-v2.2.0-j.2": core.DRAFT,
    "data-4.10.2.12913470-1": core.RELEASE, "data-4.10.2.12913470-2": core.DRAFT,
    "data-4.9.0.1-1": core.RELEASE,
}


class Overview(unittest.TestCase):
    def rows(self, doc, prod=APP, tags=None, releases=REL, local=(), remote=(), counts=None):
        tags = set(tags if tags is not None else REL)
        return {r.id: r for r in core.build_rows(
            prod, doc, tags, releases, set(local), set(remote), counts or {})}

    def test_latest_live_is_per_product(self):
        self.assertEqual(core.latest_live(APP, set(REL), REL), v("0.17.0"))
        self.assertEqual(core.latest_live(COMPANION, set(REL), REL), v("2.1.0"))
        self.assertIsNone(core.latest_live(APP, set(REL), None))

    def test_live_info(self):
        doc = {"app": {"stable": "app-v0.17.0"}}
        info = core.build_live(APP, doc, set(REL), REL)
        self.assertEqual(info.latest, v("0.17.0"))
        self.assertEqual(info.newest_tag, v("0.19.0"))
        self.assertEqual(info.newest_state, core.DRAFT)
        self.assertEqual(info.stable, "app-v0.17.0")
        comp = core.build_live(COMPANION, doc, set(REL), REL)
        self.assertEqual((comp.latest, comp.newest_tag, comp.stable), (v("2.1.0"), v("2.1.0"), None))

    def test_union_of_sources(self):
        doc = {"app": {"channels": [{"id": "listed", "tag": "app-v0.18.0-listed.1"}]}}
        rows = self.rows(doc, tags=set(REL) | {"app-v0.18.0-tagonly.1"},
                         local={"loc"}, remote={"rem"})
        self.assertEqual(set(rows), {"listed", "j", "tagonly", "loc", "rem"})

    def test_a_channel_of_the_other_app_does_not_show_by_its_tags_only(self):
        rows = self.rows({}, prod=COMPANION)
        self.assertEqual(set(rows), {"j"})
        self.assertEqual(rows["j"].newest, v("2.2.0-j.2"))
        only_app = set(REL) | {"app-v0.18.0-appchan.1"}
        self.assertNotIn("appchan", self.rows({}, prod=COMPANION, tags=only_app))
        # ... but a branch is shared: it shows up for both.
        self.assertIn("shared", self.rows({}, prod=COMPANION, local={"shared"}))
        self.assertIn("shared", self.rows({}, prod=APP, local={"shared"}))

    def test_healthy_channel(self):
        doc = {"app": {"channels": [{"id": "j", "tag": "app-v0.18.0-j.1"}]}}
        row = self.rows(doc, local={"j"}, counts={"j": (3, 0)})["j"]
        self.assertEqual(row.newest, v("0.18.0-j.2"))
        self.assertEqual(row.newest_state, core.DRAFT)
        self.assertEqual(row.listed_state, core.PRERELEASE)
        self.assertEqual(row.warnings, [])

    def test_the_other_products_listing_is_not_this_ones(self):
        doc = {"companion": {"channels": [{"id": "j", "tag": "companion-v2.2.0-j.1"}]}}
        row = self.rows(doc, prod=APP, local={"j"}, counts={"j": (3, 0)})["j"]
        self.assertFalse(row.listed)
        row = self.rows(doc, prod=COMPANION, local={"j"}, counts={"j": (3, 0)})["j"]
        self.assertTrue(row.listed)
        self.assertEqual(row.warnings, [])

    def test_base_not_above_live(self):
        rel = dict(REL, **{"app-v0.17.0-old.3": core.PRERELEASE})
        row = self.rows({}, tags=set(rel), releases=rel, remote={"old"},
                        counts={"old": (1, 5)})["old"]
        self.assertEqual(row.warnings, ["base <= live 0.17.0"])

    def test_listed_unpublished_and_no_branch(self):
        doc = {"app": {"channels": [{"id": "j", "tag": "app-v0.18.0-j.2"}]}}
        row = self.rows(doc)["j"]
        self.assertIn("listed tag unpublished", row.warnings)
        self.assertIn("listed, no branch", row.warnings)

    def test_listed_tag_missing_release(self):
        doc = {"app": {"channels": [{"id": "j", "tag": "app-v0.18.0-j.9"}]}}
        row = self.rows(doc, local={"j"}, counts={"j": (1, 0)})["j"]
        self.assertEqual(row.listed_state, core.MISSING)
        self.assertEqual(row.warnings, ["listed tag unpublished"])

    def test_merged_still_listed(self):
        doc = {"app": {"channels": [{"id": "j", "tag": "app-v0.18.0-j.1"}]}}
        row = self.rows(doc, local={"j"}, counts={"j": (0, 4)})["j"]
        self.assertEqual(row.warnings, ["merged, still listed"])

    def test_listed_tag_invalid(self):
        # None, another channel, garbage, the other app's tag, and a bare v-tag of the old scheme.
        for tag in [None, "app-v0.18.0-other.1", "garbage", "companion-v2.2.0-j.1", "v0.18.0-j.1"]:
            doc = {"app": {"channels": [{"id": "j", "tag": tag}]}}
            row = self.rows(doc, local={"j"}, counts={"j": (1, 0)})["j"]
            self.assertIn("listed tag invalid", row.warnings, tag)

    def test_gh_unreachable_no_publication_warnings(self):
        doc = {"app": {"channels": [{"id": "j", "tag": "app-v0.18.0-j.1"}]}}
        row = self.rows(doc, releases=None, local={"j"}, counts={"j": (1, 0)})["j"]
        self.assertEqual(row.listed_state, core.UNKNOWN)
        self.assertEqual(row.warnings, [])


class Drafts(unittest.TestCase):
    def test_per_kind_newest_first(self):
        drafts = core.list_drafts(REL)
        self.assertEqual([d.tag for d in drafts], [
            "app-v0.19.0", "app-v0.18.0-j.2", "companion-v2.2.0-j.2", "data-4.10.2.12913470-2"])
        self.assertEqual([d.label for d in drafts],
                         ["app live", "app channel j", "companion channel j", "data"])

    def test_data_drafts_sort_by_label_then_n(self):
        rel = {"data-4.9.0.1-12": core.DRAFT, "data-4.10.2.5-1": core.DRAFT, "data-4.9.0.1-3": core.DRAFT}
        self.assertEqual([d.tag for d in core.list_drafts(rel)],
                         ["data-4.10.2.5-1", "data-4.9.0.1-12", "data-4.9.0.1-3"])

    def test_foreign_and_none(self):
        self.assertEqual(core.list_drafts(None), [])
        self.assertEqual(core.list_drafts({"v1.0.0": core.DRAFT, "junk": core.DRAFT}), [])


class DataReleases(unittest.TestCase):
    def test_tags(self):
        self.assertEqual(core.data_tag("4.10.2.12913470", 1), "data-4.10.2.12913470-1")
        self.assertEqual(core.full_pack_name("4.10.2.12913470", 2), "quartermaster-data-4.10.2.12913470-2.zip")
        self.assertEqual(core.parse_data_tag("data-4.10.2.12913470-12"), ("4.10.2.12913470", 12))
        for bad in ["data-4.10-0", "data--1", "data-4.10", "app-v1.0.0", "data-4.10.2-01", "xdata-1-1"]:
            self.assertIsNone(core.parse_data_tag(bad), bad)

    def test_next_n(self):
        tags = set(REL)
        self.assertEqual(core.next_data_n("4.10.2.12913470", tags), 3)
        self.assertEqual(core.next_data_n("4.11.0.1", tags), 1)
        self.assertEqual(core.next_data_n("4.9.0.1", tags), 2)

    def test_label_from_head(self):
        head = ('{"schemaVersion":7,"game":{"channel":"LIVE","build":12913470,"branch":"sc-alpha-4.10.2",'
                '"version":"4.10.197.2878","label":"4.10.2.12913470","manifest":{"Data":{"Branch":"x"}}},'
                '"extractor":{"label":"nope"}}')
        self.assertEqual(core.label_from_head(head), "4.10.2.12913470")
        self.assertIsNone(core.label_from_head('{"game":{"manifest":{"a":1},"label":"late"}}'))
        self.assertIsNone(core.label_from_head("{"))

    def test_build_data(self):
        doc = {"data": {"stable": "data-4.10.2.12913470-1"}}
        info = core.build_data(doc, set(REL), REL)
        self.assertEqual(info.stable, "data-4.10.2.12913470-1")
        self.assertEqual(info.stable_state, core.RELEASE)
        self.assertEqual(info.newest, "data-4.10.2.12913470-2")  # 4.10 > 4.9, numerically
        self.assertEqual(info.newest_state, core.DRAFT)
        empty = core.build_data({}, {"app-v1.0.0"}, REL)
        self.assertEqual((empty.stable, empty.newest, empty.stable_state), (None, None, ""))

    def test_sizes_and_summary(self):
        self.assertEqual(core.format_size(512), "512 B")
        self.assertEqual(core.format_size(2048), "2.0 KiB")
        self.assertEqual(core.format_size(44234379), "42.2 MiB")
        manifest = {"tag": "data-4.10.2.12913470-2", "previous": "data-4.10.2.12913470-1",
                    "game": {"label": "4.10.2.12913470", "build": 12913470}, "schemaVersion": 7,
                    "files": {"thumbs": {"name": "thumbs-update.zip", "size": 1024, "count": 3}}}
        sizes = {"manifest.json": 700, "thumbs-update.zip": 1024}
        text = core.pack_summary(manifest, sizes)
        self.assertIn("data-4.10.2.12913470-2", text)
        self.assertIn("previous   data-4.10.2.12913470-1", text)
        self.assertIn("delta      1.0 KiB (3 new pictures in thumbs-update.zip)", text)
        first = dict(manifest, previous=None)
        self.assertIn("(first release)", core.pack_summary(first, sizes))
        self.assertIn("Previous: data-4.10.2.12913470-1", core.data_release_notes(manifest))
        self.assertIn("First release", core.data_release_notes(first))


class BuildRuns(unittest.TestCase):
    def test_a_running_build(self):
        now = datetime(2026, 9, 27, 11, 0, 30, tzinfo=timezone.utc)
        data = {"status": "in_progress", "conclusion": "", "url": "https://x/runs/1",
                "jobs": [
                    {"name": "Tests", "status": "completed", "conclusion": "success",
                     "startedAt": "2026-09-27T10:58:54Z", "completedAt": "2026-09-27T11:00:04Z"},
                    {"name": "Build (linux)", "status": "in_progress", "conclusion": "",
                     "startedAt": "2026-09-27T11:00:10Z", "completedAt": "0001-01-01T00:00:00Z"},
                    {"name": "Build (windows)", "status": "queued", "conclusion": "",
                     "startedAt": "0001-01-01T00:00:00Z", "completedAt": "0001-01-01T00:00:00Z"}]}
        run = core.parse_run(data, now)
        self.assertEqual(run.state, "running")
        self.assertFalse(run.done)
        self.assertEqual([(j.name, j.state, core.duration(j.seconds)) for j in run.jobs],
                         [("Tests", "success", "1:10"), ("Build (linux)", "running", "0:20"),
                          ("Build (windows)", "queued", "")])

    def test_a_finished_build(self):
        now = datetime(2026, 9, 27, 12, 0, tzinfo=timezone.utc)
        run = core.parse_run({"status": "completed", "conclusion": "failure", "jobs": [
            {"name": "Tests", "status": "completed", "conclusion": "failure",
             "startedAt": "2026-09-27T10:00:00Z", "completedAt": "2026-09-27T10:02:05Z"}]}, now)
        self.assertEqual(run.state, "failure")
        self.assertTrue(run.done)
        self.assertEqual(core.duration(run.jobs[0].seconds), "2:05")
        # Anything unexpected parses without a crash.
        self.assertEqual(core.parse_run({}, now).jobs, [])

    def test_steps_in_order_and_which_jobs_open(self):
        now = datetime(2026, 9, 27, 11, 1, 0, tzinfo=timezone.utc)
        step = lambda n, name, status, conclusion, start, end: {
            "number": n, "name": name, "status": status, "conclusion": conclusion,
            "startedAt": start, "completedAt": end}
        z = "0001-01-01T00:00:00Z"
        run = core.parse_run({"status": "in_progress", "jobs": [
            {"name": "Tests", "status": "completed", "conclusion": "success",
             "startedAt": "2026-09-27T10:58:00Z", "completedAt": "2026-09-27T10:59:00Z",
             "steps": [step(1, "Set up job", "completed", "success",
                            "2026-09-27T10:58:00Z", "2026-09-27T10:58:02Z")]},
            {"name": "Build (linux)", "status": "in_progress", "conclusion": "",
             "startedAt": "2026-09-27T10:59:00Z", "completedAt": z,
             "steps": [step(3, "Upload", "queued", "", z, z),
                       step(2, "Build bundles", "in_progress", "", "2026-09-27T11:00:00Z", z),
                       step(1, "Set up job", "completed", "success",
                            "2026-09-27T10:59:00Z", "2026-09-27T10:59:03Z")]}]}, now)
        tests, linux = run.jobs
        self.assertFalse(tests.expanded)
        self.assertTrue(linux.expanded)
        self.assertEqual([(s.name, s.state, core.duration(s.seconds)) for s in linux.steps],
                         [("Set up job", "success", "0:03"), ("Build bundles", "running", "1:00"),
                          ("Upload", "queued", "")])


if __name__ == "__main__":
    unittest.main()
