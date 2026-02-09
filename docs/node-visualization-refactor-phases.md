# Node Visualization Refactor Phases

This file tracks phased execution for the node visualization refactor and maps each phase to a beads issue.

## Status

| Phase | Scope | Beads Issue | Status |
|---|---|---|---|
| Phase 1 | Relationship selector extraction (no behavior change) | `ovn-recon-53e` | `CLOSED` |
| Phase 2 | Canonical topology model (single nodes/edges pipeline) | `ovn-recon-nyd` | `CLOSED` |
| Phase 3 | Type-driven drawer tabs | `ovn-recon-5c5` | `IN_PROGRESS` |
| Phase 4 | Layout extraction and tests | `ovn-recon-6se` | `OPEN` |

## Test Checkpoint Process

After each completed phase:
1. Build locally (`npm run build:dev`) to validate TypeScript/webpack.
2. Hand off for cluster verification using:

```bash
source setup_env.sh && \
   make build push && \
   oc rollout restart deployment/$APP_NAME -n "$APP_NAMESPACE" && \
   oc wait --for=condition=ready pod -l "$APP_SELECTOR" -n "$APP_NAMESPACE" --timeout=60s
```

3. Wait for your test feedback before advancing to the next phase.
