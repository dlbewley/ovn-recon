# Plan: OVN Recon MCP Server

Status: proposal (2026-11-04). Epic: `ovn-recon-khy`.

## Intent

Add a read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
server to OVN Recon so that AI agents on the cluster — OpenShift Lightspeed,
agents built on OpenShift AI, or a desktop client such as Claude Code — can ask
topology questions that today can only be answered by a person looking at the
plugin's diagrams.

The server lives in the existing collector, is gated by a new `spec.mcp` field
on the `OvnRecon` CR, and registers itself with the Red Hat Connectivity Link
MCP gateway when that gateway is installed. The registration layer is isolated
behind a small interface so the planned move of the gateway data plane from
Envoy to Praxis does not reach into the server itself.

This document doubles as a primer: each section explains the MCP or gateway
concept it depends on before applying it, and the reference list at the end is
grouped by topic for further reading.

## Why this is worth doing

Generic Kubernetes MCP servers already exist. OpenShift 5.0 ships one, the
[MCP server for Red Hat OpenShift](https://docs.redhat.com/en/documentation/openshift_container_platform/5.0/html/ai_applications/mcp-server),
which can list and describe any resource the caller may read. OVN Recon should
not duplicate that. Its value is in two things no generic server can do:

1. **OVN northbound state.** The collector execs into `ovnkube` pods and returns
   logical switches, routers, ports, NATs, static routes and bridge mappings per
   node zone (`collector/internal/snapshot/types.go`). No Kubernetes API exposes
   this.
2. **Derived relationships.** The plugin's selectors
   (`src/components/nodeVisualizationSelectors.ts`) work out which interface and
   bridge carry a CUDN on a node, which VRF holds a route, which
   RouteAdvertisements select a network, and which LLDP neighbor sits behind an
   interface. Today that knowledge exists only as pixels in a browser.

An agent holding both can answer "why can't pod A reach pod B" or "which node is
missing the localnet mapping for CUDN X" in one or two tool calls. That is the
product.

## Context: what shipped in late 2026

| Product | Feature | Status |
|---|---|---|
| Red Hat Connectivity Link 1.5 | MCP gateway (Kuadrant) | GA, October 2026 |
| OpenShift AI 3.5 | MCP catalog in AI Hub, MCP Lifecycle Operator, `MCPServer` CR | Technology Preview |
| OpenShift 4.22 / 5.0 | MCP server for Red Hat OpenShift, deployed behind the gateway | Technology Preview |
| OpenShift Lightspeed 1.0 | `OLSConfig.spec.mcpServers` with an `MCPServer` feature gate | GA feature-gated |

Sources: [MCP gateway GA announcement](https://www.redhat.com/en/blog/model-context-protocol-gateway-red-hat-openshift-now-generally-available),
[OpenShift AI 3.5: Working with the MCP catalog](https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/3.5/html/working_with_the_mcp_catalog),
[OpenShift 5.0: MCP server](https://docs.redhat.com/en/documentation/openshift_container_platform/5.0/html/ai_applications/mcp-server),
[Lightspeed 1.0: Configuring](https://docs.redhat.com/en/documentation/red_hat_openshift_lightspeed/1.0/html/configure/ols-configuring-openshift-lightspeed).

The catalog and lifecycle operator handle deploy-time concerns (Deployment,
Service, NetworkPolicy) for servers that do not have their own operator. OVN
Recon already has one, so we do not need the lifecycle operator; what we want is
the gateway, which handles everything at request time.

## MCP primer

### Three primitives

A server exposes three kinds of things. The distinction matters because
clients treat them differently.

- **Tools** are functions the model calls. They have a JSON schema for input and
  output, a description, and annotations. The model decides when to call them.
- **Resources** are documents the client (or the user) attaches to the
  conversation by URI. The model does not fetch them on its own; the host
  application does. Good for schemas, reference docs, and large payloads the
  user may want to pin.
- **Prompts** are reusable templates the user picks from a menu. They are a way
  to ship a troubleshooting playbook with the server.

### Transport and the 2026-07-28 revision

Servers speak JSON-RPC over one of two transports: stdio (local subprocess) or
Streamable HTTP (one endpoint that accepts POST). We use Streamable HTTP.

The [2026-07-28 specification](https://modelcontextprotocol.io/specification/2026-07-28/basic)
made the protocol sessionless: there is no `initialize` handshake, no
`Mcp-Session-Id`, and every request carries its protocol version and client
capabilities in `_meta`. Earlier revisions (2025-11-25 and before) are stateful.
The Connectivity Link gateway auto-negotiates among four versions on `/mcp` and
pins the stateful protocol on `/mcp/stateful`.

Design rule: **the server is stateless.** Each request is self-contained and
any cross-call identity (a snapshot id, a page cursor) is an explicit argument.
This is what the spec recommends, it is what the Go SDK's
`StreamableHTTPOptions.Stateless` implements, and it is the only mode the
Praxis MCP filter supports today (see below).

### Authorization model

The [authorization spec](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)
casts an HTTP MCP server as an OAuth 2.1 *resource server*. Its obligations:

- Publish [RFC 9728](https://www.rfc-editor.org/rfc/rfc9728) Protected Resource
  Metadata at `/.well-known/oauth-protected-resource`, naming the authorization
  servers and supported scopes.
- Answer missing or invalid tokens with 401 and a `WWW-Authenticate: Bearer
  resource_metadata=...` challenge; answer scope failures with 403.
- Validate that a token was issued *for this server* (audience, RFC 8707).
- **Never pass a caller's token upstream.** The
  [security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
  name token passthrough as the first thing not to do.

Behind the gateway, the gateway is the resource server and does all of this.
The backend only needs to trust the gateway. Without a gateway, the server
must do it itself. Both modes are planned; gateway-trusted is the default.

## Proposed tool surface

Anthropic's guidance ([Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents),
[Building agents that reach production systems with MCP](https://claude.com/resources/articles/building-agents-that-reach-production-systems-with-mcp))
is consistent on a few points, and the surface below follows them:

- Consolidate around **intent**, not endpoints. "Fewer, well-described tools
  consistently outperform exhaustive API mirrors."
- Return **high-signal fields**, and offer a `response_format` argument
  (`concise` | `detailed`). Anthropic's example cut 206 tokens to 72.
- **Cap output** with sensible defaults and tell the agent how to get more.
  Claude Code truncates tool results at 25,000 tokens.
- Make **errors actionable**: say what to try next, not what failed internally.
- Use **annotations** (`readOnlyHint`, `openWorldHint`) so clients can skip
  confirmation prompts for safe tools.
- Write descriptions "like a brief for a new hire" and let evals, not
  intuition, settle naming questions.

Tool names are bare (no product prefix). The gateway prepends the prefix from
the registration and strips it on `tools/call`, and desktop clients namespace
by server name. The documented prefix for registration is `ovnrecon_`.

| Tool | Input | Returns | Phase |
|---|---|---|---|
| `list_nodes` | `response_format` | Nodes with collector health, zone status, counts of switches/routers/ports, console deep link per node | A |
| `get_logical_summary` | `node`, `response_format` | Routers, switches, port counts, NAT and static route counts for one zone, grouped per network | A |
| `get_node_summary` | `node`, `response_format` | Physical view: interfaces, bridges, VRFs, bridge mappings, CUDN/NAD placement, LLDP neighbors | C |
| `get_network` | `name` (CUDN/UDN/NAD) | Nodes carrying it, interface and bridge per node, namespaces, NADs, RouteAdvertisements | C |
| `lookup_address` | `ip` or `mac` or `pod` (`namespace/name`) | Logical switch port, switch, router, NAT rows, static routes that match, console deep link | C |
| `check_consistency` | none | Per-node diff of bridge mappings and per-network switch presence; outliers named | C |
| `trace_path` | `source`, `destination` (ip or pod) | Ordered hops through the logical graph and the first point where the walk fails | D |
| `lint` | optional `node` | Findings: collector warnings (`FALLBACK`, `ZONE_COLLECTION_FAILED`), CUDN without NAD, missing bridge mapping, RouteAdvertisements with no FRR state | D |

All tools set `ReadOnlyHint: true` and `OpenWorldHint: false`. Every result that
names a node or network carries the matching console URL so the agent can hand
the person a link to the diagram.

### Resources

| URI | Content |
|---|---|
| `ovnrecon://schema/logical-topology-snapshot` | `collector/api/logical-topology-snapshot.schema.json` |
| `ovnrecon://nodes/{name}/snapshot` | The raw per-node snapshot (large; a resource, not a tool, on purpose) |
| `ovnrecon://docs/event-reasons` | `docs/EVENT_REASON_CATALOG.md`, so an agent can explain operator events |

### Prompts

- `diagnose_connectivity` — arguments `source`, `destination`; a playbook that
  calls `lookup_address` on both, then `trace_path`, then `lint`.
- `explain_node` — argument `node`; narrates `get_node_summary` and
  `get_logical_summary` for someone new to OVN-Kubernetes.
- `audit_network` — argument `name`; `get_network` plus `check_consistency`
  scoped to that network.

## Architecture

```
                         ┌──────────────────────────────────────┐
  Lightspeed / OpenShift │   MCP gateway (Connectivity Link)    │
  AI agents / Claude ───▶│   authn (OIDC JWT)  authz (per tool) │
                         │   federation  audit  guardrails      │
                         └──────────────┬───────────────────────┘
                                        │ HTTP /mcp (cluster network, NetworkPolicy)
                         ┌──────────────▼───────────────────────┐
  Console plugin ───────▶│  collector (Go)                      │
  via console proxy      │  /api/v1/snapshots   existing        │
                         │  /mcp                new: go-sdk     │
                         │  /.well-known/oauth-protected-resource (direct mode only)
                         │                                      │
                         │  snapshot store  ◀─ probe (pod exec) │
                         │  derived model   ◀─ informers (NNS, CUDN, UDN, NAD, RA)
                         └──────────────────────────────────────┘
```

### Where it runs

In the collector binary, as a second handler on the same server. Reasons:

- The collector already has the RBAC, the pod-exec plumbing, the snapshot
  cache, and the aggregate endpoint.
- The operator already manages its Deployment, Service and image.
- No fourth sub-project to build, scan and release.

The MCP handler is mounted at `/mcp`. The existing REST paths are unchanged.

### Library

[`github.com/modelcontextprotocol/go-sdk`](https://github.com/modelcontextprotocol/go-sdk)
v1.8.0 (verified 2026-11-04), the official SDK maintained with Google. Relevant
API, confirmed with `go doc`:

```go
// Tool handler: typed input and output, schema generated from struct tags.
func lookupAddress(ctx context.Context, req *mcp.CallToolRequest, in LookupInput) (*mcp.CallToolResult, LookupOutput, error)

mcp.AddTool(server, &mcp.Tool{
    Name:        "lookup_address",
    Description: "...",
    Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: ptr(false)},
}, lookupAddress)

// Stateless Streamable HTTP, per SEP-2567.
handler := mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return server },
    &mcp.StreamableHTTPOptions{Stateless: true})
mux.Handle("/mcp", handler)

// Direct mode only.
auth.RequireBearerToken(verifier, &auth.RequireBearerTokenOptions{...})
auth.ProtectedResourceMetadataHandler(&oauthex.ProtectedResourceMetadata{...})
```

The collector's `go.mod` is at Go 1.23; the SDK's minimum should be checked
when the dependency is added.

### Derived model in Go

The physical-topology tools need the relationships the plugin computes in
TypeScript. Plan: port the pure functions in `nodeVisualizationSelectors.ts`
to a Go package in the collector, driven by the same fixture files and
asserting the same outputs as the Jest suite. The collector then watches
`NodeNetworkState`, `ClusterUserDefinedNetwork`, `UserDefinedNetwork`,
`NetworkAttachmentDefinition` and `RouteAdvertisements` with informers, which
also lets it serve those relationships to the plugin later if we ever want to
move that work server-side.

### Operator wiring

- `spec.mcp.enabled` (default `false` until the feature is out of preview) and
  `spec.mcp.gateway` with `mode: auto | kuadrant | praxis | none` and a
  `prefix` (default `ovnrecon_`).
- A `NetworkPolicy` on the collector allowing ingress only from the console
  namespace and from the gateway's broker and router pods. The operator creates
  none today, which means the collector is reachable from any pod on the
  cluster network. This gap exists regardless of MCP and should be closed in
  the same change.
- When `mode` resolves to a gateway, the operator creates the registration
  objects (next section) with unstructured clients, so the gateway CRDs are an
  optional runtime dependency rather than a compile-time one.
- `status.mcp` reports the resolved mode, the registration object names, and
  the gateway endpoint if discoverable.

## Gateway landscape and the Praxis transition

### Today: Kuadrant on Envoy

The GA gateway is built on Istio, Envoy and Gateway API. Registering a backend
takes two objects:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: ovn-recon-mcp
  namespace: ovn-recon
  labels: {mcp-server: 'true'}
spec:
  parentRefs: [{name: mcp-gateway, namespace: mcp-gateway}]
  hostnames: ['ovn-recon.mcp.local']
  rules:
  - matches: [{path: {type: PathPrefix, value: /}}]
    backendRefs: [{name: ovn-collector, port: 8090}]
---
apiVersion: mcp.kuadrant.io/v1
kind: MCPServerRegistration
metadata: {name: ovn-recon, namespace: ovn-recon}
spec:
  prefix: ovnrecon_
  path: /mcp
  targetRef:
    group: gateway.networking.k8s.io
    kind: HTTPRoute
    name: ovn-recon-mcp
    namespace: ovn-recon
  # optional shared secret the broker sends upstream; Secret needs the
  # label mcp.kuadrant.io/secret=true, key defaults to "token"
  credentialRef: {name: ovn-recon-mcp-token, key: token}
```

`spec.prefix` is immutable and limited to lowercase letters, digits and
underscores, so `ovnrecon_` is valid. `spec.path` defaults to `/mcp`. The
`*.mcp.local` hostname is the convention the 1.5 docs use for in-cluster
routes. The gateway classifies stateless requests from the
`MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers and rejects a
request whose `Mcp-Name` disagrees with `params.name` in the body.

Authentication is a Kuadrant `AuthPolicy` with a JWT issuer (Keycloak or Entra
in the examples); in 1.5 that lives in the separate *Secure your traffic*
book rather than the registration guide. Per-tool authorization is a second
`AuthPolicy` whose CEL expression compares the router-set headers
`x-mcp-servername` and `x-mcp-toolname` against roles in the token, as shown
in the October 2026 lockdown article. The gateway also offers federated
prompts and resources, NeMo guardrails on `tools/call`, audit log lines, and
Prometheus metrics on the broker.

Sources: [Connectivity Link 1.5: Register MCP servers and create policies](https://docs.redhat.com/en/documentation/red_hat_connectivity_link/1.5/html/register_mcp_servers_and_create_policies/index),
[Locking down MCP at the gateway](https://developers.redhat.com/articles/2026/10/23/locking-down-mcp-at-the-gateway),
[Kuadrant MCP gateway architecture](https://docs.kuadrant.io/1.4.x/mcp-gateway/docs/design/overview/).
The 1.3 Technology Preview docs used `mcp.kuadrant.io/v1alpha1` and
`spec.toolPrefix`; the GA API is `v1` with `spec.prefix`.

### Tomorrow: Praxis

[Praxis](https://github.com/praxis-proxy/praxis) is a Rust proxy, and
[Praxis AI](https://github.com/praxis-proxy/ai) adds AI-aware filters on top,
including an `mcp` filter that does classification, tool-catalog aggregation
and `tools/call` routing in-proxy. An open design PR,
[MCP Gateway on Praxis](https://github.com/Kuadrant/mcp-gateway/pull/1645)
(Kuadrant, 2026-11-03), proposes that "MCP Gateway 2.0 ships on Praxis" with
"no Envoy, Istio or Gateway API". What changes for a backend:

| Concern | Kuadrant on Envoy (1.x) | Praxis design (2.0, proposed) |
|---|---|---|
| Registration CR | `mcp.kuadrant.io/v1` `MCPServerRegistration` (`prefix`, `path`, `targetRef`, `credentialRef`) + `HTTPRoute` | `aigateway.praxis.io/v1alpha1` `MCPServer` with `backend.serviceRef`, `path`, `toolPrefix`, `toolFilter`, `credentialRef`, `governance` |
| Gateway object | Gateway API `Gateway` + `MCPGatewayExtension` | `AIGateway` |
| Backend reachability | Any `Service` an `HTTPRoute` can reach | Same-namespace `Service` or an allow-listed URL |
| Per-tool authz | `AuthPolicy` with CEL over `x-mcp-*` headers | Policy Engine attributes `mcp.tool.*`; headers go away |
| Sessions | Stateless and stateful paths | Stateless `tools/call` shipped (praxis-proxy/ai v0.6.0); sessionful backends not yet supported |
| Tool prefix | Prepended on list, stripped on call | Same |

Status is proposal; the PR had no maintainer approval at time of writing and
the design doc says the order of work "will be planned once this approach is
agreed." Praxis AI describes itself as alpha.

### Design rules so the transition is cheap

1. **The server never knows which gateway is in front of it.** It reads no
   `x-mcp-*` header, mints no session, and returns bare tool names. Everything
   gateway-specific lives in the operator.
2. **Registration is an interface in the operator**, `GatewayRegistrar`, with
   one implementation per API (`kuadrant`, later `praxis`), chosen by which
   CRDs are discoverable. Each is a small set of unstructured objects, so a new
   gateway is a new file, not a redesign.
3. **Stateless only.** This is required by Praxis today and recommended by the
   spec, and it costs nothing for a read-only server.
4. **Same-namespace Service.** The collector Service is already in the
   `OvnRecon` target namespace; the registration objects are created there too.
   This satisfies the Praxis constraint without changing the Kuadrant path.
5. **Authorization is coarse and declared, not computed.** All tools are
   read-only, so a single role suffices on either gateway. We document the
   recommended policy for each and do not try to express per-user RBAC at the
   gateway.

## Security and trust model

- **Gateway-trusted mode (default).** The gateway authenticates and authorizes.
  The collector accepts requests on `/mcp` from the gateway's pods only
  (NetworkPolicy) and serves with its own ServiceAccount, the same trust model
  the console proxy path uses today. Optionally the registration's
  `credentialRef` carries a shared token the broker sends upstream and the
  collector checks; this is cheap defense in depth.
- **Direct mode (opt-in).** For clusters without a gateway. The collector
  wraps `/mcp` in `auth.RequireBearerToken` with a `TokenVerifier` that calls
  Kubernetes `TokenReview`, then a `SubjectAccessReview` for `get` on `nodes`.
  It serves RFC 9728 metadata pointing at the cluster's OAuth issuer. The token
  is used only for those two reviews and is never forwarded.
- **No per-user Kubernetes RBAC through the gateway.** The gateway validates an
  external OIDC token, not an OpenShift OAuth token. The OpenShift MCP server
  gets per-user RBAC only by forwarding the token to the API server on clusters
  configured for external OIDC, and that pattern is exactly the token
  passthrough the MCP spec forbids for third-party servers. OVN Recon returns
  the same read-only data to every authorized caller, which matches what the
  plugin does today.
- **No command execution surface.** The server exposes derived data only. The
  collector's pod-exec capability stays internal and is never parameterized by
  tool input.
- **Bounded output.** Every list is paged or capped, and the raw snapshot is a
  resource rather than a tool result.

## Testing and evals

Unit tests follow the existing pattern: Go tests driven by
`collector/fixtures/snapshots/`, and the ported selectors asserting the same outcomes as
their Jest counterparts.

For the tools themselves, Anthropic's advice is to build an eval suite of
realistic, multi-call tasks with verifiable answers and run them with a simple
agent loop, tracking tool calls, tokens and errors, then feed transcripts back
into description and default tuning. Planned first tasks, all answerable from
the fixture corpus:

- Which interface and bridge carry CUDN `<x>` on node `<y>`?
- Which node is missing the bridge mapping for localnet `<z>`?
- What is the logical path from pod `<a>` to pod `<b>`?
- Why does the logical view for node `<y>` show a fallback warning?

Manual verification uses [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
against a local `make run` collector in fixture mode, and `claude mcp add`
for end-to-end use from Claude Code.

## Phases

- **A. Foundation.** SDK dependency, `/mcp` handler, `list_nodes`,
  `get_logical_summary`, resources, fixture mode, Inspector-verified.
- **B. Operator.** `spec.mcp`, NetworkPolicy, Kuadrant registrar, status.
- **C. Derived model.** Selector port to Go, informers, `get_node_summary`,
  `get_network`, `lookup_address`, `check_consistency`.
- **D. Diagnosis.** `trace_path`, `lint`, prompts.
- **E. Hardening.** Direct-mode auth, evals, description tuning, docs.
- **F. Praxis.** Second registrar when the `aigateway.praxis.io` API ships.

## Initial Beads Backlog Mapping

| Work Item | Type | Issue ID | Status |
|---|---|---|---|
| MCP server epic | epic | `ovn-recon-khy` | `OPEN` |
| MCP foundation: stateless `/mcp` with `list_nodes` and `get_logical_summary` | task | `ovn-recon-khy.1` | `OPEN` |
| Operator: `spec.mcp`, NetworkPolicy, conditional gateway registration | task | `ovn-recon-khy.2` | `OPEN` |
| Port physical-topology selectors from TypeScript to Go | task | `ovn-recon-khy.3` | `OPEN` |
| Tools: `lookup_address`, `get_network`, `check_consistency` | task | `ovn-recon-khy.4` | `OPEN` |
| Tools: `trace_path` and `lint` | task | `ovn-recon-khy.5` | `OPEN` |
| Direct-access auth mode with TokenReview verifier | task | `ovn-recon-khy.6` | `OPEN` |
| Evals and tool-description iteration loop | task | `ovn-recon-khy.7` | `OPEN` |
| Prompts and user documentation | task | `ovn-recon-khy.8` | `OPEN` |
| Praxis registrar | task | `ovn-recon-khy.9` | `OPEN` |

## Open questions

1. Resolved 2026-11-04: the GA registration API is `mcp.kuadrant.io/v1`
   with `spec.prefix`. The per-tool authorization policy shape (CEL over
   `x-mcp-*` headers) comes from an article, not the 1.5 docs; confirm it in
   the *Secure your traffic* book before writing the recommended policy.
2. Should `spec.mcp.enabled` default on once the feature is stable, matching
   `spec.collector.enabled`?
3. Is the `credentialRef` shared-secret check worth the operational cost, given
   NetworkPolicy already limits ingress?
4. Should the ported Go selectors eventually replace the TypeScript ones, with
   the plugin consuming derived relationships from the collector?
5. What is the right console deep-link format once the OVN perspective
   cross-links (`ovn-recon-s3t.16`, `ovn-recon-s3t.31`) land?

## References

### Red Hat products

- [Model Context Protocol gateway for Red Hat OpenShift is now generally available](https://www.redhat.com/en/blog/model-context-protocol-gateway-red-hat-openshift-now-generally-available) (2026-10-16)
- [Locking down MCP at the gateway](https://developers.redhat.com/articles/2026/10/23/locking-down-mcp-at-the-gateway) (2026-10-23)
- [Advanced authentication and authorization for MCP Gateway](https://developers.redhat.com/articles/2025/12/12/advanced-authentication-authorization-mcp-gateway) (2025-12-12)
- [Connectivity Link 1.5: Introduction to the MCP gateway](https://docs.redhat.com/en/documentation/red_hat_connectivity_link/1.5/html/mcp_gateway/mcp-gateway-introduction)
- [Connectivity Link 1.5: Register MCP servers and create policies](https://docs.redhat.com/en/documentation/red_hat_connectivity_link/1.5/html/register_mcp_servers_and_create_policies/index)
- [Connectivity Link 1.3: Registering MCP servers and creating policies](https://docs.redhat.com/en/documentation/red_hat_connectivity_link/1.3/html/registering_mcp_servers_and_creating_policies/index) (Technology Preview API; superseded)
- [OpenShift AI 3.5: Working with the MCP catalog](https://docs.redhat.com/en/documentation/red_hat_openshift_ai_self-managed/3.5/html/working_with_the_mcp_catalog)
- [OpenShift 5.0: MCP server](https://docs.redhat.com/en/documentation/openshift_container_platform/5.0/html/ai_applications/mcp-server) and [OpenShift 4.22: MCP server](https://docs.redhat.com/en/documentation/openshift_container_platform/4.22/html/ai_applications/mcp-server)
- [OKD: MCP server overview](https://docs.okd.io/latest/ai_applications/mcp_server/mcp-server-overview.html)
- [openshift/openshift-mcp-server user guide](https://github.com/openshift/openshift-mcp-server/blob/main/docs/openshift/user-guide.md)
- [OpenShift Lightspeed 1.0: Configuring](https://docs.redhat.com/en/documentation/red_hat_openshift_lightspeed/1.0/html/configure/ols-configuring-openshift-lightspeed)
- [Simplify GitOps workflows with MCP in OpenShift Lightspeed](https://developers.redhat.com/articles/2026/07/21/simplify-gitops-workflows-mcp-openshift-lightspeed)

### Kuadrant and Praxis

- [Kuadrant MCP gateway: architecture overview](https://docs.kuadrant.io/1.4.x/mcp-gateway/docs/design/overview/)
- [Kuadrant MCP gateway: overview guide](https://docs.kuadrant.io/1.4.x/mcp-gateway/docs/guides/overview/)
- [Kuadrant/mcp-gateway PR 1645: MCP Gateway on Praxis (design)](https://github.com/Kuadrant/mcp-gateway/pull/1645)
- [Kuadrant/mcp-gateway issue 809: native Envoy MCP filter](https://github.com/Kuadrant/mcp-gateway/issues/809)
- [praxis-proxy/praxis](https://github.com/praxis-proxy/praxis) and [praxis-proxy/praxis issue 15: Istio epic](https://github.com/praxis-proxy/praxis/issues/15)
- [praxis-proxy/ai](https://github.com/praxis-proxy/ai), [issue 155: MCP gateway backend registry and tools/list aggregation](https://github.com/praxis-proxy/ai/issues/155), [issue 463: native kuadrant-filter integration](https://github.com/praxis-proxy/ai/issues/463), [PR 1833: Kuadrant MCP gateway authorization acceptance test](https://github.com/praxis-proxy/ai/pull/1833)
- [red-hat-data-services/ai-gateway-controller](https://github.com/red-hat-data-services/ai-gateway-controller) (deploys the Praxis ext-proc data plane)

### MCP specification

- [Specification 2026-07-28: Base protocol](https://modelcontextprotocol.io/specification/2026-07-28/basic)
- [Specification 2026-07-28: Authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) and [Authorization security considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations)
- [Security best practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices)
- [SEP-2567: sessionless MCP](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2567)
- [RFC 9728: OAuth 2.0 Protected Resource Metadata](https://www.rfc-editor.org/rfc/rfc9728)
- [RFC 8707: Resource Indicators for OAuth 2.0](https://www.rfc-editor.org/rfc/rfc8707)
- [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

### Go SDK

- [modelcontextprotocol/go-sdk](https://github.com/modelcontextprotocol/go-sdk) (v1.8.0 at time of writing; v1.7.0+ targets 2026-07-28)
- [pkg.go.dev: mcp package](https://pkg.go.dev/github.com/modelcontextprotocol/go-sdk/mcp) and [auth package](https://pkg.go.dev/github.com/modelcontextprotocol/go-sdk/auth)

### Anthropic guidance on authoring tools and agents

- [Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11)
- [Building agents that reach production systems with MCP](https://claude.com/resources/articles/building-agents-that-reach-production-systems-with-mcp) (2026-04-22)
- [Code execution with MCP: building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp) (2025-11-04)
- [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) (2024-12-19)

### Project documents this plan builds on

- `docs/tasks/OVN_LOGICAL_PERSPECTIVE_PLAN.md` — the snapshot contract and classification layer the tools read
- `docs/tasks/OVN_COLLECTOR_RUNTIME_SEMANTICS.md` — collector cache and fallback behavior
- `docs/EVENT_REASON_CATALOG.md` — operator events, served as an MCP resource
- `collector/api/logical-topology-snapshot.schema.json` — the snapshot schema, served as an MCP resource
