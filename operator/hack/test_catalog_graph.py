#!/usr/bin/env python3
"""Unit tests for the catalog graph logic shared by the hack scripts.

Run with: python3 -m unittest discover -s hack -p 'test_*.py'   (from operator/)
"""

import importlib.util
import os
import unittest


def load(name):
    path = os.path.join(os.path.dirname(__file__), name)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_").replace(".py", ""), path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


add = load("catalog-add-bundle.py")
verify = load("catalog-verify.py")
prune = load("catalog-prune-dangling.py")

P = "ovn-recon-operator."


def entries(*specs):
    """('v1', 'replaces', ['skips']) tuples -> channel entries."""
    out = []
    for spec in specs:
        name, replaces, skips = (list(spec) + [None, None])[:3]
        e = {"name": P + name}
        if replaces:
            e["replaces"] = P + replaces
        if skips:
            e["skips"] = [P + s for s in skips]
        out.append(e)
    return out


def simulate(sequence):
    """Add bundles in order through plan_edges, returning the channel entries."""
    chan = []
    for name in sequence:
        replaces, skips = add.plan_edges(chan, P + name)
        e = {"name": P + name}
        if replaces:
            e["replaces"] = replaces
        if skips:
            e["skips"] = skips
        chan.append(e)
    return chan


class VersionOrdering(unittest.TestCase):
    def test_release_sorts_above_its_prereleases(self):
        self.assertLess(add.version_key(P + "v1.0.4-b3"), add.version_key(P + "v1.0.4"))
        self.assertLess(add.version_key(P + "v1.0.3"), add.version_key(P + "v1.0.4-a0"))

    def test_is_prerelease(self):
        self.assertTrue(add.is_prerelease(P + "v1.0.4-b3"))
        self.assertFalse(add.is_prerelease(P + "v1.0.4"))


class PlanEdges(unittest.TestCase):
    def test_first_entry_has_no_edges(self):
        self.assertEqual(add.plan_edges([], P + "v1.0.0"), (None, []))

    def test_stable_after_stable_replaces_it(self):
        chan = simulate(["v1.0.2", "v1.0.3"])
        self.assertEqual(chan[-1], {"name": P + "v1.0.3", "replaces": P + "v1.0.2"})

    def test_prerelease_sequence_then_ga(self):
        chan = simulate(["v1.0.3", "v1.0.4-a0", "v1.0.4-a1", "v1.0.4-b0", "v1.0.4"])
        by = {e["name"]: e for e in chan}
        # every prerelease replaces the last stable and skips its predecessors
        self.assertEqual(by[P + "v1.0.4-a0"], {"name": P + "v1.0.4-a0", "replaces": P + "v1.0.3"})
        self.assertEqual(by[P + "v1.0.4-a1"]["replaces"], P + "v1.0.3")
        self.assertEqual(by[P + "v1.0.4-a1"]["skips"], [P + "v1.0.4-a0"])
        self.assertEqual(by[P + "v1.0.4-b0"]["skips"], [P + "v1.0.4-a0", P + "v1.0.4-a1"])
        # GA replaces the previous stable and skips all of its prereleases
        self.assertEqual(by[P + "v1.0.4"]["replaces"], P + "v1.0.3")
        self.assertEqual(by[P + "v1.0.4"]["skips"], [P + "v1.0.4-a0", P + "v1.0.4-a1", P + "v1.0.4-b0"])
        # exactly one head, and it is the GA
        self.assertEqual(add.channel_head({"entries": chan}), P + "v1.0.4")

    def test_next_prerelease_after_ga_replaces_ga_with_no_skips(self):
        chan = simulate(["v1.0.3", "v1.0.4-b0", "v1.0.4", "v1.0.5-a0", "v1.0.5-a1"])
        by = {e["name"]: e for e in chan}
        self.assertEqual(by[P + "v1.0.5-a0"], {"name": P + "v1.0.5-a0", "replaces": P + "v1.0.4"})
        self.assertEqual(by[P + "v1.0.5-a1"]["replaces"], P + "v1.0.4")
        self.assertEqual(by[P + "v1.0.5-a1"]["skips"], [P + "v1.0.5-a0"])
        self.assertEqual(add.channel_head({"entries": chan}), P + "v1.0.5-a1")

    def test_prerelease_only_channel_falls_back_to_linear(self):
        chan = simulate(["v0.1.0-a0", "v0.1.0-a1"])
        self.assertEqual(chan[-1], {"name": P + "v0.1.0-a1", "replaces": P + "v0.1.0-a0"})

    def test_channel_head_treats_skipped_entries_as_superseded(self):
        chan = entries(("v1.0.3",), ("v1.0.4-a0", "v1.0.3"), ("v1.0.4-a1", "v1.0.3", ["v1.0.4-a0"]))
        self.assertEqual(add.channel_head({"entries": chan}), P + "v1.0.4-a1")

    def test_downgrade_is_detected_against_the_head(self):
        chan = simulate(["v1.0.3", "v1.0.4-a0"])
        head = add.channel_head({"entries": chan})
        self.assertLess(add.version_key(P + "v1.0.3-b9"), add.version_key(head))


