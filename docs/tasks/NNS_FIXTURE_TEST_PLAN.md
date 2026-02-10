# NNS Fixture Test Plan

## Objective
Create stable, sanitized NodeNetworkState fixtures and fixture-backed tests so visualization parsing and drawer behavior can be validated in CI without requiring a live cluster.

## Why This Matters
- Reduces regressions in parsing (`mac-address` vs `mac_address`, route prefix handling, bridge/VRF relationships).
- Captures edge cases seen in real clusters.
- Makes refactors safer by asserting behavior from real NNS shapes.

## Scope
- Add fixture directory and contribution conventions.
- Add fixture-backed tests for selectors/model logic first.
- Add targeted rendering tests for drawer summary/details where practical.

## Proposed Repository Layout
- `test/fixtures/nns/` for machine-consumed fixtures used by tests.
- `docs/samples/` for human-readable examples and docs snippets only.

## Phases

### Phase 1: Fixture Conventions and Initial Corpus (PENDING)
- Create `test/fixtures/nns/README.md` with:
  - sanitization rules
  - naming conventions
  - minimum required fields
- Add initial fixtures covering:
  - basic host with ethernet + bridges
  - VRF with routes and associated `br-int` port
  - mixed key styles (`mac-address`, `mac_address`, `prefix_length`, `prefix-length`)
  - missing/partial fields to validate graceful fallback

### Phase 2: Selector/Model Tests (PENDING)
- Add tests for:
  - `getVrfConnectionInfo`
  - `getVrfRoutesForInterface`
  - route-to-VRF association behavior
  - bridge-port extraction behavior
- Use fixtures from `test/fixtures/nns/` rather than inline objects where possible.

### Phase 3: Drawer Rendering Contract Tests (PENDING)
- Add focused tests for Summary/Details outputs on key node kinds:
  - interface
  - bridge
  - vrf
  - cudn
- Validate presence/absence rules (e.g., only show fields when data exists).

### Phase 4: CI Harden and Maintenance Workflow (PENDING)
- Ensure tests run in existing CI path.
- Document how new bugs should add/extend fixture coverage.
- Add checklist item in contribution docs for fixture updates when parser logic changes.

## Acceptance Criteria
- `test/fixtures/nns/` exists with clear README guidance.
- At least 3 representative sanitized fixtures are committed.
- Fixture-backed selector/model tests cover current VRF/bridge parsing paths.
- CI runs fixture-backed tests successfully.
- Documentation explains when to add or update fixtures.

## Out of Scope
- End-to-end cluster tests.
- Broad snapshot testing of full visualization canvas.

## Suggested Follow-up Beads
- Fixture corpus creation
- Selector/model test migration
- Drawer contract tests

