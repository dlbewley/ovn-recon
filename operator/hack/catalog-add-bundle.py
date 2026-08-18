#!/usr/bin/env python3
"""Append a rendered bundle to the file-based catalog and wire up its channel edges.

This replaces `opm index add --mode semver`. The critical difference is that
semver mode INFERRED upgrade edges from version ordering across the whole
package; this script writes them EXPLICITLY, one channel at a time. That is what
makes it possible to carry two independent upgrade graphs (for example a
pre-4.22 stream and a 4.22+ stream) in a single catalog without OLM synthesizing
an edge between them.

Why incremental rather than re-rendering a template:
  Rendering a catalog template pulls every bundle image it references. Our older
  bundles are amd64-only and prereleases are pruned on a daily cron, so a full
  re-render breaks on any host that is not amd64 or any time an old tag is
  garbage collected. Appending to the committed catalog touches only the new
  bundle image, so history stays reproducible regardless of what happens to old
  tags.

Uses only the Python standard library so CI needs no pip install.
"""

import argparse
import json
import re
import subprocess
import sys


def render_bundle(opm, image, image_ref=None):
    """Render a bundle into a single olm.bundle object.

    `image` may be a registry ref or a local bundle directory. A directory
    renders with an empty image field, so `image_ref` must supply the ref the
    bundle will be published under. That is what lets a release add itself to
    the catalog BEFORE CI has pushed the bundle image, keeping the catalog
    change part of the release commit instead of a write-back from CI.
    """
    # stderr is left attached to the terminal: opm's pull failures (missing tag,
    # architecture not in the manifest list, auth) are the errors worth reading.
    proc = subprocess.run(
        [opm, "render", image, "--migrate-level", "bundle-object-to-csv-metadata", "-o", "json"],
        stdout=subprocess.PIPE, text=True,
    )
    if proc.returncode != 0:
        sys.exit(f"opm render failed for {image} (exit {proc.returncode}); see error above")
    out = proc.stdout
    objs = list(iter_json(out))
    bundles = [o for o in objs if o.get("schema") == "olm.bundle"]
    if len(bundles) != 1:
        sys.exit(f"expected exactly 1 olm.bundle from {image}, got {len(bundles)}")
    bundle = bundles[0]
    if image_ref:
        bundle["image"] = image_ref
    if not bundle.get("image"):
        sys.exit(f"rendered bundle from {image} has no image ref; pass --image")
    return bundle


def iter_json(text):
    """Yield objects from a concatenated JSON stream."""
    decoder = json.JSONDecoder()
    idx = 0
    while True:
        while idx < len(text) and text[idx].isspace():
            idx += 1
        if idx >= len(text):
            return
        obj, end = decoder.raw_decode(text, idx)
        yield obj
        idx = end


def version_key(name):
    """Sort key from a bundle name like ovn-recon-operator.v1.2.3-beta.1.

    A release sorts above its own prereleases, matching semver precedence.
    """
    m = re.search(r"v(\d+)\.(\d+)\.(\d+)(?:-(.*))?$", name)
    if not m:
        return (0, 0, 0, 1, "")
    major, minor, patch, pre = m.groups()
    # pre is None for a final release, which must sort AFTER any prerelease
    return (int(major), int(minor), int(patch), 0 if pre else 1, pre or "")


def channel_head(channel):
    """The entry nothing else replaces — the tip of the upgrade chain."""
    entries = channel.get("entries", [])
    if not entries:
        return None
    replaced = {e.get("replaces") for e in entries if e.get("replaces")}
    heads = [e["name"] for e in entries if e["name"] not in replaced]
    if not heads:
        return None
    # A well-formed channel has exactly one head; if the graph forked, take the
    # highest version so the new bundle extends the newest branch.
    return max(heads, key=version_key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fbc", required=True, help="path to catalog.json")
    ap.add_argument("--bundle", required=True,
                    help="bundle image ref, or a local bundle directory (then --image is required)")
    ap.add_argument("--image", help="image ref to record when --bundle is a local directory")
    ap.add_argument("--channels", required=True, help="comma-separated channel names")
    ap.add_argument("--opm", default="bin/opm")
    ap.add_argument("--package", default="ovn-recon-operator")
    ap.add_argument("--allow-downgrade", action="store_true",
                    help="permit adding a bundle that sorts below the channel head")
    args = ap.parse_args()

    with open(args.fbc) as f:
        objs = list(iter_json(f.read()))

    bundle = render_bundle(args.opm, args.bundle, args.image)
    name = bundle["name"]

    if bundle.get("package") != args.package:
        sys.exit(f"bundle package {bundle.get('package')!r} != expected {args.package!r}")

    existing = {o["name"] for o in objs if o.get("schema") == "olm.bundle"}
    if name in existing:
        print(f"bundle {name} already present; leaving catalog unchanged")
        return

    # Guard: the most likely release-time mistake is adding a local bundle
    # directory that was never regenerated, so it still carries the previous
    # (or scaffold) version while the image ref says otherwise.
    ref = args.image or args.bundle
    tag = ref.rsplit(":", 1)[-1] if ":" in ref else ""
    tag_ver = tag[1:] if tag.startswith("v") else tag
    bundle_ver = next((p["value"]["version"] for p in bundle.get("properties", [])
                       if p["type"] == "olm.package"), None)
    if tag_ver and bundle_ver and tag_ver != bundle_ver:
        sys.exit(
            f"version mismatch: image ref {ref!r} implies version {tag_ver!r} but the rendered "
            f"bundle is version {bundle_ver!r}.\n"
            f"If adding from a local directory, regenerate it first (make bundle VERSION={tag_ver})."
        )

    for chan_name in [c.strip() for c in args.channels.split(",") if c.strip()]:
        chan = next(
            (o for o in objs
             if o.get("schema") == "olm.channel"
             and o.get("name") == chan_name
             and o.get("package") == args.package),
            None,
        )
        if chan is None:
            chan = {"schema": "olm.channel", "package": args.package, "name": chan_name, "entries": []}
            objs.append(chan)
            print(f"created channel {chan_name}")
        head = channel_head(chan)
        if head and version_key(name) < version_key(head) and not args.allow_downgrade:
            sys.exit(
                f"refusing to add {name} to channel {chan_name!r}: it sorts BELOW the current "
                f"head {head}.\nOLM would be asked to treat a downgrade as an upgrade edge. "
                f"A lower version usually belongs in its own channel (that is how two release "
                f"streams stay separate). Pass --allow-downgrade if this is deliberate."
            )
        entry = {"name": name}
        if head:
            entry["replaces"] = head
        chan["entries"].append(entry)
        print(f"channel {chan_name}: added {name}" + (f" replacing {head}" if head else " (first entry)"))

    objs.append(bundle)

    # Append in place rather than re-sorting. Sorting the whole catalog would
    # rewrite hundreds of untouched lines on every release and bury the one real
    # change; a reviewable diff is the point of keeping the catalog in git.

    with open(args.fbc, "w") as f:
        for o in objs:
            json.dump(o, f, indent=4)
            f.write("\n")

    print(f"added {name} to {args.fbc}")


if __name__ == "__main__":
    main()
