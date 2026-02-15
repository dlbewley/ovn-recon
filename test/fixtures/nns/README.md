# NodeNetworkState Fixtures

These fixtures are sanitized snapshots used by unit tests in `src/components/*.test.ts`.

## Sanitization Rules

- Remove cluster-identifying values (real hostnames, domains, IPs tied to environments).
- Keep structural shape and key variations that parser logic depends on.
- Preserve edge-case key styles when relevant (for example `mac-address` and `mac_address`).
- Keep fixture scope minimal to the behavior under test.

## Naming Convention

- Use lowercase, kebab-case filenames.
- Name fixtures by scenario, not by environment.
- Examples: `basic-host.json`, `vrf-mixed-routes.json`, `partial-missing-fields.json`.

## Minimum Fields

Each fixture should include:

- `apiVersion`
- `kind`
- `metadata.name`
- `status.currentState.interfaces`

Optional sections such as routes and bridge mappings should be included only when needed by tests.

## Maintenance

- Add or update fixtures when parser/model behavior changes.
- Keep fixture diffs small and focused.
- Add or update tests in the same change that modifies fixture semantics.
