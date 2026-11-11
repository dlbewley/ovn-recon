# OVN Recon: plugin review and roadmap (November 2026)

Status: proposal (2026-11-09). Reviewed against v1.0.6-a5 on a 10-node OpenShift 4.22
lab cluster, plus the code on `main` at `5b14640`.

## Summary

OVN Recon has gone deep. The collector now carries the policy and service planes, the
physical view understands bonds, VRFs, EVPN/VXLAN and SR-IOV, and every inferred
relationship says so. What it has not done yet is turn that depth into answers. The
next round of work should be about presentation and questions, not more tables:

1. **Make the drawers scannable.** Facts as one-line rows, real tables for routes and
   NAT, addresses resolved to the pod, VM or node that owns them. Today a gateway router
   shows 119 NAT rules as ten nearly identical lines and "… and 109 more"; 118 of them
   are one idea.
2. **Flag what is wrong.** The lab has Localnet networks wired on no node, BGP sessions
   that never came up behind an Accepted RouteAdvertisements, and a down VRF port. The
   app draws all of them without a mark. The diagnostics bead has waited since August
   for a rule list; this review proposes one.
3. **Answer "where is X?"** One search box for an IP, MAC, pod, VM or network, opening
   the right view with the object selected.
4. **Give networks their own page.** People create networks, not nodes. "Is vlan-333
   usable, and where?" should be one page, not ten node visits.
5. **Meet people where they already are.** Tabs on the console's Node, Pod, VM and
   network pages, and links out to Network Observability, nmstate and the networking
   plugin instead of raw YAML pages.

Visual polish (a calmer palette, a legend, one toolbar, honest loading states) and a
routing/BGP view round it out. The MCP server stays, but behind the UI work it shares a
backend with.

## Progress: 2026-11-11, v1.0.6-a6 to the v1.0.6 release

**v1.0.6 was released on 2026-11-11.** It carries every row below, plus three changes
made after b0: the physical view keeps its scale and pans only as far as it must beside
the drawer (`ovn-recon-dp7.10`, checked in a console on the release); a drawer hint no
longer names an issue ID, and a test keeps issue IDs out of user-facing text
(`ovn-recon-dp7.11`); and the guides, README and screenshots were brought up to date.

Twenty PRs merged in the two days after this review and shipped in v1.0.6-a6 through
b0. Every row below was checked in a signed-in console unless it says otherwise.

| Bead | What shipped | State |
|---|---|---|
| `ovn-recon-dp7.3` | Router NAT folded by intent with pod links, static routes as a sortable table with annotated next hops, and a shared `RuleTable` shell | Closed; confirmed in the console |
| `ovn-recon-dp7.5` | Ports table fits the drawer, expanded row leads with policy, raw row behind a toggle, drawer opens at half width | Closed; confirmed in the console |
| `ovn-recon-nt4.5` | Ladder edge labels wrap inside their band; names keep their role suffix | Closed; checked in the console |
| `ovn-recon-tpp.1` | Collector lookup endpoint for an IP, MAC, CIDR or name across every cached zone | Closed; checked by port-forward, through the plugin's nginx hop and from a console tab |
| `ovn-recon-0cl` | storedVersions migrator and its RBAC removed from the operator | Closed |
| `ovn-recon-dp7.2` | Kernel routes as tables in the VRF drawer, "Routes via this interface" on interface drawers, and a main routing table on the node page that marks which default route is in use | Closed; checked in the console (a7) |
| `ovn-recon-dp7.6` | Services tab: one row per Service, the node's own load balancers first, the cluster-wide ones collapsed, facets, and backends resolved to pods from EndpointSlices | Closed; checked in the console (a7) |
| `ovn-recon-s3t.16` | `select=` in the URL on all three graph pages, written with replace | Closed; checked in the console (a7) |
| `ovn-recon-nt4.6` | Ladder search matches the labels it shows; Enter selects the first match, with a count and next/previous | Closed; checked in the console (a7) |
| `ovn-recon-4b9` | NUL byte removed from `logicalLadderLayout.ts` | Closed |
| `ovn-recon-dp7.7` | Drawers render beside the graph, not over it; the selection stays visible after a deep link, a search or a click | Closed; checked in the console (a8) |
| `ovn-recon-tpp.2` | "Find in cluster" on the overview: exact hits first, covering routes folded, links that open the right view with the object selected | Closed; checked in the console (a8) |
| `ovn-recon-7i6.4` | Findings engine and eight physical rules, no UI yet | Closed; nothing to see until the surfaces land |
| `ovn-recon-e2b.8` | Construct detail page per switch and router: Overview, Relationships, paginated Ports with policy columns, a Policy tab (ACLs, port groups, address sets), Services, Routes and NAT, Config | Closed; checked in the console (a8, a9) |
| `ovn-recon-7i6.1` | Findings on the overview (card and node column), as badges on graph nodes, and at the top of the physical drawer with evidence and a remedy | Closed; checked in the console (a9) |
| `ovn-recon-nfs.1`, `ovn-recon-nfs.2` | Networks list and a page per CUDN, UDN and NAD, with "wired on N of M nodes" and a per-node placement table | Closed; checked in the console (a9) |
| `ovn-recon-tpp.8` | Search folds a Service VIP to one row with its zone count, and ranks exact names first | Closed; checked in the console (a9) |
| `ovn-recon-dp7.1` | Drawer layout kit on both drawers: identity header, one-line facts, popover explanations, an Identifiers section, bridge ports grouped by role | Closed; checked in the console (b0) |
| `ovn-recon-nt4.1`, `ovn-recon-nt4.2` | Neutral node cards with colour kept for state, a network palette without status hues, and a legend on all three graph pages | Closed; checked in the console (b0, light theme). The legend's wording still needs review |
| `ovn-recon-zdt.7`, `ovn-recon-zdt.1`, `ovn-recon-zdt.2` | An OVN Recon tab and an "Open in OVN Recon" action on Node, CUDN, UDN and NAD pages, behind two `OvnRecon` switches that default to off | Closed. With the switches unset the resource reported both off and the deployed manifest gated all eight extensions; with both on, the tab appears on all four kinds and the action in a Node's menu (b0) |

