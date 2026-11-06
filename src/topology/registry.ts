import {
    CUDN_NETWORK_PREFIX,
    describeBond,
    EVPN_NETWORK_DEVICES,
    EVPN_VTEP_DEVICES,
    describeSriovVfSettings,
    extractLldpNeighbors,
    findSriovParent,
    getSriovConfig,
    getSriovVfs,
    findEvpnNetworkForDevice,
    findPatchPortsForCudn,
    findPrimaryNetworkForVrf,
    findRouteAdvertisementForVrf,
    findUnresolvedVrfNetworkId,
    findVtepForDevice,
    formatLabelSelector,
    getCudnAssociatedNamespaces,
    getCudnsSelectedByRouteAdvertisement,
    getCudnsUsingVtep,
    getIpv4Addresses,
    getNadUpstreamNodeIds,
    getNetworkPatchPorts,
    getPoliciesClaimingBridgeMapping,
    getPoliciesClaimingInterface,
    getRouteAdvertisementsMatchingCudn,
    getVrfConnectionInfo,
    getVrfRoutesForInterface,
    NETWORK_ID_ANNOTATION,
    NetworkPatchPort,
    NncpClaim,
    NODE_VTEPS_ANNOTATION,
    parseNadConfig,
    resolvePatchPortCudn,
    UnresolvedVrfNetworkId,
    VrfAssociatedRoute
} from '../components/nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork,
    EvpnNetworkConfig,
    EvpnVrfConfig,
    Interface,
    NetworkAttachmentDefinition,
    RouteAdvertisements,
    UserDefinedNetwork
} from '../types';
import { GraphContext } from './context';
import { formatSubnets } from './subnets';
import { baseFacts } from './facts';
import { getApiResourcePath, getNamespaceQueryPath, getProjectPath } from './links';
import {
    AttachmentNode, Fact, FactItem, IntegrationBridgeNode, NodeKind, NodeKindDefinition,
    NodeViewModel, ResourceRef
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

/** nmstate reports Mb/s. Not positive means the kernel does not know, as on a link that is down. */
const formatLinkSpeed = (mbps: unknown): string | undefined => {
    if (typeof mbps !== 'number' || !(mbps > 0)) {
        return undefined;
    }
    return mbps >= 1000 ? `${mbps / 1000} Gb/s` : `${mbps} Mb/s`;
};

/** Speed, duplex and auto-negotiation as one row: they are read together or not at all. */
const linkFacts = (raw: Interface): Fact[] => {
    const link = raw.ethernet;
    const autoNegotiation = link?.['auto-negotiation'];
    const parts = [
        formatLinkSpeed(link?.speed),
        // 'unknown' is ethtool's word for a link that is down; it is not worth a row.
        link?.duplex && link.duplex !== 'unknown' ? `${link.duplex} duplex` : undefined,
        typeof autoNegotiation === 'boolean' ? `auto-negotiation ${autoNegotiation ? 'on' : 'off'}` : undefined
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0
        ? [{ label: 'Link', value: parts.join(' · '), provenance: 'observed' }]
        : [];
};

/**
 * Shown only when it differs from the address in use, which is when it says something:
 * the NIC is answering to an address other than its own.
 */
const permanentMacFacts = (raw: Interface, macAddress: string | undefined, ctx: GraphContext): Fact[] => {
    const permanent = raw['permanent-mac-address'];
    if (typeof permanent !== 'string' || !permanent || !macAddress
        || permanent.toLowerCase() === macAddress.toLowerCase()) {
        return [];
    }
    const controllerName = raw.controller || raw.master;
    const bond = ctx.interfaces.find((iface) => iface.name === controllerName && iface.type === 'bond');
    return [{
        label: 'Permanent MAC',
        value: permanent,
        provenance: 'observed',
        hint: bond
            ? `The address the hardware reports. ${raw.name} is a member of bond ${bond.name}, and a bond gives `
                + 'its members a shared address, so the address in use differs.'
            : 'The address the hardware reports. The address in use differs, so it was set by configuration.'
    }];
};

/**
 * Three states, because they mean different things: off, on with nobody answering,
 * and on with a neighbour. An interface that does not report lldp at all says nothing.
 */
const lldpFacts = (raw: Interface): Fact[] => {
    if (!raw.lldp || typeof raw.lldp.enabled !== 'boolean') {
        return [];
    }
    if (!raw.lldp.enabled) {
        return [{ label: 'LLDP', value: 'Disabled', provenance: 'observed' }];
    }
    const neighbors = extractLldpNeighbors([raw]);
    if (neighbors.length === 0) {
        return [{
            label: 'LLDP',
            value: 'Enabled, no neighbors heard',
            provenance: 'observed',
            hint: 'lldp.enabled is true, but NodeNetworkState lists no neighbor on this interface.'
        }];
    }
    const texts = neighbors.map((neighbor) => (
        neighbor.portId ? `${neighbor.label}, ${neighbor.portId}` : neighbor.label
    ));
    return [{
        label: 'LLDP',
        // Two neighbours answering with the same name and port would be one line twice.
        value: Array.from(new Set(texts)).map((text) => ({ text })),
        provenance: 'observed',
        hint: 'lldp.enabled is true. Each entry is a neighbor heard on this interface: its system name and port. '
            + 'Turn on "Show LLDP neighbors" to draw them.'
    }];
};

/**
 * What a physical function has carved out of itself. Each VF is listed whether or not
 * it is a host interface: one that is not has gone somewhere nmstate cannot follow,
 * and that absence is the fact an operator is usually after.
 */
const sriovPfFacts = (raw: Interface): Fact[] => {
    const sriov = getSriovConfig(raw);
    if (!sriov) {
        return [];
    }
    const vfs = getSriovVfs(raw);
    const total = typeof sriov['total-vfs'] === 'number' ? sriov['total-vfs'] : vfs.length;
    const max = typeof sriov['max-vfs'] === 'number' ? sriov['max-vfs'] : undefined;
    const capacity = total === 0
        ? `Capable, no VFs configured${max != null ? ` (max ${max})` : ''}`
        : `${total}${max != null ? ` of ${max}` : ''} VF${total === 1 ? '' : 's'} configured`;
    const items: FactItem[] = [
        { text: capacity },
        ...(sriov['drivers-autoprobe'] === false ? [{ text: 'Driver autoprobe off: new VFs get no host driver' }] : []),
        ...vfs.map((vf) => {
            const name = vf['iface-name'];
            const where = name
                ? name
                : `no host interface${vf['mac-address'] ? ` (${vf['mac-address']})` : ''}`;
            return { text: [`VF ${vf.id}: ${where}`, ...describeSriovVfSettings(vf)].join(' · ') };
        })
    ];
    return [{
        label: 'SR-IOV',
        value: items,
        provenance: 'observed',
        hint: 'ethernet.sr-iov in NodeNetworkState. A VF with no host interface has been moved into a pod\'s '
            + 'network namespace or bound to a userspace driver such as vfio-pci; nmstate sees only that it left.'
    }];
};

/** Which physical function this VF was carved out of, by that PF's own report. */
const sriovVfFacts = (raw: Interface, ctx: GraphContext): Fact[] => {
    const parent = findSriovParent(raw.name, ctx.interfaces);
    if (!parent) {
        return [];
    }
    return [{
        label: 'SR-IOV VF',
        value: [
            { text: `VF ${parent.vf.id} of ${parent.pf.name}` },
            ...describeSriovVfSettings(parent.vf).map((text) => ({ text }))
        ],
        provenance: 'observed',
        hint: `ethernet.sr-iov.vfs[${parent.vf.id}].iface-name on ${parent.pf.name} is ${raw.name}. `
            + 'The settings are the PF\'s, which decide what the VF may do.'
    }];
};

/** Where the device sits on the bus, and the other names udev gave it. */
const hardwareIdentityFacts = (raw: Interface): Fact[] => {
    const altNames = (Array.isArray(raw['alt-names']) ? raw['alt-names'] : [])
        .map((entry) => entry?.name)
        .filter((name): name is string => typeof name === 'string' && name.length > 0);
    return [
        ...(typeof raw['pci-address'] === 'string' && raw['pci-address']
            ? [{ label: 'PCI Address', value: raw['pci-address'], provenance: 'observed' } as Fact]
            : []),
        ...(altNames.length > 0
            ? [{ label: 'Alternative Names', value: altNames.join(', '), provenance: 'observed' } as Fact]
            : [])
    ];
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

/** Cluster-scoped, so no namespace. */
const vtepRef = (name: string): ResourceRef => ({
    apiVersion: 'k8s.ovn.org/v1', kind: 'VTEP', name
});

const udnRef = (namespace: string, name: string): ResourceRef => ({
    apiVersion: 'k8s.ovn.org/v1', kind: 'UserDefinedNetwork', name, namespace
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

/**
 * The patch-port naming heuristic (ovn-recon-s3t.29). OVN-Kubernetes builds a patch
 * port's name from the network it serves; nothing in NodeNetworkState or the CUDN
 * declares the link, so every fact resting on it is inferred and says so.
 */
const PATCH_NAME_RULE =
    `a CUDN's network is ${CUDN_NETWORK_PREFIX}<name> with dashes written as dots. `
    + 'The naming is an OVN-Kubernetes implementation detail and the dash-to-dot step '
    + 'cannot be undone, so a port name that fits two CUDNs is matched to neither.';

/**
 * The patch pair(s) OVN-Kubernetes built for a CUDN on this node.
 *
 * For an overlay CUDN this is the only thing tying it to a bridge, and the graph
 * draws it. For a Localnet CUDN the pair reaches the bridge its bridge mapping
 * already names, so it is CORROBORATION of the declared Physical Network rather
 * than a second link: the fact says whether the two agree, and a disagreement is
 * the finding. No pair, no fact -- its absence proves nothing about the network.
 */
const cudnPatchPortFacts = (cudn: ClusterUserDefinedNetwork | undefined, ctx: GraphContext): Fact[] => {
    const { matched, ambiguous } = findPatchPortsForCudn(cudn?.metadata?.name, ctx.cudns, ctx.interfaces);
    if (matched.length === 0 && ambiguous.length === 0) return [];
    const physicalNetworkName = cudn?.spec?.network?.localNet?.physicalNetworkName
        || cudn?.spec?.network?.localnet?.physicalNetworkName;
    const mapping = ctx.bridgeMappings.find((m) => m.localnet === physicalNetworkName);

    return [{
        label: 'Patch Ports',
        value: [
            ...matched.flatMap((port): FactItem[] => [
                { text: `${port.bridge}: ${port.portName}${port.peerName ? ` ↔ ${port.peerName}` : ''}` },
                ...(port.form === 'localnet' && mapping
                    ? [{
                        text: mapping.bridge === port.bridge
                            ? `Agrees with bridge mapping ${mapping.localnet} → ${mapping.bridge}`
                            : `⚠ bridge mapping ${mapping.localnet} names ${mapping.bridge}, not ${port.bridge}`
                    }]
                    : [])
            ]),
            ...ambiguous.map(({ port, candidates }): FactItem => ({
                text: `⚠ ${port.portName} on ${port.bridge} fits ${candidates.join(' and ')} alike — matched to neither`
            }))
        ],
        provenance: 'inferred',
        hint: `Matched by name: OVN-Kubernetes names a network's patch ports after it, and ${PATCH_NAME_RULE} `
            + 'An overlay network\'s pair is its gateway onto a provider bridge; a Localnet network\'s pair '
            + 'reaches the bridge its physical network maps to, corroborating that mapping.'
    }];
};

/** What a patch pair's name says it carries, for the integration bridge's drawer. */
const patchedNetworkItem = (port: NetworkPatchPort, ctx: GraphContext): FactItem => {
    const where = port.bridge ?? 'no bridge';
    const suffix = `${port.form === 'localnet' ? ' (localnet)' : ''}`
        + `${port.bridge ? '' : ` — ${port.portName} is on no bridge`}`;
    if (port.isDefaultNetwork) return { text: `${where}: cluster default network${suffix}` };
    const cudnName = resolvePatchPortCudn(port, ctx.cudns);
    if (cudnName) return { text: `${where}: CUDN ${cudnName}${suffix}`, ref: cudnRef(cudnName) };
    return { text: `${where}: network ${port.networkName}${suffix}` };
};

/** A CUDN's EVPN VRFs as one phrase: `MAC-VRF VNI 10010 (RT 65002:10010)`. */
const evpnVrfText = (evpn: EvpnNetworkConfig | undefined): string => {
    const describe = (label: string, vrf: EvpnVrfConfig | undefined): string[] => (vrf
        ? [`${label}${vrf.vni != null ? ` VNI ${vrf.vni}` : ''}${vrf.routeTarget ? ` (RT ${vrf.routeTarget})` : ''}`]
        : []);
    return [...describe('MAC-VRF', evpn?.macVRF), ...describe('IP-VRF', evpn?.ipVRF)].join(', ');
};

/**
 * The VTEP an EVPN bridge or VXLAN device was created for (ovn-recon-s3t.53).
 *
 * The link is the device's NAME: OVN-Kubernetes derives it from the VTEP name, and
 * nothing in NodeNetworkState says so -- inferred, with the rule in the hint. One thing
 * can lift it: the Node's k8s.ovn.org/vteps annotation records the address discovered
 * for each VTEP, and when that equals a VXLAN device's own vxlan.local the two agree
 * without any appeal to naming. A disagreement is the finding, and is flagged.
 *
 * No known VTEP name fits the device, no fact: before EVPN, and for an NNS read
 * without its cluster, the drawer is exactly what it was.
 */
const evpnVtepFacts = (raw: Interface | undefined, ctx: GraphContext): Fact[] => {
    const device = findVtepForDevice(raw?.name, ctx.vtepNames);
    if (!raw || !device) return [];
    const { vtepName } = device;
    const vtep = ctx.vteps.find((candidate) => candidate.metadata?.name === vtepName);
    const accepted = vtep?.status?.conditions?.find((condition) => condition.type === 'Accepted');
    const local = raw.vxlan?.local;
    const discovered = ctx.nodeVteps[vtepName];
    const agrees = Boolean(local && discovered?.includes(local));

    const items: FactItem[] = [
        { text: vtepName, ref: vtepRef(vtepName) },
        { text: `This device: ${EVPN_VTEP_DEVICES[device.prefix]}` },
        ...(vtep
            ? [
                ...(vtep.spec?.mode ? [{ text: `Mode: ${vtep.spec.mode}` }] : []),
                ...(vtep.spec?.cidrs?.length ? [{ text: `CIDRs: ${vtep.spec.cidrs.join(', ')}` }] : []),
                accepted
                    ? {
                        text: accepted.status === 'True'
                            ? `Accepted: True${accepted.reason ? ` — ${accepted.reason}` : ''}`
                            : `⚠ Accepted: ${accepted.status}`
                                + `${accepted.reason ? ` — ${accepted.reason}` : ''}`
                                + `${accepted.message ? `: ${accepted.message}` : ''}`
                    }
                    : { text: 'Accepted: not reported' }
            ]
            : [{ text: 'VTEP resource not read — its name is known from a CUDN or the Node annotation' }]),
        ...(discovered?.length
            ? [{
                text: !local
                    ? `Address on this node: ${discovered.join(', ')}`
                    : agrees
                        ? `Address on this node: ${discovered.join(', ')} — equals vxlan.local`
                        : `⚠ Address on this node: ${discovered.join(', ')} — but vxlan.local is ${local}`
            }]
            : [])
    ];

    const nameRule = device.how === 'hash'
        ? `${raw.name} is ${device.prefix} plus the first 8 hex digits of sha256("${vtepName}"), the form `
            + 'OVN-Kubernetes uses when the VTEP name does not fit in a 15-character interface name'
        : `${raw.name} is ${device.prefix} plus the VTEP name`;
    const using = getCudnsUsingVtep(vtepName, ctx.cudns);

    return [
        {
            label: 'VTEP',
            value: items,
            provenance: agrees ? 'declared' : 'inferred',
            hint: agrees
                ? `The Node's ${NODE_VTEPS_ANNOTATION} annotation records this device's vxlan.local as the address `
                    + `OVN-Kubernetes discovered for the VTEP. The device name agrees: ${nameRule}.`
                : `Matched by name: ${nameRule}. The naming is an OVN-Kubernetes implementation detail; `
                    + 'nothing in NodeNetworkState records the link.'
        },
        {
            label: 'EVPN Networks',
            value: using.map((cudn): FactItem => {
                const name = cudn.metadata?.name || 'Unknown';
                const vrfs = evpnVrfText(cudn.spec?.network?.evpn);
                return { text: vrfs ? `${name} — ${vrfs}` : name, ref: cudnRef(name) };
            }),
            provenance: 'declared',
            hint: 'CUDNs whose spec.network.evpn.vtep names this VTEP.',
            emptyText: 'No CUDN names this VTEP'
        }
    ];
};

/**
 * The network a per-network EVPN device belongs to (ovn-recon-s3t.53): the SVIs and
 * the OVS port are named after the CUDN, or after the network ID when the name does
 * not fit. The ID is resolved through the NetworkAttachmentDefinitions, so with none
 * loaded nothing can be said either way and no fact is emitted.
 */
const evpnNetworkFacts = (raw: Interface | undefined, ctx: GraphContext): Fact[] => {
    const device = findEvpnNetworkForDevice(raw?.name, ctx.cudns, ctx.udns, ctx.nads);
    if (!raw || !device) return [];
    if (!device.network && ctx.nads.length === 0 && device.how === 'network-id') return [];
    const { network, nad } = device;
    const vlanId = raw.vlan?.id;

    const items: FactItem[] = [
        ...(network
            ? [network.kind === 'cudn'
                ? { text: `CUDN ${network.name}`, ref: cudnRef(network.name) }
                : { text: `UDN ${network.namespace}/${network.name}`, ref: udnRef(network.namespace, network.name) }]
            : []),
        { text: `This device: ${EVPN_NETWORK_DEVICES[device.prefix]}` },
        ...(device.how === 'network-id' && nad
            ? [{ text: `Network ID ${device.key}: NetworkAttachmentDefinition ${nad.namespace}/${nad.name}`, ref: nadRef(nad.namespace, nad.name) }]
            : []),
        ...(device.ambiguous
            ? [{ text: `⚠ Network ID ${device.key} is claimed by ${device.ambiguous.join(' and ')} — matched to neither` }]
            : []),
        ...(!network && !device.ambiguous
            ? [{
                text: device.how === 'name'
                    ? `⚠ No CUDN is named ${device.key}`
                    : nad
                        ? `⚠ Network ID ${device.key} is carried by a NetworkAttachmentDefinition whose network is not known`
                        : `⚠ No NetworkAttachmentDefinition carries ${NETWORK_ID_ANNOTATION}: ${device.key}`
            }]
            : []),
        ...(network && device.vid != null && vlanId != null
            ? [{
                text: vlanId === device.vid
                    ? `VLAN ${vlanId} equals the vid in the network's EVPN config`
                    : `⚠ VLAN ${vlanId}, but the network's EVPN config assigns vid ${device.vid}`
            }]
            : [])
    ];

    return [{
        label: 'EVPN Network',
        value: items,
        provenance: 'inferred',
        hint: `Matched by name: OVN-Kubernetes names an EVPN network's devices ${Object.keys(EVPN_NETWORK_DEVICES).join(', ')} `
            + 'plus the CUDN name, or plus the network ID when that name does not fit in a 15-character interface '
            + `name. The ID is the ${NETWORK_ID_ANNOTATION} annotation on the network's NetworkAttachmentDefinition.`
    }];
};

/**
 * The ID in an mp<ID>-udn-vrf name, when it resolved to no Primary network
 * (ovn-recon-s3t.60). A leftover VRF otherwise reads the same as one nobody understood.
 */
const unresolvedVrfNetworkIdFacts = (unresolved: UnresolvedVrfNetworkId | undefined): Fact[] => {
    if (!unresolved) return [];
    const { networkId, reason, network, nad, ambiguous } = unresolved;

    const why = (): FactItem => {
        if (reason === 'ambiguous') {
            return { text: `⚠ Network ID ${networkId} is claimed by ${ambiguous?.join(' and ')} — matched to neither` };
        }
        if (reason === 'not-primary' && network) {
            return {
                text: `⚠ Network ID ${networkId} belongs to `
                    + (network.kind === 'cudn' ? `CUDN ${network.name}` : `UDN ${network.namespace}/${network.name}`)
                    + ', which is not a Primary Layer2 or Layer3 network and so has no VRF',
                ref: network.kind === 'cudn' ? cudnRef(network.name) : udnRef(network.namespace, network.name)
            };
        }
        if (reason === 'unknown-network' && nad) {
            return {
                text: `⚠ NetworkAttachmentDefinition ${nad.namespace}/${nad.name} carries that ID, `
                    + 'but the network it belongs to is not known',
                ref: nadRef(nad.namespace, nad.name)
            };
        }
        return { text: `⚠ No NetworkAttachmentDefinition carries ${NETWORK_ID_ANNOTATION}: ${networkId}` };
    };

    return [{
        label: 'Network ID',
        value: [{ text: `This VRF is named for network ID ${networkId}` }, why()],
        provenance: 'inferred',
        hint: 'OVN-Kubernetes names a Primary network\'s VRF mp<network ID>-udn-vrf when the network\'s name does not '
            + 'fit in a 15-character interface name, and always for a namespaced UDN. The ID is the '
            + `${NETWORK_ID_ANNOTATION} annotation on the network's NetworkAttachmentDefinitions. `
            + (reason === 'no-carrier'
                ? 'None of the NetworkAttachmentDefinitions visible to you carries this one, so the network was probably '
                    + 'deleted and this VRF left behind — or its NetworkAttachmentDefinitions are in namespaces you '
                    + 'cannot read.'
                : 'This VRF could not be matched to a Primary network through it.')
    }];
};

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
            if (raw?.type === 'vxlan' && raw?.vxlan) {
                // A VTEP. The VNI is per-device when set; 0 means the VNIs are mapped
                // per VLAN on the bridge this device is enslaved to, as EVPN does it.
                const vxlan = raw.vxlan;
                const items = [
                    { text: vxlan.id ? `VNI: ${vxlan.id}` : 'VNI: per-VLAN on the bridge (id 0)' },
                    ...(vxlan.local ? [{ text: `Local VTEP: ${vxlan.local}` }] : []),
                    ...(vxlan.remote ? [{ text: `Remote: ${vxlan.remote}` }] : []),
                    ...(vxlan['destination-port'] ? [{ text: `UDP port: ${vxlan['destination-port']}` }] : []),
                    ...(vxlan.learning != null ? [{ text: `MAC learning: ${vxlan.learning ? 'on' : 'off'}` }] : [])
                ];
                facts.push({ label: 'VXLAN', value: items, provenance: 'observed' });
            }
            if (raw?.type === 'bond') {
                // What kind of bond, and what the switch side has to match. An empty
                // list is omitted, so a bond reporting no link-aggregation adds nothing.
                facts.push({
                    label: 'Bond',
                    value: describeBond(raw).map((text) => ({ text })),
                    provenance: 'observed',
                    hint: 'link-aggregation in NodeNetworkState: the mode, the members and the options that mode '
                        + 'reads. The Config tab lists every bonding option.'
                });
            }
            // EVPN: which VTEP this device was created for, or which network it serves.
            facts.push(...evpnVtepFacts(raw, ctx), ...evpnNetworkFacts(raw, ctx));
            // A NIC says what it is before what it is addressed as (ovn-recon-s3t.62).
            // Every field here may be absent from a trimmed or older NodeNetworkState.
            const nic = raw?.type === 'ethernet' ? raw : undefined;
            if (nic) {
                if (typeof nic.driver === 'string' && nic.driver) {
                    facts.push({ label: 'Driver', value: nic.driver, provenance: 'observed' });
                }
                facts.push(...linkFacts(nic), ...sriovPfFacts(nic), ...sriovVfFacts(nic, ctx));
            }
            const macAddress = getMacAddress(raw);
            if (macAddress) {
                facts.push({ label: 'MAC Address', value: macAddress, provenance: 'observed' });
            }
            if (nic) {
                facts.push(...permanentMacFacts(nic, macAddress, ctx));
            }
            if (raw?.mtu) {
                // The ceiling is the NIC's own; on a virtual device it is only the kernel's.
                const maxMtu = nic?.['max-mtu'];
                facts.push({
                    label: 'MTU',
                    value: typeof maxMtu === 'number' && maxMtu > 0 ? `${raw.mtu} (max ${maxMtu})` : String(raw.mtu),
                    provenance: 'observed'
                });
            }
            const ipv4 = getIpv4Addresses(raw);
            if (ipv4.length > 0) {
                facts.push({ label: 'IPv4', value: ipv4.join(', '), provenance: 'observed' });
            }
            if (nic) {
                facts.push(...lldpFacts(nic), ...hardwareIdentityFacts(nic));
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
                    ? [{ label: 'Subnets', value: formatSubnets(subnets) || '-', provenance: 'declared' } as Fact]
                    : []),
                ...(vlanId
                    ? [{ label: 'VLAN ID', value: String(vlanId), provenance: 'declared' } as Fact]
                    : []),
                ...(physicalNetworkName
                    ? [{ label: 'Physical Network', value: physicalNetworkName, provenance: 'declared' } as Fact]
                    : []),
                // Beside Physical Network: for a Localnet CUDN this corroborates it.
                ...cudnPatchPortFacts(cudn, ctx),
                ...(network?.evpn
                    ? [{
                        label: 'EVPN',
                        value: [
                            ...(network.evpn.vtep
                                ? [{ text: `VTEP: ${network.evpn.vtep}`, ref: vtepRef(network.evpn.vtep) }]
                                : []),
                            ...(evpnVrfText(network.evpn) ? [{ text: evpnVrfText(network.evpn) }] : [])
                        ],
                        provenance: 'declared',
                        hint: 'spec.network.evpn: the VTEP whose VXLAN devices carry this network, and its VRFs.'
                    } as Fact]
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
                    ? [{ label: 'Subnets', value: formatSubnets(subnets) || '-', provenance: 'declared' } as Fact]
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

            const primary = findPrimaryNetworkForVrf(raw, ctx.cudns, ctx.udns, ctx.interfaces, ctx.nads);
            const created = 'This VRF was created by OVN-Kubernetes as a side effect of defining that Primary network. ';
            const corroborated = primary?.corroboration
                ? ` Port ${primary.corroboration.port} address ${primary.corroboration.address} lies inside its subnet ${primary.corroboration.subnet}.`
                : '';
            // A name that points at a network ID nothing resolves: say so, or a
            // leftover VRF reads the same as one nobody understood (ovn-recon-s3t.60).
            const unresolved = primary
                ? undefined
                : findUnresolvedVrfNetworkId(raw, ctx.cudns, ctx.udns, ctx.interfaces, ctx.nads);

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
                        // Strongest evidence first (ovn-recon-s3t.57): the network's own
                        // status is declared; an ID or a name on the VRF is convention.
                        provenance: primary.signals.includes('status') ? 'declared' : 'inferred',
                        hint: primary.signals.includes('status')
                            ? `${created}The network's status.vrfName names this VRF.${corroborated}`
                            : primary.signals.includes('network-id')
                                ? `${created}Matched by network ID: a network whose name does not fit in a 15-character `
                                    + `interface name gets a VRF named mp<network ID>-udn-vrf, and NetworkAttachmentDefinition `
                                    + `${primary.nad?.namespace}/${primary.nad?.name} carries ${NETWORK_ID_ANNOTATION}: `
                                    + `${primary.networkId}.${corroborated}`
                                : `${created}`
                                    + `Matched by ${primary.signals.join(' and ')}: a Primary Layer2 or Layer3 network gets a `
                                    + 'per-node VRF named after it (truncated to 15 characters), holding routes in the '
                                    + 'network\'s subnet. Localnet networks cannot be Primary.'
                    } as Fact]
                    : []),
                ...unresolvedVrfNetworkIdFacts(unresolved),
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
    'integration-bridge': {
        label: 'Integration Bridge',
        buildBadges: (node) => (node.isSynthetic ? ['synthetic', 'derived'] : []),
        facts: (node, ctx) => {
            const bridge = node.raw as IntegrationBridgeNode;
            const ports = bridge?.ports || [];
            const managementPorts = ports.filter((port) => port.name.startsWith('ovn-k8s-mp'));
            const patchPorts = ports.filter((port) => port.patch?.peer);
            const internalPort = ports.find((port) => port.name === bridge.name);

            // Which VRF, if any, each management port is enslaved into.
            const vrfByPort = new Map<string, string>();
            ctx.interfaces
                .filter((iface) => iface.type === 'vrf')
                .forEach((vrf) => {
                    const members = Array.isArray(vrf.vrf?.port)
                        ? vrf.vrf.port
                        : typeof vrf.vrf?.port === 'string' ? [vrf.vrf.port] : [];
                    members.forEach((member) => vrfByPort.set(member, vrf.name));
                });

            return [
                {
                    label: 'Type',
                    value: [{ text: node.subtitle, href: NNS_API }],
                    provenance: 'observed',
                    hint: 'OVN-Kubernetes attaches every pod and logical port here. nmstate reports '
                        + 'only its ports (state: ignore), so this node is derived from their controller fields.'
                },
                // With enactments present this correctly reads 'created by the
                // installer or OVN-Kubernetes' -- no NNCP ever claims br-int.
                ...configuredByFacts(getPoliciesClaimingInterface(bridge?.name || '', ctx.enactments), ctx),
                {
                    label: 'Management Ports',
                    value: managementPorts.map((port): FactItem => {
                        const addresses = getIpv4Addresses(port).join(', ');
                        const vrfName = vrfByPort.get(port.name);
                        const association = vrfName
                            ? ` — VRF ${vrfName}`
                            : (port.name === 'ovn-k8s-mp0' ? ' — default network' : '');
                        return { text: `${port.name}${addresses ? ` ${addresses}` : ''}${association}` };
                    }),
                    provenance: 'observed',
                    hint: 'One per network: ovn-k8s-mp0 serves the default cluster network, and each '
                        + 'Primary UDN/CUDN adds its own, enslaved into that network\'s VRF.',
                    emptyText: 'No management ports reported in NNS.'
                },
                {
                    label: 'Patch Ports',
                    value: patchPorts.map((port): FactItem => {
                        const peer = ctx.interfaces.find((iface) => iface.name === port.patch?.peer);
                        const provider = peer?.controller || peer?.master || 'unknown';
                        return { text: `${provider}: ${port.name} ↔ ${port.patch?.peer}` };
                    }),
                    provenance: 'observed',
                    hint: 'Reciprocal patch.peer pairs cable br-int to each provider bridge.',
                    emptyText: 'No patch ports reported in NNS.'
                },
                {
                    // Which network each pair is for -- including the unqualified one,
                    // which is the cluster default network's (ovn-recon-s3t.29).
                    label: 'Patched Networks',
                    value: getNetworkPatchPorts(ctx.interfaces).map((port) => patchedNetworkItem(port, ctx)),
                    provenance: 'inferred',
                    hint: 'Read out of the patch port names on the provider side: a pair naming no network is the '
                        + 'cluster default network\'s, <network>_ovn_localnet_port is a Localnet network\'s, and '
                        + PATCH_NAME_RULE
                },
                ...(internalPort
                    ? [{
                        label: 'Internal Port',
                        value: `${internalPort.name}${getIpv4Addresses(internalPort).length > 0
                            ? ` ${getIpv4Addresses(internalPort).join(', ')}` : ' (no address)'}`,
                        provenance: 'observed',
                        hint: 'The bridge\'s own OVS internal port, shown as an attribute rather '
                            + 'than a node (the rule from ovn-recon-s3t.26).'
                    } as Fact]
                    : [])
            ];
        }
    },
    other: {
        label: 'Other'
    }
};
