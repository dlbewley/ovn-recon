# OVN Recon: explorer shell (build plan)

Status: in progress. Proposed 2026-11-12, when Dale chose this direction (option C of
`ovn-recon-nt4.12`). The routing spike passed on a live console the same day (see Spike
result); nothing else is built. Epic: `ovn-recon-gbr`. Written against `main` at
`f4ec408` (v1.0.7-a2), PatternFly 6.6.1, console SDK 4.22.0.

## Summary

Replace the overview page and the separate node, network and logical pages with one
page: a tree of what exists on the left, and the views of whatever is selected on the
right. The tree resizes and collapses so it never competes with the detail drawer for
width. Search and the collector status move into the title row and are there on every
view. Every existing URL keeps working.

## What is wrong today

Measured on a 4.22 console at 1440 x 900, on the overview shipped by `ovn-recon-nt4.9`:

- The "Find in cluster" card is about 150 px tall.
- The Findings tile reads "No findings." and shares a row about 560 px tall with the
  networks table.
- The Nodes table starts below the fold.
- Each graph page spends a breadcrumb, a page title, a cross-link, a card title and up
  to three toolbar rows before the canvas.

## The design

```
+--------------------------------------------------------------------------+
| OVN Recon   (collector status)                     [ find in cluster   ] |
+----------------+--+------------------------------------------------------+
| [filter tree ] |<>| header: Cluster, a node (switcher) or a network      |
| findings only  |  | tabs for the selected scope                          |
| Cluster        |  +------------------------------------------+-----------+
| v Nodes     10 |  |                                          |  detail   |
|     worker-1   |  |   table, graph or network page           |  drawer   |
|     worker-3 ! |  |                                          | (graphs)  |
| > Networks  12 |  |                                          |           |
+----------------+--+------------------------------------------+-----------+
```

**Scopes and their tabs.** The tree holds only objects. The tabs are the views of the
selected object.

| Scope | Tabs |
|---|---|
| Cluster (the landing selection) | Nodes, Networks, Findings, Logical topology; Search results while a search is active |
| A node | Physical topology, Logical topology (collector-gated), Routes, Findings |
| A network | The network page: summary, findings, placement by node |

**The tree.**

- Three roots: Cluster, Nodes, Networks. Nodes show their role; networks show their kind.
- A name filter above it narrows the tree only. It is not the cluster search.
- A warning badge marks each node or network with findings, and a collapsed group that
  contains one.
- Two switches narrow it: "With findings only", and "With search matches only" while a
  search is active.
- The divider drags and takes arrow keys. A round button on it collapses the tree to a
  narrow rail with an expand button.
- With the tree collapsed, the node name in the pane header is a switcher, so changing
  node does not need the tree back.

**Search.** One compact box in the title row finds an IP, CIDR, MAC or name anywhere in
the cluster. Results open as a temporary "Search results" tab on Cluster, at their own
URL, and the tree marks the nodes that hold matches. A single box at the top of the tree
doing both jobs was rejected: collapsing the tree would hide search.

**Findings.** They replace the tile in four places: badges in the tree, a Findings tab
whose scope follows the selection, the badge on the graph node, and the evidence and
remedy at the top of the drawer. The last two exist already (`ovn-recon-7i6.1`). With no
findings the tab reads 0 and the tree shows no badges.

## URLs

No existing URL changes or redirects. Four are new.

| URL | Scope | Tab | |
|---|---|---|---|
| `/ovn-recon`, `/ovn-recon/node-network-state` | Cluster | Nodes | unchanged |
| `/ovn-recon/networks` | Cluster | Networks | unchanged |
| `/ovn-recon/findings` | Cluster | Findings | new |
| `/ovn-recon/ovn` | Cluster | Logical topology | unchanged |
| `/ovn-recon/search?q=` | Cluster | Search results | new; `/ovn-recon?q=` still resolves here |
| `/ovn-recon/node-network-state/:name` | Node | Physical topology | unchanged |
| `/ovn-recon/ovn/:name` | Node | Logical topology | unchanged |
| `/ovn-recon/node-network-state/:name/routes` | Node | Routes | new |
| `/ovn-recon/node-network-state/:name/findings` | Node | Findings | new |
| `/ovn-recon/ovn/:node/:kind/:name` | Node | the construct page, in the pane | unchanged |
| `/ovn-recon/networks/{cudn,udn,nad}/...` | Network | the network page | unchanged |

`?select=`, `?tab=`, `?q=` and `?port=` keep their meaning.

## How it is built

**One route.** The ten `console.page/route` entries become one: `/ovn-recon`,
`exact: false`, module `OvnReconApp`. The console turns a non-exact plugin route into
`<Route path="/ovn-recon/*">` and caches the lazy component by extension uid
(`openshift/console` release-4.22,
`frontend/packages/console-app/src/hooks/usePluginRoutes.tsx`). So the shell stays
mounted while the path changes beneath it. Today every hop between pages unmounts one
module and mounts another. The monitoring plugin uses the same arrangement at
`/monitoring`. The spike (`ovn-recon-gbr.1`) confirmed it for this plugin on a live
console, with two limits: the shell mounts twice on a fresh page load, and it remounts
after the user leaves OVN Recon for another console page and comes back.