**What the review missed: the Services tab.** The review never opened it, and no bead
redesigned it; only its 200-row cap was due to be lifted on the construct detail page.
Measured on one node switch:

- 345 load balancers flatten to 541 VIP rows for 328 Services. The tab shows the first
  200, alphabetically.
- 319 of the 345 arrive through the cluster-wide group that every node switch and
  gateway router attaches. About 440 of the 541 rows are therefore the same on every
  construct; only about 100 say anything about the one selected.
- Two Services take 56 rows each. Nothing says whether a VIP is a ClusterIP, a NodePort
  or an external address. Backends are bare `ip:port` lines.

`ovn-recon-dp7.6` covered it and shipped in a7: 328 Service rows instead of 541 VIP
rows, the node's own 19 Services first, the 315 cluster-wide ones collapsed to a count,
type and "no endpoints" facets, and backends resolved to pods. Backends come from one
EndpointSlice read per expanded row, not the collector lookup, which would have cost a
request per address.

**A correction to this review.** It reported that opening the Ports tab scrolled the
whole page sideways. That was wrong. The reviewing tool scrolls an element into view
before clicking it, and PatternFly's overlay drawer lets such a scroll move the whole
page. With plain mouse clicks and keyboard traversal the page stays put, which is why
the fix's author could not reproduce it. The over-wide table, the raw JSON and the tab
overflow were real, and the fix stands. The underlying hazard is still worth closing,
because find-in-page, assistive technology, tests and any future scroll-to-row code can
trigger it (`ovn-recon-dp7.7`).

**Other things learned.**

- A lookup for one pod address returned 33 hits, 30 of them static routes that merely
  contain it. The search UI has to lead with exact hits (`ovn-recon-tpp.2`).
- Labels still overlap where several edges fan out inside one band of the cluster view
  (`ovn-recon-nt4.10`).
- Each lookup takes about 1.2 seconds through the console on ten nodes. That is fine
  for search on Enter, too slow for anything per-row (`ovn-recon-tpp.4`).
- **The drawer now hides what was just selected.** After a deep link or a search
  Enter on the ladder, the selected card sits entirely under the half-width drawer;
  on the physical page the right-hand lanes sit under it too. Search results and
  findings will send people straight into this, so `ovn-recon-dp7.7` is now P2:
  render the drawer inline and reveal within the canvas that is left.
- Smaller drawer polish from the a7 check is collected on `ovn-recon-dp7.9` and
  `ovn-recon-dp7.8`.
