# UI Enhanced Graph Node View

## Enhancements
- [x] Add a `NodeViewModel` abstraction so all node types share a consistent display shape.
- [x] Add a node-kind registry to centralize labels, details rendering, and customization hooks.
- [x] Add resource/YAML links for nodes with a `resourceRef`.
- [x] Add a tabbed popover (Summary / Details / Links / YAML) to present multiple views per node.
- [x] Add explicit NAD nodes with a CUDN association heuristic (name or NAD config name match).
- [x] Parse NAD config JSON for `type` and `name` and show in Details.
- [x] Render actual YAML content inline (fetch from API or reuse existing console YAML view).
- [ ] Add NAD grouping (derived vs manual) with toggles to reduce node clutter.
- [ ] Add a customizable registry file so teams can inject node renderers without editing the component.
- [ ] Add a relation inspector panel for upstream/downstream resources and graph traversal.
- [ ] Add namespace filtering for NADs (and attach filter state to URL).
- [x] Add a notion of gravity that can be used to sort graph nodes in a column.