**Pieces.**

| Piece | What it is |
|---|---|
| `routes.ts` | Every path builder, and a pure function from a location to scope, tab and params. Paths are built in at least nine places today. |
| `OvnReconApp.tsx` | The shell: title row, tree drawer, scope header, tabs, nested routes. |
| `explorerTreeModel.ts` | Pure: tree items, badges, name filter, the two switches. |
| `ExplorerTree.tsx` | PatternFly `TreeView` (`hasBadges`, `hasSelectableNodes`, `activeItems`, compact). |
| Tree drawer | PatternFly `Drawer isInline position="start"` with a `DrawerPanelContent isResizable` (`defaultSize`, `minSize`, `maxSize`, `onResize`). The graph pages already use the same component for the detail drawer at the other edge. |
| Bodies | The existing pages with their title, breadcrumb, cross-links and host select lifted off. `NodeNetworkStateBody` and `NetworkBody` already exist; the logical, construct and overview components need the same split. |

**State.**

- The URL holds the selection, the tab, the graph selection and the search text.
- Console user settings (`useUserSettings` from the SDK) hold the tree's width and
  whether it is collapsed.
- Which tree groups are open is kept in sessionStorage for the browser tab
  (`ovn-recon-gbr.9`): it survives a fresh page load and a trip to another console page
  and back, but a new tab starts with Nodes open. It is a detail of where the user is,
  not a preference, and user settings would cost a ConfigMap write per click.

**Data.** The shell makes the cluster-wide watches the overview makes today and
evaluates findings once, so the tree, the tab and the tables cannot disagree. The search
lookup moves to a shell-level hook so the tree can mark matches.

**Loading.** Heavy views (the physical graph, the ladder, the construct page) load
lazily, so the landing view does not pull in graph code. In the spike each page stayed
its own chunk and the shell's chunk was about 12 KB minified. Because the console
replaces its whole frame once on a fresh page load, the shell must not hang one-shot
work on mount.

**Not found.** The shell carries a catch-all route. Without one, a path that no nested
route matches renders a blank pane. A well-formed path that names a missing node or
network is a separate problem the released pages already have (`ovn-recon-nt4.13`).

**What does not change.** The console-integration tabs and actions and their flags, the
link-out registry, the collector API, the `?select=` deep links, and the detail drawers.

## Spike result (2026-11-12)

`ovn-recon-gbr.1`: a throwaway shell with one non-exact route and nested routes for the
existing pages, run on a live 4.22 console. The result is a go. The spike code was not
merged.

| Check | Result |
|---|---|
| Existing URLs resolve through the nested routes, including a pasted `?select=` link | Pass |
| The shell stays mounted while the path changes | Pass over nine in-app hops, Back and Forward. It mounts twice on a fresh page load, as every plugin page does today, and remounts after leaving OVN Recon and returning. |
| The Networking > OVN Recon item stays highlighted | Pass on every sub-path |
| Back and Forward | Pass |
| Console-integration tabs and "Open in OVN Recon" actions | Pass for the Node and CUDN tabs and the Node action. The UDN, NAD and CUDN actions were not clicked one by one. |
| An unknown sub-path | Pass with a catch-all route. A path naming a missing node or network stays on "Loading...", in the released pages too (`ovn-recon-nt4.13`). |

## Order of work

Each step leaves `main` releasable. Until a path is moved into the shell it renders its
existing page unchanged (a legacy passthrough), so the shell can ship one scope at a
time. The shell imports those pages itself, lazily. They cannot stay in
`exposedModules`: the SDK's webpack plugin fails the build on an exposed module that no
extension references, so they leave that list in the same change that swaps the routes.

1. **Prove the route** (`ovn-recon-gbr.1`, done 2026-11-12: go). A throwaway shell on a
   live console.
2. **Prepare, with no visible change** (`ovn-recon-gbr.2`, `ovn-recon-gbr.3`). One
   routes module; bodies split from page chrome.
3. **Shell and Cluster scope** (`ovn-recon-gbr.4`). The first visible change: the Nodes
   table is the landing view and sits above the fold.
4. **Fill in the scopes, in any order** (`ovn-recon-gbr.5` node, `ovn-recon-gbr.6`
   network, `ovn-recon-gbr.7` findings, `ovn-recon-gbr.8` search).
5. **Finish** (`ovn-recon-gbr.9` remembered tree state, keyboard and narrow widths;
   `ovn-recon-gbr.10` docs, screenshots, removal of the passthrough).

## Risks

