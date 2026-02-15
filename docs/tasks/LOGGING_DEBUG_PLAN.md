# Plan: Logging and Debuggability Enhancements

## Intent
Improve day-2 debugging by making logs and events:
- configurable from `OvnRecon` for each major runtime component
- more structured and actionable
- less noisy while preserving failure signal
- reasonably stable for event-reason based automation

This document is the working plan. We will iterate here first, then create one Epic and scoped subtasks in beads.

## Scope
Components in scope:
- Operator controller (`ovn-recon-operator`)
- Plugin backend container (`ovn-recon`, nginx-based)
- Collector service (`ovn-collector`)
- Kubernetes Events emitted by the operator

## Current State (2026-02-14)
- Operator logs use controller-runtime zap defaults and CLI flags; no per-CR logging config.
- Operator emits Warning events for failures but few/no Normal events for successful transitions.
- Collector uses standard library `log.Printf`/`log.Fatalf`; no log level control.
- Plugin backend runs nginx with static config; no configurable access/error logging policy via CR.

## Proposed API (Draft)
Embed logging in each component section in `OvnRecon`:

```yaml
spec:
  operator:
    logging:
      level: info         # error|warn|info|debug|trace
      events:
        minType: Normal   # Normal|Warning
        dedupeWindow: 5m  # optional (default applied if omitted)
  consolePlugin:
    logging:
      level: info         # mapped to nginx error_log level
      accessLog:
        enabled: false
  collector:
    logging:
      level: info         # error|warn|info|debug|trace
      includeProbeOutput: false
```

Notes:
- Keep defaults conservative (`info`, access logs off, probe output off).
- Keep sensitive/large payload logging disabled by default.
- Backward compatibility: if component `logging` blocks are omitted, behavior matches today.
- Log level values should use a strict enum, documented in API reference.
- This aligns with the hierarchical API style (`spec.collector.*`, `spec.consolePlugin.*`).

## Design Decisions
### 1) Operator log-level control from CR
Recommended approach:
- Introduce an internal logging policy resolver in reconciler using `spec.operator.logging`.
- Use policy-gated `Info`/`Debug` logs in reconcile paths.
- Keep `Error` logs always on.

Why this approach:
- Avoids self-managing/restarting the operator Deployment.
- Works per reconcile loop and can be applied dynamically from CR state.
- Policy is global for now (derived from the primary `OvnRecon` instance).

### 2) Collector log-level control
Recommended approach:
- Move collector to structured logging (`log/slog` or equivalent lightweight wrapper).
- Add env-driven level at process start (e.g. `COLLECTOR_LOG_LEVEL`).
- Wire operator to set collector env from `spec.collector.logging.level`.
- Gate potentially sensitive probe command output behind `includeProbeOutput`.
- For now, when probe output logging is enabled, do not truncate output.

### 3) Console plugin (nginx) log-level control
Recommended approach:
- Add nginx config templating in container startup.
- Map `spec.consolePlugin.logging.level` to nginx `error_log` level.
- Map `accessLog.enabled` to `access_log` on/off.
- Wire operator to set env vars for nginx template rendering.

### 4) Kubernetes Events strategy
Recommended approach:
- Keep Warning events for failure paths.
- Warning events always emit (not suppressible by CR config).
- Add Normal events for important lifecycle transitions:
  - reconcile succeeded
  - collector enabled/disabled
  - console plugin enabled/disabled
  - finalizer cleanup complete
- Prevent event storms with dedupe/rate limiting:
  - emit only on condition transition or reason/message change
  - optional time-window suppression for repeated identical events
- Standardize `reason` catalog in one place and document it.
- Attempt event reason stability within a minor release line.
  - Additive new reasons are allowed.
  - Renaming/removing existing reasons requires release-note callout.

## Delivery Phases
### Phase 0: API and semantics
- Finalize component-embedded logging schema and defaults:
  - `spec.operator.logging`
  - `spec.consolePlugin.logging`
  - `spec.collector.logging`
