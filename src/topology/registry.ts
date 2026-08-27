import {
    findPrimaryNetworkForVrf,
    findRouteAdvertisementForVrf,
    formatLabelSelector,
    getCudnAssociatedNamespaces,
    getCudnsSelectedByRouteAdvertisement,
    getIpv4Addresses,
    getNadUpstreamNodeIds,
    getPoliciesClaimingBridgeMapping,
    getPoliciesClaimingInterface,
    getRouteAdvertisementsMatchingCudn,
    getVrfConnectionInfo,
    getVrfRoutesForInterface,
    NncpClaim,
    parseNadConfig,
    VrfAssociatedRoute
} from '../components/nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    RouteAdvertisements,
    UserDefinedNetwork
} from '../types';
import { GraphContext } from './context';
import { baseFacts } from './facts';
import { getApiResourcePath, getNamespaceQueryPath, getProjectPath } from './links';
import {
    AttachmentNode, Fact, FactItem, NodeKind, NodeKindDefinition, NodeViewModel, ResourceRef
} from './types';

/**
 * Per-kind drawer content as DATA (ovn-recon-s3t.12).
 *
 * Each kind exposes facts(node, ctx): a pure list of labelled values with
 * PROVENANCE -- observed, declared, or inferred -- rendered by the one shared
 * FactList. This replaced ~500 lines of per-kind DescriptionList JSX written
 * against `any`, none of which was testable.
 *
 * Provenance is the point. A recon tool infers a lot; the inferred facts carry
 * a hint naming the rule that produced them, so an operator debugging a
 * mismatch knows which claims to distrust.
 */

export const getUdnTopologyAndRole = (udn: UserDefinedNetwork): { topology: string; role: string } => {
    // UserDefinedNetworkSpec: topology, layer2, layer3 are at spec level (not spec.network)
    const topology = udn.spec?.topology || 'Unknown';
    const role =
        topology === 'Layer2' ? (udn.spec?.layer2?.role || 'Unknown')
            : topology === 'Layer3' ? (udn.spec?.layer3?.role || 'Unknown')
                : 'Unknown';
    return { topology, role };
};

const getMacAddress = (raw: unknown): string | undefined => {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    const record = raw as Record<string, unknown>;
    const macAddress = record.mac_address ?? record['mac-address'];
    return typeof macAddress === 'string' ? macAddress : undefined;
};

const getAttachmentNamespaces = (node: NodeViewModel): string[] => (
    Array.from(
        new Set(
            (node.namespaces || [])
                .map((ns) => ns?.trim())
                .filter((ns): ns is string => Boolean(ns))
        )
    )
);

const getAttachmentNadRefs = (node: NodeViewModel, ctx: GraphContext): Array<{ namespace: string; name: string }> => {
    const nadName = node.label?.trim();
    if (!nadName) {
        return [];
    }
    const namespaces = new Set(getAttachmentNamespaces(node));
    const refs = ctx.nads
        .filter((nad) => {
            const namespace = nad.metadata?.namespace || '';
            return namespaces.has(namespace) && nad.metadata?.name === nadName;
        })
        .map((nad) => ({
            namespace: nad.metadata?.namespace || '',
            name: nad.metadata?.name || ''
        }))
        .filter((ref) => ref.namespace && ref.name);
    return Array.from(new Map(refs.map((ref) => [`${ref.namespace}/${ref.name}`, ref])).values());
};

const cudnRef = (name: string): ResourceRef => ({
    apiVersion: 'k8s.ovn.org/v1', kind: 'ClusterUserDefinedNetwork', name
});

const raRef = (name: string): ResourceRef => ({
    apiVersion: 'k8s.ovn.org/v1', kind: 'RouteAdvertisements', name
});

const nadRef = (namespace: string, name: string): ResourceRef => ({
    apiVersion: 'k8s.cni.cncf.io/v1', kind: 'NetworkAttachmentDefinition', name, namespace
});

const routeText = (route: VrfAssociatedRoute): string => [
    route.destination,
    route.nextHopAddress ? ` via ${route.nextHopAddress}` : '',
    route.nextHopInterface ? ` dev ${route.nextHopInterface}` : '',
    route.metric ? ` metric ${route.metric}` : '',
    route.protocol ? ` proto ${route.protocol}` : ''
].join('');

