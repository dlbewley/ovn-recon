#!/usr/bin/env python3
"""Verify the file-based catalog is internally sound and has not regressed.

Two independent checks:

  INTEGRITY (always, offline)
    Every channel has exactly one head, every entry reaches that head by its
    replaces chain, and no replaces points at an entry that is not present.
    A forked or broken graph strands users on a version with no upgrade path.

  REGRESSION (with --ref, needs network)
    Diffs the local catalog against a published catalog image. The change must
    be ADDITIVE: no bundle removed, no image ref changed on a pre-existing
    bundle, no edge rewritten on a pre-existing channel entry, default channel
    unchanged. That is what makes "existing users are unaffected" a checked
    fact rather than an assumption.

Exit non-zero if either check fails. Uses only the Python standard library.
"""

import argparse
import json
import os
import subprocess
import sys


def iter_json(text):
    dec = json.JSONDecoder()
    i = 0
    while True:
        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text):
            return
        obj, i = dec.raw_decode(text, i)
        yield obj


POLICY_PATHS = ("~/.config/containers/policy.json", "/etc/containers/policy.json")


def require_signature_policy():
    """opm pulls through containers/image, which refuses to run without a policy file.

    There is no flag or environment variable to point at one; only these two
    paths are consulted. Fail with the fix rather than letting opm emit its
    own message, which does not say what the file should contain.
    """
    if any(os.path.exists(os.path.expanduser(p)) for p in POLICY_PATHS):
        return
    sys.exit(
        "no container signature policy found, so the published-catalog diff cannot pull.\n"
        "opm looks only at " + " or ".join(POLICY_PATHS) + " (no flag, no env var).\n"
        "\nCreate the permissive default that podman and skopeo also use:\n"
        "  mkdir -p ~/.config/containers && \\\n"
        "    printf '{\"default\":[{\"type\":\"insecureAcceptAnything\"}]}' > ~/.config/containers/policy.json\n"
        "\nOr skip the published diff and run the offline integrity check only:\n"
        "  make catalog-fbc-verify CATALOG_REF="
    )


def render(opm, ref):
    proc = subprocess.run([opm, "render", ref, "-o", "json"],
                          stdout=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        sys.exit(f"opm render failed for {ref}; see error above")
    return list(iter_json(proc.stdout))


def load(path):
    with open(path) as f:
        return list(iter_json(f.read()))


def channels(objs):
    return {c["name"]: {e["name"]: e.get("replaces") for e in c.get("entries", [])}
            for c in objs if c.get("schema") == "olm.channel"}


def bundles(objs):
    return {b["name"]: b.get("image") for b in objs if b.get("schema") == "olm.bundle"}


def default_channel(objs):
    pkgs = [p for p in objs if p.get("schema") == "olm.package"]
    return pkgs[0].get("defaultChannel") if pkgs else None


def check_integrity(objs):
    problems = []
    chans = channels(objs)
    known = set(bundles(objs))
    if not chans:
        problems.append("no olm.channel objects found")
    for name, entries in sorted(chans.items()):
        replaced = {r for r in entries.values() if r}
        heads = [n for n in entries if n not in replaced]
        if len(heads) != 1:
            problems.append(f"channel {name!r}: expected exactly 1 head, found {len(heads)}: {sorted(heads)}")
            continue
        seen, cur = set(), heads[0]
        while cur and cur not in seen:
            seen.add(cur)
            cur = entries.get(cur)
        unreachable = sorted(set(entries) - seen)
        if unreachable:
            problems.append(f"channel {name!r}: no upgrade path to head for {unreachable}")
        for n, r in sorted(entries.items()):
            if r and r not in entries:
                problems.append(f"channel {name!r}: {n} replaces {r}, which is not in the channel")
            if n not in known:
                problems.append(f"channel {name!r}: entry {n} has no olm.bundle object")
        print(f"  channel {name!r}: {len(entries)} entries, head {heads[0]}, all reachable")
    return problems


def check_regression(old, new):
    problems = []
    oc, nc = channels(old), channels(new)
    ob, nb = bundles(old), bundles(new)

    if default_channel(old) != default_channel(new):
        problems.append(f"defaultChannel changed: {default_channel(old)!r} -> {default_channel(new)!r}")

    for name in sorted(set(oc) - set(nc)):
        problems.append(f"channel {name!r} was REMOVED")

    for name in sorted(set(oc) & set(nc)):
        o, n = oc[name], nc[name]
        for gone in sorted(set(o) - set(n)):
            problems.append(f"channel {name!r}: entry {gone} was REMOVED")
        for k in sorted(set(o) & set(n)):
            if o[k] != n[k]:
                problems.append(f"channel {name!r}: edge rewritten on {k}: replaces {o[k]!r} -> {n[k]!r}")
        added = sorted(set(n) - set(o))
        print(f"  channel {name!r}: +{len(added)} entries {added if added else ''}".rstrip())

    for gone in sorted(set(ob) - set(nb)):
        problems.append(f"bundle {gone} was REMOVED")
    for k in sorted(set(ob) & set(nb)):
        if ob[k] != nb[k]:
            problems.append(f"bundle {k}: image changed {ob[k]!r} -> {nb[k]!r}")
    for name in sorted(set(nc) - set(oc)):
        print(f"  channel {name!r}: NEW ({len(nc[name])} entries)")
    return problems


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbc", required=True, help="path to catalog.json")
    ap.add_argument("--ref", help="published catalog image to diff against (e.g. quay.io/.../catalog:latest)")
    ap.add_argument("--opm", default="bin/opm")
    args = ap.parse_args()

    new = load(args.fbc)
    print(f"integrity: {args.fbc}")
    problems = check_integrity(new)

    if args.ref:
        require_signature_policy()
        print(f"\nregression vs {args.ref} (must be additive)")
        problems += check_regression(render(args.opm, args.ref), new)

    if problems:
        print("\nFAILED:")
        for p in problems:
            print("  -", p)
        sys.exit(1)
    print("\nOK")


if __name__ == "__main__":
    main()
