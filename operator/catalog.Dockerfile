# File-Based Catalog (FBC) image for the Bewley operator catalog.
#
# Replaces the deprecated sqlite index produced by `opm index add`.
# See docs/tasks/fbc-migration.md for the migration and the reasons.
#
# The base image must be a MULTI-ARCH manifest list (linux/amd64 + linux/arm64)
# or one platform silently gets the wrong rootfs. Pinned by digest so the
# runtime consumers execute is reproducible; the Makefile passes OPM_IMAGE and
# documents how to refresh it.
ARG OPM_IMAGE=quay.io/operator-framework/opm@sha256:e5a6220603fb4504d58c6e3e488386b817e3695c906a62ee0370b5faedc3799a
FROM ${OPM_IMAGE}

ENTRYPOINT ["/bin/opm"]
CMD ["serve", "/configs", "--cache-dir=/tmp/cache"]

ADD catalog /configs

# Pre-populate the serve cache at build time so the catalog pod starts fast and
# does not rebuild the cache on every restart. Without this the registry pod can
# take minutes to become ready on a large catalog.
RUN ["/bin/opm", "serve", "/configs", "--cache-dir=/tmp/cache", "--cache-only"]

LABEL operators.operatorframework.io.index.configs.v1=/configs