const getBridgePortNames = (raw: Interface | undefined): string[] => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyRaw = raw as any;
    const rawPorts = anyRaw?.bridge?.port || anyRaw?.bridge?.ports || anyRaw?.ports || [];
    if (!Array.isArray(rawPorts)) return [];
    return rawPorts
        .map((port: unknown) => {
            if (typeof port === 'string') return port;
            if (port && typeof port === 'object' && 'name' in (port as Record<string, unknown>)) {
                const name = (port as Record<string, unknown>).name;
                return typeof name === 'string' ? name : '';
            }
            return '';
        })
        .filter(Boolean);
};

/**
 * Type rows link to the console's API resource reference page for the kind --
 * the version-proof 'learn more' (ovn-recon-s3t.39). Interface-family kinds
 * link to NodeNetworkState, the resource their data is read from.
 */
const NNS_API = getApiResourcePath('nmstate.io/v1beta1', 'NodeNetworkState');
const CUDN_API = getApiResourcePath('k8s.ovn.org/v1', 'ClusterUserDefinedNetwork');
const UDN_API = getApiResourcePath('k8s.ovn.org/v1', 'UserDefinedNetwork');
const NAD_API = getApiResourcePath('k8s.cni.cncf.io/v1', 'NetworkAttachmentDefinition');

const nncpRef = (name: string): ResourceRef => ({
    apiVersion: 'nmstate.io/v1', kind: 'NodeNetworkConfigurationPolicy', name
});

/**
 * Which NNCP configured this thing -- from 'what is this' to 'where do I
 * change it' (ovn-recon-s3t.34). Derived from this node's enactments, whose
 * desiredState RECORDS what each policy applied, so a claim is observed.
 *
 * Zero claims is informative too: with enactments present, an unclaimed
 * resource was created by the installer or by OVN-Kubernetes -- the finer
 * user-versus-cluster distinction a reader learning OVN-K needs. With no
 * enactments at all (no nmstate operator, or an imported NNS) nothing can be
 * said either way, so no fact is emitted.
 */
const configuredByFacts = (claims: NncpClaim[], ctx: GraphContext): Fact[] => {
    if (ctx.enactments.length === 0) {
        return [];
    }
    if (claims.length === 0) {
        return [{
            label: 'Configured By',
            value: 'No policy — created by the installer or OVN-Kubernetes',
            provenance: 'inferred',
            hint: 'No NodeNetworkConfigurationEnactment on this node claims it, so it was not configured through an NNCP.'
        }];
    }
    return [{
        label: 'Configured By',
        value: [
            ...claims.map((claim): FactItem => ({
                // A policy that is Failing or Progressing is worth seeing, not just its name.
                text: claim.status === 'Available' ? claim.policyName : `${claim.policyName} — ${claim.status}`,
                ref: nncpRef(claim.policyName)
            })),
            ...(claims.length > 1
                ? [{ text: '⚠ claimed by more than one policy — configuration overlap' }]
                : [])
        ],
        provenance: 'observed',
        hint: 'This node\'s enactment for the policy lists it in the applied desiredState.'
    }];
};

/**
 * The name-truncation heuristic behind VRF-to-RouteAdvertisements matching.
 * Named in the hint of every fact it produces, per the acceptance on s3t.12.
 */
const VRF_RA_HINT =
    'Matched by name: the RouteAdvertisements name equals this VRF name, possibly '
    + 'after truncation to 15 characters (the kernel interface-name limit). '
    + 'Nothing in the API records this link.';

