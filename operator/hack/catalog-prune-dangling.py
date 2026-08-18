#!/usr/bin/env python3
"""Remove prerelease catalog entries whose bundle images no longer exist.

Prerelease bundle images are published with a quay.expires-at label and are
pruned automatically. The catalog keeps referencing them by tag, so over time it
accumulates entries that cannot be installed. This removes those entries and
repairs the upgrade chain so the channel still has exactly one head.

Scope is deliberately narrow:

  * Only PRERELEASE entries are pruned. A missing STABLE image is a much bigger
    problem than catalog hygiene and is reported as an error instead, because
    silently dropping a stable release would strand anyone sitting on it.
  * A registry lookup that fails for any reason other than a definite 404 is
    treated as "present". Never prune on a network hiccup.

Chain repair: removing X splices it out. Anything that replaced X is re-pointed
at whatever X replaced, so the chain stays connected end to end.

Dry run by default; pass --apply to write.
"""

import argparse
import json
import sys
import urllib.error
import urllib.request

TIMEOUT = 20
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


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


def is_prerelease(bundle_name):
    """ovn-recon-operator.v0.3.8-a1 -> True; ...v0.3.7 -> False."""
    _, _, ver = bundle_name.partition(".v")
    return "-" in ver


def image_exists(ref):
    """True/False, or None when the registry did not give a definite answer."""
    if "@" in ref:            # digest refs are immutable; treat as present
        return True
    repo, _, tag = ref.rpartition(":")
    if "/" not in repo:
        return None
    host, _, path = repo.partition("/")
    url = f"https://{host}/v2/{path}/manifests/{tag}"
    req = urllib.request.Request(url, method="HEAD")
    req.add_header("Accept", ACCEPT)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return 200 <= r.status < 300
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return False
        return None       # 401/403/5xx -> unknown, do not prune
    except Exception:
        return None


def channel_head(entries):
    replaced = {e.get("replaces") for e in entries if e.get("replaces")}
    return [e["name"] for e in entries if e["name"] not in replaced]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbc", required=True)
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    args = ap.parse_args()

    objs = list(iter_json(open(args.fbc).read()))
    bundles = {b["name"]: b for b in objs if b.get("schema") == "olm.bundle"}

    print(f"checking {len(bundles)} bundle image(s)...")
    missing, unknown, stable_missing = set(), [], []
    for name, b in sorted(bundles.items()):
        exists = image_exists(b.get("image", ""))
        if exists is True:
            continue
        if exists is None:
            unknown.append(name)
            continue
        if is_prerelease(name):
            missing.add(name)
        else:
            stable_missing.append(name)

    for n in unknown:
        print(f"  ? {n}: registry gave no definite answer; treating as present")
    if stable_missing:
        print("\nERROR: stable releases whose images are gone:")
        for n in stable_missing:
            print(f"  - {n} -> {bundles[n].get('image')}")
        print("Not pruned. A stable entry vanishing needs a decision, not automatic cleanup.")
        return 1

    if not missing:
        print("\nno dangling prerelease entries; catalog unchanged")
        return 0

    print(f"\n{len(missing)} dangling prerelease entr(ies):")
    for n in sorted(missing):
        print(f"  - {n} -> {bundles[n].get('image')}")

    # Splice out of every channel, keeping the chain connected.
    for ch in [o for o in objs if o.get("schema") == "olm.channel"]:
        entries = ch.get("entries", [])
        if not any(e["name"] in missing for e in entries):
            continue
        replaces = {e["name"]: e.get("replaces") for e in entries}

        def resolve(target):
            """Walk back past removed entries to the first surviving one."""
            seen = set()
            while target in missing and target not in seen:
                seen.add(target)
                target = replaces.get(target)
            return target

        kept = []
        for e in entries:
            if e["name"] in missing:
                continue
            new = dict(e)
            if e.get("replaces"):
                r = resolve(e["replaces"])
                if r:
                    new["replaces"] = r
                else:
                    new.pop("replaces", None)
            kept.append(new)
        before, after = len(entries), len(kept)
        heads = channel_head(kept)
        print(f"  channel {ch['name']!r}: {before} -> {after} entries, head(s) {heads}")
        if len(heads) != 1:
            print(f"    ERROR: channel would have {len(heads)} heads; refusing")
            return 1
        ch["entries"] = kept

    objs = [o for o in objs if not (o.get("schema") == "olm.bundle" and o["name"] in missing)]

    if not args.apply:
        print("\ndry run; re-run with --apply to write")
        return 0

    with open(args.fbc, "w") as f:
        for o in objs:
            json.dump(o, f, indent=4)
            f.write("\n")
    print(f"\npruned {len(missing)} entr(ies) from {args.fbc}")
    print("This is NOT an additive change, so `make catalog-fbc-verify` will fail")
    print("against the published catalog by design. Verify with CATALOG_REF= instead.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
