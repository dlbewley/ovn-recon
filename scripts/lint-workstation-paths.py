#!/usr/bin/env python3
"""Fail when a tracked file contains an absolute path into someone's home directory.

A path under a macOS or Linux home directory resolves on one workstation
only, and it can leak a personal layout (a kubeconfig location, a clone
directory) into the repository. Docs and examples should name repository
files relative to the repo root and use a placeholder such as
/path/to/kubeconfig for anything outside it.

Checked: every text file `git ls-files` reports (or the paths given). A
match is a home-directory root followed by an account name and a slash.
Generic placeholder names and well-known service accounts are allowed; see
PLACEHOLDER_NAMES and ALLOWED_PREFIXES. A line that must keep such a path
can opt out by containing the marker in ALLOW_MARKER.

Usage: python3 scripts/lint-workstation-paths.py [path ...]   (default: all tracked files)
"""

import re
import subprocess
import sys

# Home roots on macOS and Linux, then the account name, then a slash.
HOME_PATH = re.compile(r"/(Users|home)/([A-Za-z0-9._-]+)/")

# Names that stand for "some user" in documentation rather than a person.
PLACEHOLDER_NAMES = {"Shared", "user", "username", "you", "me", "USER", "USERNAME"}

# Accounts that are part of a platform, not a workstation.
ALLOWED_PREFIXES = (
    "/home/runner/",  # GitHub-hosted Actions runners
)

ALLOW_MARKER = "lint:allow-workstation-path"


def tracked_files():
    out = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True).stdout
    return [name for name in out.decode("utf-8").split("\0") if name]


def findings(path):
    """Yield (line number, matched text) for each workstation path in a text file."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read()
    except (FileNotFoundError, IsADirectoryError):
        return  # deleted in the working tree, or a submodule entry
    if b"\0" in raw:
        return  # binary
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return
    for number, line in enumerate(text.splitlines(), start=1):
        if ALLOW_MARKER in line:
            continue
        for match in HOME_PATH.finditer(line):
            if match.group(2) in PLACEHOLDER_NAMES:
                continue
            if match.group(0).startswith(ALLOWED_PREFIXES):
                continue
            yield number, match.group(0)


def main():
    files = sys.argv[1:] or tracked_files()
    failures = 0
    for path in files:
        for number, matched in findings(path):
            failures += 1
            print(f"FAIL {path}:{number}: {matched}")

    print(f"\nchecked {len(files)} file(s)")
    if failures:
        print(f"{failures} workstation path(s) found")
        print("Use a repo-relative path, or a placeholder such as /path/to/kubeconfig.")
        print(f"If the path is intentional, add '{ALLOW_MARKER}' to that line.")
        sys.exit(1)
    print("no workstation paths")


if __name__ == "__main__":
    main()