export const nodeKindRegistry: Record<NodeKind, NodeKindDefinition> = {
    interface: {
        label: 'Interface',
        facts: (node, ctx) => {
            const raw = node.raw as Interface | undefined;
            const facts: Fact[] = [
                ...baseFacts(node, 'observed', NNS_API),
                ...configuredByFacts(getPoliciesClaimingInterface(raw?.name || '', ctx.enactments), ctx)
            ];
            if (raw?.type === 'vlan' && raw?.vlan) {
                // A kernel VLAN interface, created via NNCP -- not an OVN Localnet.
                facts.push({
                    label: 'VLAN',
                    value: [
                        { text: `Base: ${raw.vlan['base-iface']}` },
                        { text: `ID: ${raw.vlan.id}` }
                    ],
                    provenance: 'observed'
                });
            }
            const macAddress = getMacAddress(raw);
            if (macAddress) {
                facts.push({ label: 'MAC Address', value: macAddress, provenance: 'observed' });
            }
            if (raw?.mtu) {
                facts.push({ label: 'MTU', value: String(raw.mtu), provenance: 'observed' });
            }
            const ipv4 = getIpv4Addresses(raw);
            if (ipv4.length > 0) {
                facts.push({ label: 'IPv4', value: ipv4.join(', '), provenance: 'observed' });
            }
            if (raw?.type === 'linux-bridge' || raw?.type === 'ovs-bridge') {
                facts.push({
                    label: 'Ports',
                    value: getBridgePortNames(raw).map((text) => ({ text })),
                    provenance: 'observed',
                    emptyText: 'No bridge ports reported in NNS.'
                });
            }
            return facts;
        }
    },
    'ovn-mapping': {
        label: 'OVN Mapping',
        // No State fact: a mapping is never up or down -- it is a name OVN gives a bridge.
        facts: (node, ctx) => {
            const localnetName = node.raw?.localnet;
            const referencingCudns = ctx.cudns.filter((cudn: ClusterUserDefinedNetwork) => {
                const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName
                    || cudn.spec?.network?.localnet?.physicalNetworkName;
                return physicalNetworkName === localnetName;
            });
            return [
                { label: 'Type', value: [{ text: node.subtitle, href: NNS_API }], provenance: 'observed' },
                ...(node.raw?.bridge
                    ? [{ label: 'Bridge', value: node.raw.bridge, provenance: 'observed' } as Fact]
                    : []),
                ...configuredByFacts(getPoliciesClaimingBridgeMapping(localnetName || '', ctx.enactments), ctx),
                {
                    label: 'Referenced by CUDNs',
                    value: referencingCudns.map((cudn): FactItem => ({
                        text: cudn.metadata?.name || 'Unknown',
                        ref: cudnRef(cudn.metadata?.name || '')
                    })),
                    provenance: 'declared',
                    hint: 'CUDNs whose spec names this mapping as their physicalNetworkName.',
                    emptyText: 'No CUDNs reference this bridge mapping'
                }
            ];
        }
    },
    cudn: {
        label: 'CUDN',
        facts: (node, ctx) => {
            const cudn = node.raw as ClusterUserDefinedNetwork;
            const network = cudn?.spec?.network;
            const topology = network?.topology;
            const role =
                topology === 'Layer2' ? network?.layer2?.role
                    : topology === 'Layer3' ? network?.layer3?.role
                        : topology === 'Localnet'
                            ? (network?.localnet?.role || network?.localNet?.role || 'Secondary')
                            : undefined;
            const subnets = topology === 'Layer2' ? network?.layer2?.subnets
                : topology === 'Layer3' ? network?.layer3?.subnets
                    : undefined;
            const vlanId = network?.localNet?.vlan?.access?.id || network?.localnet?.vlan?.access?.id;
            const physicalNetworkName = network?.localNet?.physicalNetworkName
                || network?.localnet?.physicalNetworkName;
            const matchingRAs = (topology === 'Layer2' || topology === 'Layer3')
                ? getRouteAdvertisementsMatchingCudn(ctx.routeAdvertisements, cudn)
                : [];
            const cudnName = cudn?.metadata?.name || '';

            return [
                // No State fact: it would just restate Topology, VLAN ID and
                // Subnets below, and a network definition has no up/down anyway.
                // Kind alone, without the topology prefix -- Topology is canonical below.
                { label: 'Type', value: [{ text: 'ClusterUserDefinedNetwork', href: CUDN_API }], provenance: 'declared' },
                { label: 'Topology', value: topology || 'Unknown', provenance: 'declared' },
                ...(role ? [{ label: 'Role', value: role, provenance: 'declared' } as Fact] : []),
                ...((topology === 'Layer2' || topology === 'Layer3')
                    ? [{ label: 'Subnets', value: subnets?.join(', ') || '-', provenance: 'declared' } as Fact]
                    : []),
                ...(vlanId
                    ? [{ label: 'VLAN ID', value: String(vlanId), provenance: 'declared' } as Fact]
                    : []),
                ...(physicalNetworkName
                    ? [{ label: 'Physical Network', value: physicalNetworkName, provenance: 'declared' } as Fact]
                    : []),
                ...(cudn?.spec?.namespaceSelector
                    ? [(() => {
                        const text = formatLabelSelector(cudn.spec!.namespaceSelector)
                            || 'Matches all namespaces (empty selector)';
                        const queryPath = getNamespaceQueryPath(cudn.spec!.namespaceSelector);
                        return {
                            label: 'Namespace Selector',
                            // Linked to the console's namespace list filtered by this
                            // selector, when it serializes (pure matchLabels only).
                            value: queryPath ? [{ text, href: queryPath }] : text,
                            provenance: 'declared',
                            hint: 'spec.namespaceSelector: the declared rule that scopes namespaces into this network.'
                        } as Fact;
                    })()]
                    : []),
                {
                    label: 'Namespaces',
                    value: getCudnAssociatedNamespaces(cudn).map((ns): FactItem => ({
                        text: ns,
                        ref: nadRef(ns, cudnName)
                    })),
                    provenance: 'inferred',
                    hint: 'The namespaces the namespaceSelector scoped in, parsed out of the '
                        + 'NetworkCreated condition message; the API does not list them directly.'
                },
                {
                    label: 'Route Advertisements',
                    value: matchingRAs.map((ra: RouteAdvertisements): FactItem => ({
                        text: ra.metadata?.name || 'Unknown',
                        ref: raRef(ra.metadata?.name || '')
                    })),
                    provenance: 'declared',
                    hint: 'RouteAdvertisements whose networkSelector matches this CUDN\'s labels.'
                }
            ];
        }
    },
    udn: {
        label: 'UDN',
        facts: (node, ctx) => {
            const udn = node.raw as UserDefinedNetwork;
            const namespace = udn?.metadata?.namespace || '';
            const name = udn?.metadata?.name || '';
            const { topology, role } = getUdnTopologyAndRole(udn);
            const subnets = topology === 'Layer2' ? udn?.spec?.layer2?.subnets
                : topology === 'Layer3' ? udn?.spec?.layer3?.subnets
                    : undefined;
            const nadInNs = name && namespace
                ? ctx.nads.find((nad: NetworkAttachmentDefinition) =>
                    nad.metadata?.namespace === namespace && nad.metadata?.name === name)
                : undefined;

            return [
                // No State fact, for the same reason as the CUDN above. Kind alone:
                // the namespace, topology and role all have canonical facts below.
                { label: 'Type', value: [{ text: 'UserDefinedNetwork', href: UDN_API }], provenance: 'declared' },
                { label: 'Topology', value: topology, provenance: 'declared' },
                { label: 'Role', value: role, provenance: 'declared' },
                {
                    label: 'Namespace',
                    value: [{ text: namespace, href: getProjectPath(namespace) }],
                    provenance: 'declared'
                },
                ...((topology === 'Layer2' || topology === 'Layer3')
                    ? [{ label: 'Subnets', value: subnets?.join(', ') || '-', provenance: 'declared' } as Fact]
                    : []),
                ...(nadInNs
                    ? [{
                        label: 'NetworkAttachmentDefinition',
                        value: [{ text: name, ref: nadRef(namespace, name) }],
                        provenance: 'observed',
                        hint: 'A NAD with the UDN\'s name exists in its namespace.'
                    } as Fact]
                    : [])
            ];
        }
    },
    attachment: {
        label: 'Attachment',
        buildBadges: (node) => (node.isSynthetic ? ['synthetic', 'derived'] : []),
        facts: (node, ctx) => {
            const cudnBacked = Boolean((node.raw as AttachmentNode | undefined)?.cudn);
            return [
                // No State fact: the synthetic node's state field is a rendering
                // artifact ('Namespaces:'), not a fact about anything.
                { label: 'Type', value: [{ text: node.subtitle, href: NAD_API }], provenance: 'observed' },
                {
                    label: 'Namespaces',
                    value: getAttachmentNamespaces(node).map((ns): FactItem => ({
                        text: ns, href: getProjectPath(ns)
                    })),
                    provenance: cudnBacked ? 'inferred' : 'declared',
                    hint: cudnBacked
                        ? 'Parsed out of the backing CUDN\'s NetworkCreated condition message.'
                        : 'The namespace of the UDN behind this attachment.',
                    emptyText: 'No namespaces discovered.'
                },
                {
                    label: 'NetworkAttachmentDefinitions',
                    value: getAttachmentNadRefs(node, ctx).map((ref): FactItem => ({
                        text: `${ref.namespace}/${ref.name}`,
                        ref: nadRef(ref.namespace, ref.name)
                    })),
                    provenance: 'observed',
                    hint: 'NADs carrying the attachment\'s name, found in those namespaces.',
                    emptyText: 'No matching NetworkAttachmentDefinition found.'
                }
            ];
        }
    },
    nad: {
        label: 'NAD',
        facts: (node) => {
            const nad = node.raw as NetworkAttachmentDefinition;
            const config = parseNadConfig(nad?.spec?.config);
            const nadType = typeof config?.type === 'string' ? config.type : 'Unknown';
            const nadName = typeof config?.name === 'string' ? config.name : undefined;
            const upstream = nad ? getNadUpstreamNodeIds(nad) : [];
            const bridges = upstream.filter((id) => !id.startsWith('ovn:'));
            const physnets = upstream.filter((id) => id.startsWith('ovn:')).map((id) => id.slice('ovn:'.length));
            // When the config did not parse, anything found in it came from the
            // regex fallback over the raw string -- one of the four heuristics
            // named on s3t.12.
            const fromRegex = config == null;
            const upstreamProvenance = fromRegex ? 'inferred' as const : 'declared' as const;
            const upstreamHint = fromRegex
                ? 'Pattern-extracted from a CNI config string that did not parse as JSON.'
                : 'Named by the NAD\'s CNI config.';

            return [
                { label: 'Type', value: [{ text: node.subtitle, href: NAD_API }], provenance: 'declared' },
                { label: 'CNI Type', value: nadType, provenance: fromRegex ? 'inferred' : 'declared', hint: fromRegex ? upstreamHint : undefined },
                ...(nadName
                    ? [{ label: 'Network Name', value: nadName, provenance: 'declared' } as Fact]
                    : []),
                ...(bridges.length > 0
                    ? [{
                        label: 'Bridge',
                        value: bridges.map((text) => ({ text })),
                        provenance: upstreamProvenance,
                        hint: upstreamHint
                    } as Fact]
                    : []),
                ...(physnets.length > 0
                    ? [{
                        label: 'Physical Network',
                        value: physnets.map((text) => ({ text })),
                        provenance: upstreamProvenance,
                        hint: upstreamHint
                    } as Fact]
                    : [])
            ];
        }
    },
    'lldp-neighbor': {
        label: 'LLDP Neighbor',
        facts: (node) => [
            ...baseFacts(node),
            { label: 'Local Interface', value: node.raw?.localInterface || '-', provenance: 'observed' },
            { label: 'System Name', value: node.raw?.systemName || '-', provenance: 'observed' },
            { label: 'Port ID', value: node.raw?.portId || '-', provenance: 'observed' },
            { label: 'Chassis ID', value: node.raw?.chassisId || '-', provenance: 'observed' },
            ...(node.raw?.systemDescription
                ? [{ label: 'System Description', value: node.raw.systemDescription, provenance: 'observed' } as Fact]
                : []),
            {
                label: 'Capabilities',
                value: Array.isArray(node.raw?.capabilities)
                    ? node.raw.capabilities.map((text: string) => ({ text }))
                    : [],
                provenance: 'observed',
                emptyText: 'No capabilities reported'
            }
        ]
    },
    vrf: {
        label: 'VRF',
        facts: (node, ctx) => {
            const raw = node.raw as Interface;
            const ra = findRouteAdvertisementForVrf(ctx.routeAdvertisements, raw?.name || '');
            const matchedCudns = getCudnsSelectedByRouteAdvertisement(ra, ctx.cudns);
            const { brIntPorts } = getVrfConnectionInfo(raw, ctx.interfaces);
            const macAddress = getMacAddress(raw);
            // Route association is priced for one node: it walks the whole NNS route
            // table, so it runs here, for the drawer, never during graph render.
            const vrfRoutes = getVrfRoutesForInterface(raw, ctx.nns);

            const primary = findPrimaryNetworkForVrf(raw, ctx.cudns, ctx.udns, ctx.interfaces);

            return [
                // Type only: the old State line ('ovn-k8s-mp3 Tbl 5775') just
                // restated the Route Table and br-int Ports facts below.
                { label: 'Type', value: [{ text: node.subtitle, href: NNS_API }], provenance: 'observed' },
                // A VRF is an interface too: unclaimed here reads 'OVN-Kubernetes
                // created this', which is true of every Primary-network VRF.
                ...configuredByFacts(getPoliciesClaimingInterface(raw?.name || '', ctx.enactments), ctx),
                ...(primary
                    ? [{
                        label: 'Serves Primary Network',
                        value: [{
                            text: primary.kind === 'cudn'
                                ? `${primary.name} (ClusterUserDefinedNetwork)`
                                : `${primary.namespace}/${primary.name} (UserDefinedNetwork)`,
                            ref: primary.kind === 'cudn'
                                ? cudnRef(primary.name)
                                : {
                                    apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork',
                                    name: primary.name, namespace: primary.namespace
                                }
                        }],
                        provenance: 'inferred',
                        hint: `This VRF was created by OVN-Kubernetes as a side effect of defining that Primary network. `
                            + `Matched by ${primary.signals.join(' and ')}: a Primary Layer2 or Layer3 network gets a `
                            + 'per-node VRF named after it (truncated to 15 characters), holding routes in the '
                            + 'network\'s subnet. Localnet networks cannot be Primary.'
                    } as Fact]
                    : []),
                ...(macAddress
                    ? [{ label: 'MAC Address', value: macAddress, provenance: 'observed' } as Fact]
                    : []),
                ...(raw?.vrf?.['route-table-id']
                    ? [{ label: 'Route Table', value: String(raw.vrf['route-table-id']), provenance: 'observed' } as Fact]
                    : []),
                {
                    label: 'Routes',
                    value: vrfRoutes.map((route) => ({ text: routeText(route) })),
                    provenance: 'observed',
                    hint: 'NNS routes in this VRF\'s route table, or leaving via one of its ports.',
                    emptyText: 'No associated routes found in NNS.'
                },
                {
                    label: 'br-int Ports',
                    value: brIntPorts.map((iface) => {
                        const addresses = getIpv4Addresses(iface);
                        return { text: `${iface.name}${addresses.length > 0 ? ` ${addresses.join(', ')}` : ''}` };
                    }),
                    provenance: 'inferred',
                    hint: 'Set intersection: interfaces that are ports of this VRF and also ports of br-int in NNS.',
                    emptyText: 'No matching br-int ports inferred from NNS.'
                },
                // The RA block renders only when an advertisement matched: an
                // always-on 'Matched CUDNs: N/A' row said nothing.
                ...(ra
                    ? [{
                        label: 'Route Advertisement',
                        value: [{
                            text: ra.metadata?.name || 'Unknown',
                            ref: raRef(ra.metadata?.name || '')
                        }],
                        provenance: 'inferred',
                        hint: VRF_RA_HINT
                    } as Fact,
                    {
                        label: 'Matched CUDNs',
                        value: matchedCudns.length > 0
                            ? matchedCudns.map((cudn): FactItem => ({
                                text: cudn.metadata?.name || 'Unknown',
                                ref: cudnRef(cudn.metadata?.name || '')
                            }))
                            : 'N/A',
                        provenance: 'inferred',
                        hint: `${VRF_RA_HINT} CUDNs are then selected by that RouteAdvertisements' networkSelector.`
                    } as Fact]
                    : [])
            ];
        }
    },
    other: {
        label: 'Other'
    }
};