- Define reason catalog and event emission rules.
- Define which reasons are considered stable and publish the catalog.
- Define redaction policy for logs/events.

### Phase 1: Operator policy + events foundation
- Implement operator logging policy resolver.
- Add structured log fields (component, ovnrecon name, namespace, reconcileID, phase).
- Implement event dedupe and transition-driven emission.
- Add Normal event coverage.

### Phase 2: Collector logging controls
- Add collector log level and structured logs.
- Wire operator env injection for collector logging.
- Add guarded probe-output logging behavior.

### Phase 3: Console plugin logging controls
- Add nginx template/runtime config for error/access logs.
- Wire operator env injection for console plugin logging.
- Validate no behavior regression for plugin serving and probes.

### Phase 4: Validation, docs, and supportability
- Unit/integration tests for logging config resolution.
- Tests for event emission behavior (including dedupe/transition semantics).
- Add a reason-catalog regression test (fails on unreviewed reason churn).
- Docs update:
  - API reference
  - troubleshooting guide with sample `oc logs`/`oc get events` workflows
  - event reason catalog + compatibility notes
  - examples for high-verbosity debug sessions and normal production settings

## Acceptance Criteria (Draft)
- `OvnRecon` supports component-embedded log-level control:
  - `spec.operator.logging.level`
  - `spec.consolePlugin.logging.level`
  - `spec.collector.logging.level`
- Operator emits meaningful Normal + Warning events with dedupe semantics.
- Documented event reason catalog exists, and we attempt stability within minor release lines.
- Default behavior remains production-safe and low-noise.
- Debug mode materially improves root-cause ability for collector probe and operator reconcile issues.
- Documentation includes clear examples and cautions for noisy/sensitive logging modes.

## Risks and Mitigations
- Risk: excessive event/log volume in large clusters.
  - Mitigation: default `info`, dedupe, transition-only events.
- Risk: sensitive command output in logs.
  - Mitigation: `spec.collector.logging.includeProbeOutput=false` default, explicit opt-in.
- Risk: nginx log config regressions.
  - Mitigation: startup validation + smoke tests on `/healthz` and `/readyz`.

## Open Questions
- Do we want hard long-term stability guarantees for event `reason` values across major API versions, or minor-line stability only?

## Guidance: Event Reason Stability Policy
Recommended default policy:
- Stability target: stable within each minor release line.
- Consumers may safely alert/automate on documented `reason` values in that line.
- Reason changes are allowed only with:
  - explicit changelog/release note entry
  - temporary compatibility period when feasible (emit old+new reason paths in adjacent releases if practical)

Why this is pragmatic:
- It enables automation and alerting to remain reliable.
- It avoids locking the project into permanent reasons too early while the operator is still evolving quickly.

## Initial Beads Backlog Mapping
Current logging/debuggability bead status:

| Work Item | Type | Issue ID | Status |
|---|---|---|---|
| Logging/debuggability epic | epic | `ovn-recon-35u` | `OPEN` |
| Add component-embedded logging API fields + CRD/docs defaults | task | `ovn-recon-35u.1` | `CLOSED` |
| Implement operator logging policy resolver + structured debug fields | task | `ovn-recon-35u.2` | `CLOSED` |
| Implement operator event dedupe and Normal event coverage | task | `ovn-recon-35u.3` | `CLOSED` |
| Implement collector log level and probe-output controls | task | `ovn-recon-35u.4` | `CLOSED` |
| Implement console plugin (nginx) logging controls | task | `ovn-recon-35u.5` | `CLOSED` |
| Add logging/event behavior tests including reason-catalog stability checks | task | `ovn-recon-35u.6` | `CLOSED` |
| Publish and maintain event reason catalog with compatibility notes | task | `ovn-recon-35u.7` | `IN_PROGRESS` |
| Update troubleshooting docs with logging debug playbooks | task | `ovn-recon-35u.8` | `OPEN` |