- Search needs two refinements seen on a8: one ClusterIP returned 40 rows (the same
  VIP once per load balancer per zone), and a name search ranked 30 substring matches
  above the ten interfaces with exactly that name (`ovn-recon-tpp.8`).
- One finding rule is undecided: the EVPN interfaces of a network are down on every
  node of the lab. Until it is known whether that is normal, the findings surfaces
  hide `interface-down` for them (`ovn-recon-7i6.2`).
- The network pages surfaced two more rule candidates, awaiting a decision: a network
  whose `NetworkCreated` condition is False, and a bridge NAD naming a bridge that
  exists on no node (`ovn-recon-7i6.2`).
- Adding tabs and actions to pages OVN Recon does not own changes the console's
  primary control surface. The rule for that epic is now: every such extension is
  switched from the `OvnRecon` resource and is off by default (`ovn-recon-zdt.7`).
- On the physical view, selecting a node shrinks the graph to about two thirds, a deep
  link parks it off-centre, and closing the drawer leaves it offset
  (`ovn-recon-dp7.10`). Fixed in v1.0.6.
- A second correction: the b0 check also reported that dragging on the ladder selects
  its text (`ovn-recon-nt4.11`). The maintainer could not reproduce it. It came from
  one automated drag that pressed and released without moving in between, which a
  mouse never does; closed as not a defect. Findings from browser automation that
  involve scrolling or dragging need a human check before they are filed.
- Small defects from the a9 check: the Policy tab's Match column is squeezed to about
  50 px (`ovn-recon-e2b.13`); the lookup reports only the first matching VIP of a load
  balancer row (`ovn-recon-tpp.9`); network page polish (`ovn-recon-nfs.7`).

## What to keep doing

- **The lane layout.** Physical-to-logical, left to right, is the product's signature.
- **Provenance.** "observed / declared / inferred" with the rule that produced a claim
  is rare and valuable. Keep every new feature honest the same way.
- **Education as a goal.** The concept text, the edge rationale and practice notes are
  what set this apart from a diagram. The new epics lean on them.
- **Verifying on a real console.** Several bugs this year only showed through the
  console path (query strings dropped, gzip preserved). The review below found three
  more the same way.

## What the live review found

| Area | Observation | Bead |
|---|---|---|
| Gateway router drawer | First screen is Role, Network, Node, OVN name, UUID. NAT shows 10 of 119 rows as `snat <node IP> ⇄ <pod IP>` plus "… and 109 more". Static routes wrap as free text. | `ovn-recon-dp7.1`, `ovn-recon-dp7.3` |
| VRF drawer | Kernel routes are bullets; `via 0.0.0.0` instead of "on-link"; the default route is not called out; interfaces are not links. | `ovn-recon-dp7.2` |
| All physical drawers | One-item lists render as bullets; explanations only in native `title` tooltips; links reload the whole console. | `ovn-recon-dp7.1`, `ovn-recon-s3t.18` |
| Ports tab | The table is far wider than the drawer and its columns are clipped. The expanded row leads with a 19-line raw JSON editor; the port groups and policies come after. Five tabs overflow the strip. *(Corrected 2026-11-10: the review first said the page itself scrolled sideways. That was caused by the reviewing tool, not the app; see Progress.)* | `ovn-recon-dp7.5`, `ovn-recon-dp7.7` |
| Physical graph | Every kind is a saturated fill, so color says nothing about state. No legend. | `ovn-recon-nt4.1`, `ovn-recon-nt4.2` |
| Ladder | Network bands use PatternFly's danger red and warning gold, so a healthy network reads as broken. Edge labels collide across bands. Names lose their distinguishing suffix. | `ovn-recon-nt4.1`, `ovn-recon-nt4.5` |
| Ladder search | "node switch" matches nothing on a page full of "Node switch" labels (it searches the raw role id). Matches below the fold stay there. | `ovn-recon-nt4.6` |
| Cluster view | Empty canvas and a disabled Refresh for 10 to 18 seconds before anything paints. | `ovn-recon-nt4.4` |
| Overview | During a collector restart the card printed four raw request paths with status codes, then "Freshness unknown" and nothing else. | `ovn-recon-nt4.4`, `ovn-recon-1zx` |
| Upgrade | Right after the plugin rolled to a new build, an open tab failed with "Failed to load module" until a full reload. | `ovn-recon-nt4.8` |
| Localnet networks | Three Localnet CUDNs name a physical network with no bridge mapping on any node, while `NetworkCreated=True`. The ladder draws a bridge mapping with no bridge and says nothing. | `ovn-recon-7i6.2`, `ovn-recon-nfs.2` |
| BGP | The RouteAdvertisements is Accepted, but all ten `BGPSessionState` objects show the peer in `Connect`. OVN Recon shows the advertisement and nothing about the sessions. | `ovn-recon-az0` |
| VRF port | A VLAN interface that is a port of a Primary network's VRF is down. Shown as a small red dot. | `ovn-recon-7i6.2` |

