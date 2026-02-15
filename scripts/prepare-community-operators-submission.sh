#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PACKAGE_NAME="ovn-recon-operator"
DEFAULT_OUT_DIR="${ROOT_DIR}/dist/community-operators"

VERSION="${1:-}"
OUT_DIR="${2:-${DEFAULT_OUT_DIR}}"

if [[ -z "${VERSION}" ]]; then
    cat <<'USAGE'
usage: scripts/prepare-community-operators-submission.sh <version> [output-dir]

example:
  scripts/prepare-community-operators-submission.sh 0.0.4
USAGE
    exit 1
fi

BUNDLE_DIR="${ROOT_DIR}/operator/bundle"
VERSION_DIR="${OUT_DIR}/${PACKAGE_NAME}/${VERSION}"
PACKAGE_ROOT="${OUT_DIR}/${PACKAGE_NAME}"

if [[ ! -d "${BUNDLE_DIR}/manifests" || ! -d "${BUNDLE_DIR}/metadata" ]]; then
    echo "error: bundle content not found at ${BUNDLE_DIR}"
    echo "run bundle generation first (for example: make -C operator bundle IMG=<image>)"
    exit 1
fi

rm -rf "${VERSION_DIR}"
mkdir -p "${VERSION_DIR}"

cp -R "${BUNDLE_DIR}/manifests" "${VERSION_DIR}/"
cp -R "${BUNDLE_DIR}/metadata" "${VERSION_DIR}/"

if [[ ! -f "${PACKAGE_ROOT}/ci.yaml" ]]; then
    cat > "${PACKAGE_ROOT}/ci.yaml" <<'EOF'
updateGraph: semver-mode
reviewers:
  - dlbewley
EOF
fi

echo "prepared community-operators layout:"
echo "  ${VERSION_DIR}"
echo "next: copy ${OUT_DIR}/${PACKAGE_NAME} into community-operators-prod/community-operators/operators/"