def catalog(chan_entries, channel="latest"):
    objs = [{"schema": "olm.package", "name": "ovn-recon-operator", "defaultChannel": channel},
            {"schema": "olm.channel", "package": "ovn-recon-operator", "name": channel, "entries": chan_entries}]
    for e in chan_entries:
        objs.append({"schema": "olm.bundle", "name": e["name"], "package": "ovn-recon-operator",
                     "image": f"quay.io/x/bundle:{e['name'].rpartition('.v')[2]}"})
    return objs


class Integrity(unittest.TestCase):
    def test_skip_shaped_channel_is_sound(self):
        objs = catalog(simulate(["v1.0.3", "v1.0.4-a0", "v1.0.4-a1", "v1.0.4"]))
        self.assertEqual(verify.check_integrity(objs), [])

    def test_two_heads_is_a_problem(self):
        objs = catalog(entries(("v1.0.3",), ("v1.0.4-a0",)))
        self.assertTrue(any("exactly 1 head" in p for p in verify.check_integrity(objs)))

    def test_skips_target_must_exist(self):
        objs = catalog(entries(("v1.0.3",), ("v1.0.4", "v1.0.3", ["v1.0.4-zz"])))
        self.assertTrue(any("skips" in p and "not in the channel" in p for p in verify.check_integrity(objs)))

    def test_entry_reachable_only_via_skips_counts(self):
        objs = catalog(entries(("v1.0.3",), ("v1.0.4-a0", "v1.0.3"), ("v1.0.4", "v1.0.3", ["v1.0.4-a0"])))
        self.assertEqual(verify.check_integrity(objs), [])


class Regression(unittest.TestCase):
    def test_rewiring_prereleases_to_skip_shape_is_allowed(self):
        old = catalog(entries(("v1.0.3",), ("v1.0.4-a0", "v1.0.3"), ("v1.0.4-a1", "v1.0.4-a0")))
        new = catalog(simulate(["v1.0.3", "v1.0.4-a0", "v1.0.4-a1", "v1.0.4-a2"]))
        self.assertEqual(verify.check_regression(old, new), [])

    def test_rewiring_a_stable_edge_is_refused(self):
        old = catalog(entries(("v1.0.2",), ("v1.0.3", "v1.0.2")))
        new = catalog(entries(("v1.0.2",), ("v1.0.3",)))
        self.assertTrue(any("edge rewritten" in p for p in verify.check_regression(old, new)))

    def test_stranding_a_prerelease_is_refused(self):
        old = catalog(entries(("v1.0.3",), ("v1.0.4-a0", "v1.0.3")))
        # a0 loses its edge and nothing skips it: two heads, a0 unreachable
        new = catalog(entries(("v1.0.3",), ("v1.0.4-a0",), ("v1.0.4-a1", "v1.0.3")))
        self.assertTrue(any("edge rewritten" in p for p in verify.check_regression(old, new)))

    def test_removing_an_entry_is_refused(self):
        old = catalog(entries(("v1.0.3",), ("v1.0.4-a0", "v1.0.3")))
        new = catalog(entries(("v1.0.3",)))
        self.assertTrue(any("REMOVED" in p for p in verify.check_regression(old, new)))


class Prune(unittest.TestCase):
    def test_head_accounts_for_skips(self):
        chan = simulate(["v1.0.3", "v1.0.4-a0", "v1.0.4-a1"])
        self.assertEqual(prune.channel_head(chan), [P + "v1.0.4-a1"])


if __name__ == "__main__":
    unittest.main()