Verified on the same pass, and closed: the policy plane through the console
(`ovn-recon-e2b.5`: the node switch reads "1 direct · 157 via 68 port groups", and a
pod's expanded row links its NetworkPolicies) and the cache-across-upgrade fix
(`ovn-recon-ztu`: warm-up collected 10 of 10 nodes after a real image upgrade).

## Drawer layout principles

The drawer redesign epic (`ovn-recon-dp7`) applies one grammar to both views:

1. **Identity header.** Name, kind, state and context chips (node, network). UUIDs and
   raw OVN names fold into an Identifiers section with copy buttons.
2. **One line per fact.** Horizontal description lists (term left, value right). A
   single value is a value, not a one-item bullet list.
3. **Tables for anything with columns,** with a summary row first. "… and N more"
   becomes "Open all N" on the construct detail page (`ovn-recon-e2b.8`).
4. **Addresses resolve to owners** (pod, VM, node, Service, router port) wherever they
   appear (`ovn-recon-dp7.4`).
5. **Explanations are popovers** on an info icon, reachable by keyboard and touch.
6. **Raw rows go on Config** or behind "Show raw row".

What that means for the two examples you raised.

**A VRF's kernel routes**, today a bulleted list:

Today: `• 169.254.0.3/32 via 10.10.10.1 dev ovn-k8s-mp9`, `• 169.254.0.28/32 via 0.0.0.0
dev ovn-k8s-mp9`, `• 172.30.0.0/16 via 169.254.0.4 dev br-ex`. Proposed:

| Destination | Gateway | Interface | Metric |
|---|---|---|---|
| 169.254.0.3/32 | 10.10.10.1 *(network's router port)* | ovn-k8s-mp9 ↗ | 0 |
| 169.254.0.28/32 | on-link | ovn-k8s-mp9 ↗ | 0 |
| 172.30.0.0/16 *(service network)* | 169.254.0.4 *(OVN masquerade)* | br-ex ↗ | 0 |

Table 1009 in the header, longest prefix first, a default route pinned on top when there
is one, `0.0.0.0` read as on-link, interfaces as links that move the graph selection,
and addresses annotated with what owns them. The annotations are exactly the kind of
sentence that needs your wording review before it ships.

**A gateway router's NAT,** today ten of 119 lines:

| Type | External IP | Logical IPs | Rows |
|---|---|---|---|
| SNAT | 192.0.2.72 | 118 pod IPs in 10.131.0.0/23 (node switch) ▸ | 118 |
| SNAT | 192.0.2.72 | 100.64.0.5 (join) | 1 |

Expanding the first row lists the pods by name. `dnat_and_snat` and `dnat` rows are never
folded, because each one means something (EgressIP, a floating address).

## How OVN Recon fits with the neighbours

Researched 2026-11-09 against source (openshift/console release-4.22, the nmstate and
networking console plugins, netobserv console plugin and operator, cluster monitoring
operator). Details and URL formats are on the epics that use them.

**Network Observability** shows traffic: flows, drops, RTT, DNS, and (Technology
Preview in 4.22) network events naming the NetworkPolicy, ANP, BANP, EgressFirewall or
UDN isolation rule that acted on a flow. Its topology graphs traffic between networks,
hosts, namespaces and workloads. It draws no logical switches, routers, ports, ACLs or
load balancers. OVN Recon shows what is configured and where it lives. They meet at the
same objects, so the plan is to link them, not overlap them (`ovn-recon-vqd`):

- node, pod, CUDN/UDN, interface and Service VIP → NetObserv's own resource tabs
  (1.10+) or `/netflow-traffic` with `filters=`, shown only when the FlowCollector has
  the feature that would make the page non-empty;
- an ACL owned by a NetworkPolicy → `view=networkEvents` filtered to that policy, and a
  marker for whether the ACL is sampled at all (`sample_new`/`sample_est`).

**nmstate-console-plugin** has drawn a per-node interface topology at
`/node-network-configuration` since 4.19: interfaces, bonds, bridges, VLANs, state, and
which ones an NNCP configured. It draws no bridge mappings, UDNs, VRFs or anything on
the OVN side. OVN Recon's physical view should spend its effort on the seam (bridge
mappings, VRFs, attachments, EVPN, SR-IOV) and link to nmstate for plain interface
detail.

**networking-console-plugin** owns the CUDN and UDN lists and forms and the custom
NetworkPolicy and MultiNetworkPolicy pages; OVN Recon should link there instead of to
YAML. Its **release-5.1** branch adds "Physical networks" (`/physical-networks`,
aggregated by Localnet `physicalNetworkName` with uplink, MTU, enactment, VLAN and
consumers) and "Configuration Topology" (networks linked to pods, VMs and ingress). That
overlaps part of the proposed network pages for Localnet networks, on 5.1 and later
only. Since OVN Recon supports 4.22 onward, the recommendation is to build the network
pages anyway, emphasise what 5.1 does not show (OVN logical constructs per zone,
primary-network VRFs, policies, BGP, findings with provenance), and link to the 5.1
pages where they exist.

**The console itself** lets a plugin add tabs to resource pages
(`console.tab/horizontalNav` on Node, Pod, NAD, CUDN, UDN, NetworkPolicy and more) and
kebab actions (`console.action/resource-provider`). NetObserv already uses the former on
Node, CUDN and UDN. OVN Recon uses neither today; it is reachable from one menu entry
(`ovn-recon-zdt`).

**Metrics** are cheap to add but narrower than they look: OpenShift's node-exporter
excludes `br-ex`, `br-int`, bonds and OVN management ports by default, so only physical
NICs and VLANs have `node_network_*` series, and OVN-K/OVS metrics carry no node label
(join on pod).

**The gaps nobody fills**, and where OVN Recon is uniquely placed:

1. The OVN logical layer as a picture, per network and per zone.
2. The seam between NodeNetworkState and OVN, with provenance.
3. "Configured" versus "working": findings that cross both sides (a Localnet network
   with no mapping anywhere; a RouteAdvertisements with no established BGP session).
4. One pod or VM traced from its interface through OVN to the physical uplink
   (`ovn-recon-zdt.3`).
5. Teaching: concept text, edge rationale, practice notes.

## New and re-scoped epics

| Epic | Priority | What it is for |
|---|---|---|
| `ovn-recon-dp7` Drawer redesign | P1 | Scannable panels, real tables, resolved addresses |
| `ovn-recon-7i6` Insights | P1 | Warnings for what looks broken, info for what is dated, on every surface |
| `ovn-recon-nt4` Visual polish | P2 | Palette, legend, one toolbar, loading and error states, overview layout, rendering decision |
| `ovn-recon-tpp` Find anything | P2 | Cluster-wide lookup endpoint, search UI, deep-linkable selection, route matching |
| `ovn-recon-nfs` Network pages | P2 | One page per CUDN, UDN, NAD and the default network, with per-node placement |
| `ovn-recon-az0` Routing and BGP | P2 | FRR-K8s sessions, advertised and learned routes |
| `ovn-recon-zdt` Console integration | P2 | Tabs and kebab actions on console pages, the workload network path, links out to the owning plugin, VMs instead of launcher pods |
| `ovn-recon-vqd` Traffic and health | P3 | Network Observability links, ACL sampling marker, interface metrics, OVN/OVS health per node |
| `ovn-recon-s3t` (re-scoped) | P2 | Physical view modelling fidelity; the architecture rework it was opened for is done |
| `ovn-recon-e2b` (retitled) | P2 | NB coverage and the construct detail page; no longer research |
| `ovn-recon-khy` (lowered) | P3 | MCP server, re-sequenced behind the shared lookup and insights backends |

## Backlog review: what changed and why

| Bead | Action | Why |
|---|---|---|
| `ovn-recon-ztu` | Closed | Verified on a real upgrade: warm-up collected 10 of 10 nodes. |
| `ovn-recon-e2b.5` | Closed | PRs merged; console check done on v1.0.6-a5. Unblocks `e2b.8`. |
| `ovn-recon-x23` | Closed as superseded | Your 2026-08-27 note anticipated it. Item 1 (rename) moved to `s3t.27`; item 2 is `s3t.26`; item 3 became `s3t.33` plus the legend. |
| `ovn-recon-s3t.15` | Superseded by `ovn-recon-7i6.2` | Its candidate list is now the seed-rule table, with severities to confirm. |
| `ovn-recon-s3t.35` | Moved to Insights | Practice notes are that epic's info severity. |
| `ovn-recon-s3t.14`, `.18`, `.33` | Moved to the drawer epic | Drawer content and links. |
| `ovn-recon-s3t.16` | Moved to Find anything, broadened | Search and findings both need deep-linkable selection in all three views. |
| `ovn-recon-s3t.67` | Moved to Network pages, re-scoped | Policies as a section on the network page and NAD drawer, not graph nodes (221 on the lab). |
| `ovn-recon-s3t.21`, `.26` | Now depend on `ovn-recon-nt4.7` | Both need containers. The react-topology spike said ADOPT in August, but nothing was migrated. Decide first. |
| `ovn-recon-s3t.22` | Unblocked | The readme has been wrong for months while waiting on the VRF design. Rewrite it now, with fresh screenshots. |
| `ovn-recon-s3t.23` | In progress → open | A rolling fixture backlog by design; "in progress" made it look like active work. |
| `ovn-recon-s3t.56` | Note added | The lab now has a Primary UDN, so the missing capture is possible. |
| `ovn-recon-s3t.58` | Deferred | Needs an OpenShift 5.1 cluster. The code already prefers `status.vrfName`. |
| `ovn-recon-khy.9` | Deferred | Waits on an API that does not exist yet. |
| `ovn-recon-1zx` | Moved to Visual polish, P2 | The overview card and the cluster view's loading state both want it. |
| `ovn-recon-e2b.8` | Raised to P2 | It is where the drawers send "Open all N". |
| `ovn-recon-khy` and children | Lowered to P3 | `khy.4` now depends on the shared lookup endpoint (`tpp.1`). `khy.5` should report Insights rule IDs. |
| `ovn-recon-s3t` | Retitled, P2 | Phases 0 to 4 are done; the rest is modelling fidelity. |
| `ovn-recon-e2b` | Retitled | Implementation since `e2b.1`, not research. |

Left as they were: `ovn-recon-bz6` (Community Operators, paused at your request; with
1.0.5 GA out it may be time to revisit), `ovn-recon-0cl` (ready: the release carrying 5uj
has shipped), `ovn-recon-e2b.2`, `.7`, `.10`, `ovn-recon-s3t.19`, `.27`, `.55`,
`.59`, `.65`, and the two deferred beads `ovn-recon-s3t.31` and `ovn-recon-n4p`.

## Suggested order

Revised 2026-11-11 after the v1.0.6 release. Shipped in 1.0.6: the drawer tables, fixes
and layout kit (`dp7.1` to `dp7.3`, `dp7.5` to `dp7.7`, `dp7.10`), deep links and search
(`s3t.16`, `tpp.1`, `tpp.2`, `tpp.8`), the detail page (`e2b.8`), the findings engine
and surfaces (`7i6.4`, `7i6.1`), network pages (`nfs.1`, `nfs.2`), the palette and legend (`nt4.1`, `nt4.2`),
gated console tabs and actions (`zdt.7`, `zdt.1`, `zdt.2`), and the ladder fixes
(`nt4.5`, `nt4.6`, `4b9`).

**Carried over from 1.0.6** (small defects the release shipped with; take these
first): the Policy tab's squeezed Match column (`e2b.13`), network page polish (`nfs.7`),
the lookup that reports only a load balancer row's first VIP (`tpp.9`), interface links
in the main routing table (`dp7.8`), and the drawer polish that is left (`dp7.9`). The
upgrade from 1.0.5 on the stable channel was not exercised before the release; check it
on the first cluster that follows that channel.

**Next cycle:** the default network page (`nfs.3`) and the logical rules (`7i6.3`); the
workload network path and link-out registry (`zdt.3`, `zdt.4`); loading states and the
status endpoint (`nt4.4`, `1zx`); one toolbar (`nt4.3`); the rendering decision
(`nt4.7`).

**Later:** BGP (`az0`), Network Observability links and metrics (`vqd`), the overview
redesign once its parts exist (`nt4.9`), route matching (`tpp.3`), then MCP.

## Decisions for Dale

1. **Seed rules and severities** for Insights (`ovn-recon-7i6.2`, `ovn-recon-7i6.3`):
   *decided 2026-11-10.* Nine physical and five logical rules ship as warnings. Not
   findings: a Localnet mapping on only some nodes, a second default route, Service
   VIPs without endpoints, an unreferenced mapping, and the stale router-policy
   leftover. Info findings are shown by default and can be hidden.
2. **Rendering foundation** (`ovn-recon-nt4.7`): adopt react-topology as the spike
   recommended, or add containers to the custom renderer.
3. **Wording reviews** flagged on `dp7.2`, `dp7.3`, `nfs.3` and `az0.3`: masquerade
   address roles, static route evaluation order, the default network's internal subnets,
   and what each RouteAdvertisements type advertises.
4. **Where derived logic lives** for MCP (`ovn-recon-khy`): Insights rules over NNS will
   be TypeScript in the browser. An MCP lint either ports them to Go or covers only the
   collector-side rules.
5. **Community Operators** (`ovn-recon-bz6`): still paused?
6. **Overlap with OpenShift 5.1's networking plugin** (`ovn-recon-nfs`): build the
   network pages for 4.22 to 5.0 and link to "Physical networks" on 5.1+, as
   recommended above, or narrow them now.

## Initial Beads Backlog Mapping

New epics and children (all `OPEN` as of 2026-11-09). Beads re-parented from older
epics are marked *(moved)*. Rows marked *(done)* were updated on 2026-11-10; the
last seventeen rows were added on 2026-11-10 and 2026-11-11.

| Work Item | Type | Issue ID | Priority |
|---|---|---|---|
| **Drawer redesign** | epic | `ovn-recon-dp7` | P1 |
| Drawer layout kit: identity header, horizontal facts, popover hints, copyable identifiers | feature | `ovn-recon-dp7.1` | P1 |
| Kernel route tables as tables *(done)* | feature | `ovn-recon-dp7.2` | P1 |
| Logical routers: NAT grouped by intent, static routes as a table *(done)* | feature | `ovn-recon-dp7.3` | P1 |
| Address book: resolve IPs and MACs to owners | feature | `ovn-recon-dp7.4` | P2 |
| Ports tab overflow; expanded row leads with raw JSON *(done)* | bug | `ovn-recon-dp7.5` | P1 |
| Reachable networks for a selected interface *(moved)* | feature | `ovn-recon-s3t.14` | P2 |
| Consolidate links onto the SDK ResourceLink *(moved)* | task | `ovn-recon-s3t.18` | P3 |
| Concept explanations per node and edge kind *(moved)* | feature | `ovn-recon-s3t.33` | P3 |
| **Insights** | epic | `ovn-recon-7i6` | P1 |
| Findings surfaces: drawer, badges, node table, overview card | feature | `ovn-recon-7i6.1` | P1 |
| Confirmed rules, physical and Kubernetes side | feature | `ovn-recon-7i6.2` | P1 |
| Confirmed rules, logical side | feature | `ovn-recon-7i6.3` | P2 |
| Best practices and anti-patterns *(moved)* | feature | `ovn-recon-s3t.35` | P2 |
| **Visual polish** | epic | `ovn-recon-nt4` | P2 |
| Neutral node styling and a safe network palette | feature | `ovn-recon-nt4.1` | P2 |
| Legend | feature | `ovn-recon-nt4.2` | P2 |
| One view toolbar | feature | `ovn-recon-nt4.3` | P2 |
| Loading and error states | bug | `ovn-recon-nt4.4` | P2 |
| Ladder label collisions and name truncation *(done)* | bug | `ovn-recon-nt4.5` | P2 |
| Ladder search ignores displayed role labels *(done)* | bug | `ovn-recon-nt4.6` | P2 |
| Decide the rendering foundation | task | `ovn-recon-nt4.7` | P2 |
| "Failed to load module" after a plugin upgrade | bug | `ovn-recon-nt4.8` | P3 |
| Overview redesign | feature | `ovn-recon-nt4.9` | P2 |
| Collector status endpoint *(moved)* | feature | `ovn-recon-1zx` | P2 |
| **Find anything** | epic | `ovn-recon-tpp` | P2 |
| Collector: path-based lookup endpoint *(done)* | feature | `ovn-recon-tpp.1` | P2 |
| Search UI *(done)* | feature | `ovn-recon-tpp.2` | P2 |
| Which route carries this address? | feature | `ovn-recon-tpp.3` | P3 |
| Deep-linkable selection in all three views *(moved, broadened, done)* | feature | `ovn-recon-s3t.16` | P2 |
| **Network pages** | epic | `ovn-recon-nfs` | P2 |
| Network page shell and overview networks table | feature | `ovn-recon-nfs.1` | P2 |
| Per-node placement matrix | feature | `ovn-recon-nfs.2` | P2 |
| Default network page | feature | `ovn-recon-nfs.3` | P2 |
| NetworkPolicy and MultiNetworkPolicy on networks and NADs *(moved, re-scoped)* | feature | `ovn-recon-s3t.67` | P3 |
| **Console integration** | epic | `ovn-recon-zdt` | P2 |
| Tabs on Node, CUDN, UDN and NAD pages | feature | `ovn-recon-zdt.1` | P2 |
| Kebab actions: Open in OVN Recon | feature | `ovn-recon-zdt.2` | P2 |
| Workload network path tab on Pod and VirtualMachine | feature | `ovn-recon-zdt.3` | P2 |
| Link-out registry | feature | `ovn-recon-zdt.4` | P2 |
| Show the VM, not the launcher pod | feature | `ovn-recon-zdt.5` | P2 |
| More owner links and BareMetalHost NIC inventory | feature | `ovn-recon-zdt.6` | P3 |
| **Traffic and health** | epic | `ovn-recon-vqd` | P3 |
| Network Observability links | feature | `ovn-recon-vqd.1` | P2 |
| ACL sampled-for-observability marker | feature | `ovn-recon-vqd.2` | P3 |
| Interface metrics on NICs and VLANs | feature | `ovn-recon-vqd.3` | P3 |
| OVN and OVS health per node | feature | `ovn-recon-vqd.4` | P3 |
| **Routing and BGP** | epic | `ovn-recon-az0` | P2 |
| Research: FRR-K8s read model on 4.22 | task | `ovn-recon-az0.1` | P2 |
| BGP sessions in the physical view | feature | `ovn-recon-az0.2` | P2 |
| Route provenance and advertised prefixes | feature | `ovn-recon-az0.3` | P3 |
| Services tab: one row per Service, node-local first, facets, resolved backends *(done)* | feature | `ovn-recon-dp7.6` | P1 |
| Ladder: labels of a fan of edges overlap inside one band | bug | `ovn-recon-nt4.10` | P3 |
| `logicalLadderLayout.ts` contains a raw NUL byte *(done)* | task | `ovn-recon-4b9` | P3 |
| Overlay drawer hides the selected object and can shift the page *(done)* | bug | `ovn-recon-dp7.7` | P2 |
| Lookup: in-memory index of cached snapshots | task | `ovn-recon-tpp.4` | P3 |
| Link interface cells in the main routing table to the graph | feature | `ovn-recon-dp7.8` | P2 |
| Drawer polish left after v1.0.6 | task | `ovn-recon-dp7.9` | P3 |
| Findings engine: model, rule registry and evaluator, no UI *(done)* | feature | `ovn-recon-7i6.4` | P1 |
| Search results: one row per Service VIP, exact names first *(done)* | bug | `ovn-recon-tpp.8` | P2 |
| CR toggle for console integration: fields, feature flags, gating | feature | `ovn-recon-zdt.7` | P2 |
| Policy tab: Match column squeezed | bug | `ovn-recon-e2b.13` | P2 |
| Lookup returns only the first matching VIP of a load balancer row | bug | `ovn-recon-tpp.9` | P3 |
| Network pages polish found on v1.0.6-a9 | task | `ovn-recon-nfs.7` | P3 |
| Physical view: selection shrinks and displaces the graph *(done)* | bug | `ovn-recon-dp7.10` | P2 |
| Keep issue IDs out of user-facing text *(done)* | bug | `ovn-recon-dp7.11` | P2 |
| Ladder: dragging selects its text *(closed, not a defect)* | bug | `ovn-recon-nt4.11` | P3 |
| Stabilise and cut v1.0.6 from the b-series *(done)* | task | `ovn-recon-xa7` | P1 |
| Find in cluster: toolbar entry on the three graph pages | feature | `ovn-recon-tpp.5` | P2 |
