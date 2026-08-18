#!/usr/bin/env python3
"""Syntax-check the shell inside every GitHub Actions `run:` block.

Validating that a workflow's YAML parses says nothing about the shell it
contains. A `run:` block guarded by `if: startsWith(github.ref, 'refs/tags/v')`
never executes on a pull request, so a syntax error in it ships green and only
surfaces when someone cuts a release. That has happened here more than once.

GitHub expressions (${{ ... }}) are replaced with a placeholder before parsing,
since they are substituted by the runner before bash ever sees them.

Usage: python3 scripts/lint-workflows.py [path ...]   (default: .github/workflows)
"""

import glob
import os
import re
import subprocess
import sys

try:
    import yaml
except ImportError:
    sys.exit("PyYAML is required: pip install pyyaml")

EXPR = re.compile(r"\$\{\{.*?\}\}", re.DOTALL)

# Shells we can check. `run:` may select another via `shell:`; skip those
# rather than reporting false errors against a different language.
BASH_SHELLS = {None, "bash", "sh", "bash -e {0}", "/usr/bin/bash -e {0}"}


def check(text):
    """Return an error string, or None if the shell parses."""
    # A placeholder that is a valid bash word in command, operand and string
    # position, so substitution cannot itself introduce a syntax error.
    stripped = EXPR.sub("GHA_EXPR", text)
    proc = subprocess.run(["bash", "-n"], input=stripped, text=True,
                          capture_output=True)
    if proc.returncode == 0:
        return None
    return proc.stderr.strip().replace("/dev/fd/", "stdin:")


def main():
    targets = sys.argv[1:] or [".github/workflows"]
    files = []
    for t in targets:
        if os.path.isdir(t):
            files += sorted(glob.glob(os.path.join(t, "*.yaml")))
            files += sorted(glob.glob(os.path.join(t, "*.yml")))
        else:
            files.append(t)

    if not files:
        sys.exit("no workflow files found")

    failures = 0
    checked = 0
    for f in files:
        try:
            doc = yaml.safe_load(open(f)) or {}
        except yaml.YAMLError as e:
            print(f"FAIL {f}: YAML does not parse: {e}")
            failures += 1
            continue

        for job_name, job in (doc.get("jobs") or {}).items():
            default_shell = ((job.get("defaults") or {}).get("run") or {}).get("shell")
            for i, step in enumerate(job.get("steps") or []):
                run = step.get("run")
                if not run:
                    continue
                shell = step.get("shell", default_shell)
                label = step.get("name") or f"step {i}"
                if shell not in BASH_SHELLS:
                    print(f"SKIP {f} [{job_name}] {label}: shell={shell}")
                    continue
                checked += 1
                err = check(run)
                if err:
                    failures += 1
                    print(f"FAIL {f} [{job_name}] {label}:")
                    for line in err.splitlines():
                        print(f"       {line}")

    print(f"\nchecked {checked} run block(s) across {len(files)} workflow file(s)")
    if failures:
        print(f"{failures} problem(s) found")
        sys.exit(1)
    print("all shell parses")


if __name__ == "__main__":
    main()