| Risk | How it is retired |
|---|---|
| Nested routing under one non-exact route does not behave as the source suggests. | Retired: the spike passed all six checks, so the fallback was not needed. |
| Tree state is lost on a fresh page load and after leaving OVN Recon and returning. | Width and collapse are stored per user; open groups per browser tab (`ovn-recon-gbr.9`). |
| Tree, graph and drawer do not fit side by side. | The tree collapses to a rail; both panels have minimum sizes; below a set width the tree starts collapsed. Checked at 1280 and 1440 px. |
| One route means one module, so the first load grows. | Mostly retired: with lazy imports each page stayed its own chunk in the spike. Measure again once the tree and the shell-level watches move in. |
| A test image for the plugin alone takes the collector down: the collector inherits the plugin's image tag when its own is unset (`collectorImageTagFor` in the operator). | When trying a plugin-only image, set `spec.collector.image.tag` as well as `spec.consolePlugin.image.tag`. |
| More lazy chunks make "Failed to load module" after an upgrade more likely. | Already tracked as `ovn-recon-nt4.8`; fix or mitigate before the shell ships in a stable release. |
| About thirty suites render pages under a router and assert on titles and breadcrumbs. | The split in `ovn-recon-gbr.3` moves chrome into thin wrappers first, so those suites change imports, not assertions. |
| Two toolbars and two host selects are being reworked at once. | The node scope only removes what the tree replaces; the shared toolbar stays with `ovn-recon-nt4.3`. |

## Decisions for Dale

1. **Land on Cluster, or on the last node viewed?** Recommended: Cluster. It puts the
   Nodes table first and needs no stored state.
2. **Networks in the tree: flat, or grouped by kind?** Recommended: flat, findings
   first, capped with "Show N more", as the overview sorts them today.
3. **The construct page: in the pane, or full width outside the shell?** Recommended: in
   the pane. Collapsing the tree gives it the width.
4. **Tree width and collapse: console user settings, or localStorage?** Recommended:
   user settings, which follow the user across browsers. The hide-info preference uses
   localStorage today and can stay.
5. **A node Findings tab, or findings only in the drawer and on the cluster tab?**
   Recommended: the tab, so the scope rule is the same at every level.
6. **Ship behind a toggle?** Recommended: no. The prerelease line is the trial period,
   and a toggle would mean keeping two sets of routes.

## Out of scope

- The rendering foundation decision (`ovn-recon-nt4.7`).
- The shared view toolbar (`ovn-recon-nt4.3`), beyond removing the host selects.
- Logical findings (`ovn-recon-7i6.3`) on the cluster Findings tab. They are evaluated
  per logical view today.
- The collector status endpoint (`ovn-recon-1zx`); the title row shows what the
  aggregate response already gives.

## Initial Beads Backlog Mapping

As of 2026-11-12 the spike is closed and the rest are open. `ovn-recon-nt4.12` (the
decision between three options) is superseded by the epic.

| Work Item | Type | Issue ID | Priority |
|---|---|---|---|
| **Explorer shell** | epic | `ovn-recon-gbr` | P2 |
| Spike: one non-exact route with nested routing, checked on a live console *(done)* | task | `ovn-recon-gbr.1` | P2 |
| `routes.ts`: one module for every path and the URL-to-view table | task | `ovn-recon-gbr.2` | P2 |
| Lift page chrome off the logical, construct, overview and search components | task | `ovn-recon-gbr.3` | P2 |
| Shell: single route, title row, resizable and collapsible tree, Cluster scope | feature | `ovn-recon-gbr.4` | P2 |
| Node scope: Physical, Logical and Routes tabs, node switcher, construct page in the pane | feature | `ovn-recon-gbr.5` | P2 |
| Network scope: networks in the tree, the network page in the pane | feature | `ovn-recon-gbr.6` | P2 |
| Findings: tree badges, a findings-only switch, a Findings tab scoped by selection | feature | `ovn-recon-gbr.7` | P2 |
| Search: results tab on its own route, matches marked in the tree | feature | `ovn-recon-gbr.8` | P2 |
| Tree state and small screens: remembered width and collapse, keyboard pass | task | `ovn-recon-gbr.9` | P3 |
| Docs and cleanup: route tables, screenshots, removed modules | task | `ovn-recon-gbr.10` | P2 |

Dependencies: `.4` needs `.1`, `.2` and `.3`; `.5` to `.9` need `.4`; `.10` needs `.5`
to `.8`.

Related beads that this work touches:

| Work Item | Issue ID | Effect |
|---|---|---|
| Find in cluster entry on the graph views | `ovn-recon-tpp.5` | Met by `ovn-recon-gbr.8`; close when it ships |
| One view toolbar across the graph pages | `ovn-recon-nt4.3` | Re-scope after `ovn-recon-gbr.5` removes the host selects |
| "Failed to load module" after a plugin upgrade | `ovn-recon-nt4.8` | Matters more once views load lazily |
| Loading and error states | `ovn-recon-nt4.4` | The title-row collector status inherits them |
| Missing node or network shows "Loading..." forever | `ovn-recon-nt4.13` | Found by the spike; the shell inherits it until it is fixed |
| Drawer: one label for the full-page links | `ovn-recon-dp7.12` | Independent; merged in #189 |
