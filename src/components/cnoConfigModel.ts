import type { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import type {
    ClusterNetworkEntry,
    ClusterOperator,
    ClusterUserDefinedNetwork,
    ConfigMap,
    ConfigNetwork,
    FeatureGate,
    Infrastructure,
    NetworkAttachmentDefinition,
    NetworkMigration,
    OperatorCondition,
    OperatorNetwork,
    RouteAdvertisements,
    UserDefinedNetwork,
    Vtep,
} from '../types';
import { AppliedComparison, appliedNotice, compareAppliedSpec, gatewayModeNotice } from './cnoAppliedModel';
import { buildMasqueradeLayout, MasqueradeLayout } from './masqueradeLayoutModel';

/**
 * The cluster's network configuration as the Network config tab draws it
 * (ovn-recon-n7r.1). Pure: raw resources in, grouped rows out; it fetches nothing.
 *
 * Each row says where its value came from: `set` (in the spec), `default` (absent, so
 * the platform default applies), `reported` (read from a status, a ConfigMap or a
 * Node), or `unset` (absent, with no fixed default to quote). The Cluster Network
 * Operator writes some defaults back into the spec (mtu, genevePort,
 * policyAuditConfig), so `set` does not always mean somebody set it; those rows say so.
 *
 * Defaults are the API's "current default" text (openshift/api
 * operator/v1/types_network.go) and live in `DEFAULTS` alone, so a drift is a one-line
 * change. A field behind a feature gate (transport, noOverlayConfig, uplinkMode) is
 * absent on a cluster without the gate; absent always reads as the default.
 *
 * Every source degrades on its own: a resource the user may not read is named in
 * `sources`, and the rows that needed it are left out. The capability checklist
 * (`capabilities`, n7r.2) says which advanced features have their prerequisites, and
 * `applied` (n7r.5, `cnoAppliedModel.ts`) whether the operator has applied the spec. The
 * findings (n7r.3) are not here. The masquerade subnet's capacity and address layout
 * (`masquerade`, n7r.4) are built by `masqueradeLayoutModel.ts` from the model of
 * ovn-recon-2n6.1.
 */

// --- Sources -----------------------------------------------------------------------

export type SourceStatus = 'loading' | 'ok' | 'absent' | 'forbidden' | 'error';

export interface Source<T> {
    status: SourceStatus;
    data?: T;
    /** Why it could not be read, for `forbidden` and `error`. */
    message?: string;
}

const errorCode = (error: unknown): number | undefined => {
    const e = error as { code?: unknown; response?: { status?: unknown }; json?: { code?: unknown } };
    const code = [e?.code, e?.response?.status, e?.json?.code].find((value) => typeof value === 'number');
    return code as number | undefined;
};

const errorMessage = (error: unknown): string =>
    (error instanceof Error ? error.message : (error as { message?: string })?.message) || String(error);

/**
 * One watch's answer as a source. A 404 is `absent` (an optional ConfigMap that is not
 * there), a 401 or 403 `forbidden`; a loaded watch with no object is `absent` too.
 */
export const sourceOf = <T extends K8sResourceCommon>(data: unknown, loaded: boolean, error: unknown): Source<T> => {
    if (error) {
        const code = errorCode(error);
        if (code === 404) return { status: 'absent' };
        if (code === 401 || code === 403) return { status: 'forbidden', message: errorMessage(error) };
        return { status: 'error', message: errorMessage(error) };
    }
    if (!loaded) return { status: 'loading' };
    const isObject = data !== null && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length > 0;
    return isObject ? { status: 'ok', data: data as T } : { status: 'absent' };
};

export const CNO_NAMESPACE = 'openshift-network-operator';

/** The operator's optional ConfigMaps, by the id the model uses. */
export const CNO_CONFIG_MAPS = {
    appliedCluster: 'applied-cluster',
    mtu: 'mtu',
    overrides: 'ovn-kubernetes-config-overrides',
    gatewayMode: 'gateway-mode-config',
} as const;

export type CnoConfigMapId = keyof typeof CNO_CONFIG_MAPS;

export interface CnoConfigInputs {
    operatorNetwork: Source<OperatorNetwork>;
    configNetwork: Source<ConfigNetwork>;
    clusterOperator: Source<ClusterOperator>;
    featureGate: Source<FeatureGate>;
    infrastructure: Source<Infrastructure>;
    configMaps: Record<CnoConfigMapId, Source<ConfigMap>>;
    /** The Nodes the shell already watches, for the masquerade subnet in effect. */
    nodes: K8sResourceCommon[];
    /** The RouteAdvertisements the shell watches, for the capability checklist; absent reads as unknown. */
    routeAdvertisements?: RouteAdvertisements[];
    /** Every VTEP; undefined where the kind is not served or may not be listed. */
    vteps?: Vtep[];
    /**
     * The networks the shell watches, for the masquerade subnet's use (n7r.4): the NADs
     * carry the network IDs, and a CUDN or UDN is what makes the subnet unchangeable.
     */
    nads?: NetworkAttachmentDefinition[];
    cudns?: ClusterUserDefinedNetwork[];
    udns?: UserDefinedNetwork[];
}

const LOADING: Source<never> = { status: 'loading' };

/** Nothing answered yet: what a host shows before its watches settle, and what tests start from. */
export const NO_CNO_CONFIG_INPUTS: CnoConfigInputs = {
    operatorNetwork: LOADING,
    configNetwork: LOADING,
    clusterOperator: LOADING,
    featureGate: LOADING,
    infrastructure: LOADING,
    configMaps: { appliedCluster: LOADING, mtu: LOADING, overrides: LOADING, gatewayMode: LOADING },
    nodes: [],
};

export interface ResourceIdentity {
    apiVersion: string;
    kind: string;
    name: string;
    namespace?: string;
}

export const OPERATOR_NETWORK: ResourceIdentity = { apiVersion: 'operator.openshift.io/v1', kind: 'Network', name: 'cluster' };
export const CONFIG_NETWORK: ResourceIdentity = { apiVersion: 'config.openshift.io/v1', kind: 'Network', name: 'cluster' };
export const NETWORK_CLUSTER_OPERATOR: ResourceIdentity = { apiVersion: 'config.openshift.io/v1', kind: 'ClusterOperator', name: 'network' };
export const FEATURE_GATE: ResourceIdentity = { apiVersion: 'config.openshift.io/v1', kind: 'FeatureGate', name: 'cluster' };
export const INFRASTRUCTURE: ResourceIdentity = { apiVersion: 'config.openshift.io/v1', kind: 'Infrastructure', name: 'cluster' };
export const cnoConfigMap = (id: CnoConfigMapId): ResourceIdentity =>
    ({ apiVersion: 'v1', kind: 'ConfigMap', namespace: CNO_NAMESPACE, name: CNO_CONFIG_MAPS[id] });

/** The names rows use for where a value was read. */
export const SOURCE_LABELS = {
    operator: 'Network operator configuration',
    config: 'Cluster network configuration',
    clusterOperator: 'ClusterOperator network',
    featureGate: 'FeatureGate cluster',
    infrastructure: 'Infrastructure cluster',
    node: 'Node annotation',
} as const;

export interface SourceSummary {
    id: string;
    label: string;
    resource: ResourceIdentity;
    status: SourceStatus;
    /** One line for the user: "Read", "Not visible to you", ... */
    text: string;
    /** An optional ConfigMap: its absence is ordinary. */
    optional: boolean;
    message?: string;
}

const STATUS_TEXT: Record<SourceStatus, string> = {
    loading: 'Loading',
    ok: 'Read',
    absent: 'Not found',
    forbidden: 'Not visible to you',
    error: 'Could not be read',
};

// --- Defaults ----------------------------------------------------------------------

/** The platform defaults, as the API documents its "current default". */
export const DEFAULTS = {
    managementState: 'Managed',
    logLevel: 'Normal',
    joinSubnetV4: '100.64.0.0/16',
    joinSubnetV6: 'fd98::/64',
    transitSwitchSubnetV4: '100.88.0.0/16',
    transitSwitchSubnetV6: 'fd97::/64',
    masqueradeSubnetV4: '169.254.0.0/17',
    masqueradeSubnetV6: 'fd69::/112',
    transport: 'Geneve',
    genevePort: '6081',
    routingViaHost: 'false',
    ipForwarding: 'Restricted',
    uplinkMode: 'Required',
    routeAdvertisements: 'Disabled',
    ipsecMode: 'Disabled',
    ipsecEncapsulation: 'Auto',
    auditDestination: 'null',
    auditRateLimit: '20',
    auditMaxFileSize: '50',
    auditMaxLogFiles: '5',
    auditSyslogFacility: 'local0',
    bgpAsNumber: '64512',
    bgpTopology: 'FullMesh',
    egressIpReachabilityTimeout: '1',
    serviceNodePortRange: '30000-32767',
    falseByDefault: 'false',
    none: 'None',
} as const;

/** The gates the Cluster Network Operator reads when it renders OVN-Kubernetes. */
export const CNO_FEATURE_GATES = [
    'NoOverlayMode',
    'OVNKubernetesUplinkMode',
    'DNSNameResolver',
    'NetworkConnect',
    'OVNObservability',
    'MACSecurity',
] as const;

export const MASQUERADE_SUBNET_ANNOTATION = 'k8s.ovn.org/node-masquerade-subnet';

// --- Output ------------------------------------------------------------------------

export type RowOrigin = 'set' | 'default' | 'reported' | 'unset';

export interface ConfigRow {
    id: string;
    label: string;
    value: string;
    origin: RowOrigin;
    /** The resource the value was read from, by its `SOURCE_LABELS` name (or a ConfigMap's). */
    source: string;
    /** The field's path in that resource. */
    sourcePath: string;
    /** Why the value cannot be changed on a running cluster, when it cannot. */
    immutable?: string;
    note?: string;
}

export interface ConfigSection {
    id: string;
    title: string;
    rows: ConfigRow[];
    /** The kind whose API reference documents these fields. */
    docs: Pick<ResourceIdentity, 'apiVersion' | 'kind'>;
}

export interface SummaryChip {
    id: string;
    label: string;
    value: string;
}

export type ConditionSeverity = 'none' | 'info' | 'warning' | 'danger';

export interface ConditionRow {
    id: string;
    source: string;
    type: string;
    status: string;
    reason: string;
    message: string;
    lastTransitionTime?: string;
    severity: ConditionSeverity;
    /** What the severity says in words: "Progressing for 2 h". */
    note?: string;
}

export interface ConfigNotice {
    id: string;
    severity: 'info' | 'warning';
    title: string;
    body?: string;
}

export type PrerequisiteState = 'met' | 'unmet' | 'unknown';

/** One thing a feature needs, and whether the cluster has it. */
export interface Prerequisite {
    id: string;
    /** What is needed: "Route advertisements are Enabled". */
    label: string;
    state: PrerequisiteState;
    /** What the cluster has: the value read, or why it could not be. */
    actual: string;
    source: string;
    sourcePath: string;
}

/** `ready`: every prerequisite met. `unknown`: none unmet, but one could not be read. */
export type CapabilityStatus = 'ready' | 'not-ready' | 'unknown';

/** An advanced feature and what it needs (ovn-recon-n7r.2). */
export interface Capability {
    id: string;
    label: string;
    status: CapabilityStatus;
    /** "Prerequisites met", "2 of 5 prerequisites met". */
    statusText: string;
    prerequisites: Prerequisite[];
    /** What is known beyond the prerequisites: the resources that use the feature, a caveat. */
    notes: string[];
}

export interface CnoConfigModel {
    /** Every source and how reading it went; the view names the ones that are missing. */
    sources: SourceSummary[];
    /** No source has answered yet. */
    loading: boolean;
    /** Empty until the operator configuration or the cluster network configuration is read. */
    summary: SummaryChip[];
    notices: ConfigNotice[];
    /** The capability checklist; empty until the operator configuration is read. */
    capabilities: Capability[];
    sections: ConfigSection[];
    conditions: ConditionRow[];
    /** The spec against what the operator last applied (ovn-recon-n7r.5, `cnoAppliedModel.ts`). */
    applied: AppliedComparison;
    /** The masquerade subnet per family: source, capacity and address layout (ovn-recon-n7r.4). */
    masquerade: MasqueradeLayout;
}

// --- Helpers -----------------------------------------------------------------------

const OVN = 'spec.defaultNetwork.ovnKubernetesConfig';

const isSet = (value: unknown): boolean =>
    value !== undefined && value !== null && value !== '' && !(Array.isArray(value) && value.length === 0);

interface RowOptions {
    /** The platform default; without one an absent value reads "Not set". */
    fallback?: string;
    /** What an absent value with no fixed default reads as. */
    unsetText?: string;
    immutable?: string;
    note?: string;
    source?: string;
}

/** A spec field: `set` when present, else its default, else unset. */
const specRow = (id: string, label: string, sourcePath: string, value: unknown, options: RowOptions = {}): ConfigRow => {
    const { fallback, unsetText, immutable, note, source = SOURCE_LABELS.operator } = options;
    const base = { id, label, source, sourcePath, ...(immutable ? { immutable } : {}), ...(note ? { note } : {}) };
    if (isSet(value)) return { ...base, value: Array.isArray(value) ? value.join(', ') : String(value), origin: 'set' };
    if (fallback !== undefined) return { ...base, value: fallback, origin: 'default' };
    return { ...base, value: unsetText ?? 'Not set', origin: 'unset' };
};

/** A value read from a status, a ConfigMap or a Node. */
const reportedRow = (id: string, label: string, source: string, sourcePath: string, value: string, note?: string): ConfigRow =>
    ({ id, label, value, origin: 'reported', source, sourcePath, ...(note ? { note } : {}) });

const isV6 = (cidr: string | undefined): boolean => Boolean(cidr?.includes(':'));

const prefixLength = (cidr: string | undefined): number | undefined => {
    const length = Number(cidr?.split('/')[1]);
    return Number.isInteger(length) && length >= 0 ? length : undefined;
};

const count = (bits: number): string => (bits > 40 ? `2^${bits}` : String(2 ** bits));

/**
 * What a cluster network entry holds: one host subnet per node, so the entry's nodes
 * are 2^(hostPrefix - prefix); an IPv4 host subnet's size is the node's address count.
 */
export const clusterNetworkCapacity = ({ cidr, hostPrefix }: ClusterNetworkEntry): string | undefined => {
    const length = prefixLength(cidr);
    if (length === undefined || hostPrefix === undefined || hostPrefix < length) return undefined;
    const nodes = `Up to ${count(hostPrefix - length)} node subnets`;
    if (isV6(cidr) || hostPrefix > 32) return nodes;
    return `${nodes}, ${count(32 - hostPrefix)} addresses each`;
};

/** The distinct masquerade subnets the Nodes report, per family; the annotation is a JSON object. */
export const nodeMasqueradeSubnets = (nodes: K8sResourceCommon[]): { ipv4: string[]; ipv6: string[]; nodes: number } => {
    const ipv4 = new Set<string>();
    const ipv6 = new Set<string>();
    let reporting = 0;
    for (const node of nodes) {
        const raw = node.metadata?.annotations?.[MASQUERADE_SUBNET_ANNOTATION];
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw) as { ipv4?: unknown; ipv6?: unknown };
            if (typeof parsed?.ipv4 === 'string' && parsed.ipv4) ipv4.add(parsed.ipv4);
            if (typeof parsed?.ipv6 === 'string' && parsed.ipv6) ipv6.add(parsed.ipv6);
            reporting += 1;
        } catch {
            // An annotation that is not JSON says nothing.
        }
    }
    return { ipv4: [...ipv4].sort(), ipv6: [...ipv6].sort(), nodes: reporting };
};

const migrationText = (migration: NetworkMigration | undefined): string | undefined => {
    if (!migration || Object.keys(migration).length === 0) return undefined;
    const parts: string[] = [];
    if (migration.networkType) parts.push(`network type to ${migration.networkType}`);
    const { network, machine } = migration.mtu ?? {};
    if (network) parts.push(`cluster MTU ${network.from ?? '?'} to ${network.to ?? '?'}`);
    if (machine) parts.push(`machine MTU ${machine.from ?? '?'} to ${machine.to ?? '?'}`);
    if (migration.mode) parts.push(`mode ${migration.mode}`);
    const features = Object.entries(migration.features ?? {}).map(([name, on]) => `${name}: ${on}`);
    if (features.length > 0) parts.push(`features ${features.join(', ')}`);
    return parts.length > 0 ? parts.join('; ') : 'in progress';
};

/** Longer than this in Progressing=True is worth a warning. */
export const LONG_PROGRESSING_MS = 30 * 60 * 1000;

const duration = (ms: number): string => {
    const minutes = Math.floor(ms / 60000);
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} d`;
};

const conditionRow = (source: string, condition: OperatorCondition, now: number): ConditionRow => {
    const { type, status } = condition;
    let severity: ConditionSeverity = 'none';
    let note: string | undefined;
    if (/Degraded$/.test(type) && status === 'True') {
        severity = 'danger';
    } else if (/Available$/.test(type) && status === 'False') {
        severity = type === 'Available' ? 'danger' : 'warning';
    } else if (type === 'Upgradeable' && status === 'False') {
        severity = 'warning';
    } else if (type === 'Progressing' && status === 'True') {
        severity = 'info';
        const since = Date.parse(condition.lastTransitionTime ?? '');
        if (Number.isFinite(since) && now - since > LONG_PROGRESSING_MS) {
            severity = 'warning';
            note = `Progressing for ${duration(now - since)}`;
        }
    } else if (status === 'Unknown') {
        severity = 'info';
    }
    return {
        id: `${source}/${type}`,
        source,
        type,
        status,
        reason: condition.reason ?? '',
        message: condition.message ?? '',
        ...(condition.lastTransitionTime ? { lastTransitionTime: condition.lastTransitionTime } : {}),
        severity,
        ...(note ? { note } : {}),
    };
};

const SEVERITY_ORDER: Record<ConditionSeverity, number> = { danger: 0, warning: 1, info: 2, none: 3 };

const featureGateState = (featureGate: FeatureGate, version: string | undefined): Map<string, boolean> => {
    const entries = featureGate.status?.featureGates ?? [];
    const entry = entries.find((candidate) => version !== undefined && candidate.version === version) ?? entries[0];
    const state = new Map<string, boolean>();
    for (const gate of entry?.enabled ?? []) state.set(gate.name, true);
    for (const gate of entry?.disabled ?? []) state.set(gate.name, false);
    return state;
};

// --- Capabilities ------------------------------------------------------------------

const capability = (id: string, label: string, prerequisites: Prerequisite[], notes: (string | undefined)[] = []): Capability => {
    const met = prerequisites.filter((prerequisite) => prerequisite.state === 'met').length;
    const unmet = prerequisites.some((prerequisite) => prerequisite.state === 'unmet');
    const status: CapabilityStatus = met === prerequisites.length ? 'ready' : unmet ? 'not-ready' : 'unknown';
    const statusText = status === 'ready'
        ? 'Prerequisites met'
        : `${met} of ${prerequisites.length} prerequisite${prerequisites.length === 1 ? '' : 's'} met`;
    return { id, label, status, statusText, prerequisites, notes: notes.filter((note): note is string => Boolean(note)) };
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

const isAccepted = (resource: RouteAdvertisements): boolean => {
    const conditions = (resource as { status?: { conditions?: OperatorCondition[] } }).status?.conditions ?? [];
    return conditions.some((condition) => condition.type === 'Accepted' && condition.status === 'True');
};

/**
 * The checklist: one entry per advanced feature, each prerequisite met, unmet or
 * unknown with the value read and where. The rules are the API's own validation
 * (route advertisements need FRR; uplinkMode needs routingViaHost; NoOverlay needs
 * route advertisements) and the documented EVPN requirements. A prerequisite behind a
 * feature gate names the gate.
 */
const buildCapabilities = (
    inputs: CnoConfigInputs, operator: OperatorNetwork, gates: Map<string, boolean> | undefined, platform: string | undefined,
): Capability[] => {
    const spec = operator.spec;
    const ovn = spec?.defaultNetwork?.ovnKubernetesConfig;
    const gateway = ovn?.gatewayConfig;
    const operatorSource = SOURCE_LABELS.operator;

    const check = (id: string, label: string, sourcePath: string, met: boolean, actual: string): Prerequisite =>
        ({ id, label, state: met ? 'met' : 'unmet', actual, source: operatorSource, sourcePath });
    const gate = (name: string): Prerequisite => {
        const enabled = gates?.get(name);
        const base = { id: `gate-${name}`, label: `Feature gate ${name} is enabled`, source: SOURCE_LABELS.featureGate, sourcePath: 'status.featureGates' };
        if (gates === undefined) return { ...base, state: 'unknown', actual: 'The FeatureGate could not be read' };
        if (enabled === undefined) return { ...base, state: 'unmet', actual: 'Not listed in this release' };
        return { ...base, state: enabled ? 'met' : 'unmet', actual: enabled ? 'Enabled' : 'Disabled' };
    };

    const providers = spec?.additionalRoutingCapabilities?.providers ?? [];
    const advertisements = ovn?.routeAdvertisements ?? DEFAULTS.routeAdvertisements;
    const frr = check('frr-provider', 'FRR is a routing provider', 'spec.additionalRoutingCapabilities.providers',
        providers.includes('FRR'), providers.join(', ') || DEFAULTS.none);
    const advertisementsEnabled = check('route-advertisements-enabled', 'Route advertisements are Enabled',
        `${OVN}.routeAdvertisements`, advertisements === 'Enabled', advertisements);
    const routingViaHost = check('routing-via-host', 'Local gateway mode (routingViaHost is true)',
        `${OVN}.gatewayConfig.routingViaHost`, gateway?.routingViaHost === true, String(gateway?.routingViaHost ?? DEFAULTS.routingViaHost));
    const ipsecMode = ovn?.ipsecConfig?.mode ?? DEFAULTS.ipsecMode;
    const transport = ovn?.transport ?? DEFAULTS.transport;

    const resources = inputs.routeAdvertisements;
    const advertisementsNote = resources === undefined
        ? undefined
        : resources.length === 0
            ? 'No RouteAdvertisements resources exist'
            : `${plural(resources.length, 'RouteAdvertisements resource')}, ${resources.filter(isAccepted).length} accepted${
                advertisements === 'Enabled' ? '' : '; they are ignored while route advertisements are not Enabled'}`;

    const vteps = inputs.vteps;
    const vtepNote = vteps === undefined
        ? 'VTEPs could not be listed: the kind is not served here, or is not visible to you'
        : vteps.length === 0
            ? 'No VTEP resources exist'
            : `${plural(vteps.length, 'VTEP resource')}: ${vteps.map((vtep) => {
                const cidrs = (vtep.spec?.cidrs ?? []).join(', ') || 'no CIDRs';
                return `${vtep.metadata?.name ?? '?'} (${vtep.spec?.mode ?? 'mode not set'}; ${cidrs})`;
            }).join('; ')}`;

    const noOverlayRouting = ovn?.noOverlayConfig?.routing;
    const uplinkMode = gateway?.uplinkMode ?? DEFAULTS.uplinkMode;
    const hybrid = ovn?.hybridOverlayConfig;

    return [
        capability('route-advertisements', 'BGP route advertisements', [frr, advertisementsEnabled], [advertisementsNote]),
        capability('evpn', 'BGP EVPN on primary ClusterUserDefinedNetworks', [
            frr,
            advertisementsEnabled,
            routingViaHost,
            check('ip-forwarding-global', 'IP forwarding is Global', `${OVN}.gatewayConfig.ipForwarding`,
                gateway?.ipForwarding === 'Global', gateway?.ipForwarding ?? DEFAULTS.ipForwarding),
            platform === undefined
                ? {
                    id: 'platform-bare-metal', label: 'The platform is bare metal', state: 'unknown',
                    actual: 'The Infrastructure could not be read', source: SOURCE_LABELS.infrastructure, sourcePath: 'status.platformStatus.type',
                }
                : {
                    id: 'platform-bare-metal', label: 'The platform is bare metal', state: platform === 'BareMetal' ? 'met' : 'unmet',
                    actual: platform, source: SOURCE_LABELS.infrastructure, sourcePath: 'status.platformStatus.type',
                },
            check('ipsec-disabled', 'IPsec is Disabled', `${OVN}.ipsecConfig.mode`, ipsecMode === 'Disabled', ipsecMode),
        ], [vtepNote, 'EVPN does not support IPsec, EgressIP, Egress Service or multiple external gateways']),
        capability('no-overlay', 'No-overlay pod network', [
            gate('NoOverlayMode'),
            check('transport-no-overlay', 'Transport is NoOverlay', `${OVN}.transport`, transport === 'NoOverlay', transport),
            advertisementsEnabled,
            check('no-overlay-config', 'No-overlay configuration is set', `${OVN}.noOverlayConfig`, Boolean(ovn?.noOverlayConfig),
                ovn?.noOverlayConfig
                    ? `outboundSNAT ${ovn.noOverlayConfig.outboundSNAT ?? 'not set'}, routing ${noOverlayRouting ?? 'not set'}`
                    : 'Not set'),
            ...(noOverlayRouting === 'Managed'
                ? [check('bgp-managed-config', 'Managed BGP configuration is set (routing is Managed)', `${OVN}.bgpManagedConfig`,
                    Boolean(ovn?.bgpManagedConfig),
                    ovn?.bgpManagedConfig
                        ? `AS ${ovn.bgpManagedConfig.asNumber ?? DEFAULTS.bgpAsNumber}, ${ovn.bgpManagedConfig.bgpTopology ?? DEFAULTS.bgpTopology}`
                        : 'Not set')]
                : []),
        ], ['The transport is chosen at install and cannot be changed']),
        capability('uplink-optional', 'br-ex without an uplink', [
            gate('OVNKubernetesUplinkMode'),
            routingViaHost,
            check('uplink-mode-optional', 'Uplink mode is Optional', `${OVN}.gatewayConfig.uplinkMode`, uplinkMode === 'Optional', uplinkMode),
        ]),
        capability('multi-network-policy', 'MultiNetworkPolicy enforcement', [
            check('multi-network-enabled', 'Multi-network (Multus) is not disabled', 'spec.disableMultiNetwork',
                spec?.disableMultiNetwork !== true, String(spec?.disableMultiNetwork ?? false)),
            check('use-multi-network-policy', 'useMultiNetworkPolicy is true', 'spec.useMultiNetworkPolicy',
                spec?.useMultiNetworkPolicy === true, String(spec?.useMultiNetworkPolicy ?? false)),
        ], ['MultiNetworkPolicy resources are ignored until both are met']),
        capability('ipsec', 'IPsec encryption', [
            check('ipsec-mode', 'IPsec mode is Full or External', `${OVN}.ipsecConfig.mode`, ipsecMode === 'Full' || ipsecMode === 'External', ipsecMode),
        ], [
            ipsecMode === 'Full'
                ? `East-west and north-south; encapsulation ${ovn?.ipsecConfig?.full?.encapsulation ?? DEFAULTS.ipsecEncapsulation}`
                : ipsecMode === 'External' ? 'North-south only, configured on the hosts; pod traffic between nodes is not encrypted' : undefined,
            'Changing the mode rolls a MachineConfig out to every node',
        ]),
        capability('hybrid-overlay', 'Hybrid overlay (Windows nodes)', [
            check('hybrid-overlay-config', 'Hybrid overlay configuration is set', `${OVN}.hybridOverlayConfig`, Boolean(hybrid),
                hybrid ? (hybrid.hybridClusterNetwork ?? []).map((entry) => entry.cidr ?? '?').join(', ') || 'Set' : 'Not set'),
        ]),
    ];
};

// --- The model ---------------------------------------------------------------------

const sourceSummaries = (inputs: CnoConfigInputs): SourceSummary[] => {
    const one = (id: string, label: string, resource: ResourceIdentity, source: Source<unknown>, optional = false): SourceSummary => ({
        id,
        label,
        resource,
        status: source.status,
        text: optional && source.status === 'absent' ? 'Not present' : STATUS_TEXT[source.status],
        optional,
        ...(source.message ? { message: source.message } : {}),
    });
    return [
        one('operatorNetwork', SOURCE_LABELS.operator, OPERATOR_NETWORK, inputs.operatorNetwork),
        one('configNetwork', SOURCE_LABELS.config, CONFIG_NETWORK, inputs.configNetwork),
        one('clusterOperator', SOURCE_LABELS.clusterOperator, NETWORK_CLUSTER_OPERATOR, inputs.clusterOperator),
        one('featureGate', SOURCE_LABELS.featureGate, FEATURE_GATE, inputs.featureGate),
        one('infrastructure', SOURCE_LABELS.infrastructure, INFRASTRUCTURE, inputs.infrastructure),
        ...(Object.keys(CNO_CONFIG_MAPS) as CnoConfigMapId[]).map((id) =>
            one(`configMap:${id}`, `ConfigMap ${CNO_CONFIG_MAPS[id]}`, cnoConfigMap(id), inputs.configMaps[id], true)),
    ];
};

export const buildCnoConfigModel = (inputs: CnoConfigInputs, now: number = Date.now()): CnoConfigModel => {
    const operator = inputs.operatorNetwork.data;
    const config = inputs.configNetwork.data;
    const clusterOperator = inputs.clusterOperator.data;
    const featureGate = inputs.featureGate.data;
    const infrastructure = inputs.infrastructure.data;
    const spec = operator?.spec;
    const ovn = spec?.defaultNetwork?.ovnKubernetesConfig;
    const gateway = ovn?.gatewayConfig;

    const sources = sourceSummaries(inputs);
    const sections: ConfigSection[] = [];
    const notices: ConfigNotice[] = [];
    const operatorDocs = { apiVersion: OPERATOR_NETWORK.apiVersion, kind: OPERATOR_NETWORK.kind };
    const configDocs = { apiVersion: CONFIG_NETWORK.apiVersion, kind: CONFIG_NETWORK.kind };

    const networkType = spec?.defaultNetwork?.type ?? config?.status?.networkType ?? config?.spec?.networkType;
    const transport = ovn?.transport ?? DEFAULTS.transport;
    const localGateway = gateway?.routingViaHost === true;
    const providers = spec?.additionalRoutingCapabilities?.providers ?? [];
    const routeAdvertisements = ovn?.routeAdvertisements ?? DEFAULTS.routeAdvertisements;
    const ipsecMode = ovn?.ipsecConfig?.mode ?? DEFAULTS.ipsecMode;
    const clusterMtu = config?.status?.clusterNetworkMTU;

    // --- Summary -------------------------------------------------------------------
    const summary: SummaryChip[] = [];
    if (operator || config) {
        if (networkType) summary.push({ id: 'network-type', label: 'Network type', value: networkType });
        if (operator) {
            summary.push({ id: 'gateway-mode', label: 'Gateway mode', value: localGateway ? 'Local' : 'Shared' });
            summary.push({ id: 'transport', label: 'Transport', value: transport });
        }
        const mtu = clusterMtu ?? ovn?.mtu;
        if (mtu !== undefined) summary.push({ id: 'mtu', label: 'MTU', value: String(mtu) });
        if (operator) {
            summary.push({ id: 'ipsec', label: 'IPsec', value: ipsecMode });
            const routing = [
                ...providers,
                ...(routeAdvertisements === 'Enabled' ? ['route advertisements'] : []),
            ];
            summary.push({ id: 'routing', label: 'Routing', value: routing.length > 0 ? routing.join(' + ') : 'None' });
        }
    }

    // --- Notices -------------------------------------------------------------------
    const migration = migrationText(spec?.migration) ?? migrationText(config?.status?.migration);
    if (migration) {
        notices.push({ id: 'migration', severity: 'info', title: 'A network migration is in progress', body: migration });
    }
    if (operator && (spec?.managementState ?? DEFAULTS.managementState) !== DEFAULTS.managementState) {
        notices.push({
            id: 'management-state',
            severity: 'warning',
            title: `The network operator is ${spec?.managementState}`,
            body: 'It is not reconciling the cluster network, so what is configured here may not be what is running.',
        });
    }
    if (isSet(spec?.unsupportedConfigOverrides)) {
        notices.push({
            id: 'unsupported-overrides',
            severity: 'warning',
            title: 'Unsupported configuration overrides are set',
            body: `${SOURCE_LABELS.operator}: spec.unsupportedConfigOverrides`,
        });
    }
    if (inputs.configMaps.overrides.status === 'ok') {
        const keys = Object.keys(inputs.configMaps.overrides.data?.data ?? {});
        notices.push({
            id: 'overrides-configmap',
            severity: 'warning',
            title: `Hidden OVN-Kubernetes overrides are present (ConfigMap ${CNO_CONFIG_MAPS.overrides})`,
            body: keys.length > 0 ? `Keys: ${keys.join(', ')}` : undefined,
        });
    }
    const gatewayMode = gatewayModeNotice(inputs.configMaps.gatewayMode, operator ? gateway?.routingViaHost === true : undefined);
    if (gatewayMode) notices.push(gatewayMode);
    const applied = compareAppliedSpec(inputs.operatorNetwork, inputs.configMaps.appliedCluster);
    const appliedWarning = appliedNotice(applied);
    if (appliedWarning) notices.push(appliedWarning);

    // --- Sections from the operator configuration ----------------------------------
    // Known only from the operator configuration; without it the masquerade layout
    // draws what the Nodes report.
    let ipFamilies: { ipv4: boolean; ipv6: boolean } | undefined;
    if (operator) {
        const clusterNetwork = spec?.clusterNetwork ?? [];
        const cidrs = [...clusterNetwork.map((entry) => entry.cidr), ...(spec?.serviceNetwork ?? [])];
        const hasV4 = cidrs.some((cidr) => cidr && !isV6(cidr)) || cidrs.length === 0;
        const hasV6 = cidrs.some(isV6);
        const families = hasV4 && hasV6 ? 'Dual stack (IPv4 and IPv6)' : hasV6 ? 'IPv6' : 'IPv4';
        ipFamilies = { ipv4: hasV4, ipv6: hasV6 };
        const masquerade = nodeMasqueradeSubnets(inputs.nodes);

        const addressing: ConfigRow[] = [
            specRow('network-type', 'Network plugin', 'spec.defaultNetwork.type', spec?.defaultNetwork?.type, {
                immutable: 'Changed only through a network type migration',
            }),
            ...clusterNetwork.map((entry, index) => specRow(
                `cluster-network-${index}`,
                'Cluster network',
                `spec.clusterNetwork[${index}]`,
                entry.cidr ? `${entry.cidr}, host prefix /${entry.hostPrefix ?? '?'}` : undefined,
                { note: clusterNetworkCapacity(entry) },
            )),
            ...(clusterNetwork.length === 0 ? [specRow('cluster-network', 'Cluster network', 'spec.clusterNetwork', undefined)] : []),
            specRow('service-network', 'Service network', 'spec.serviceNetwork', spec?.serviceNetwork),
            reportedRow('ip-families', 'IP families', SOURCE_LABELS.operator, 'spec.clusterNetwork, spec.serviceNetwork', families),
        ];
        const perFamily = (
            family: 'ipv4' | 'ipv6', show: boolean, defaults: { join: string; transit: string; masquerade: string },
        ) => {
            const name = family === 'ipv4' ? 'IPv4' : 'IPv6';
            const ip = ovn?.[family];
            const configured = gateway?.[family]?.internalMasqueradeSubnet;
            const reported = masquerade[family];
            if (!show && !ip?.internalJoinSubnet && !ip?.internalTransitSwitchSubnet && !configured && reported.length === 0) return;
            addressing.push(
                specRow(`join-subnet-${family}`, `Join subnet (${name})`, `${OVN}.${family}.internalJoinSubnet`, ip?.internalJoinSubnet, {
                    fallback: defaults.join,
                }),
                specRow(
                    `transit-switch-subnet-${family}`,
                    `Transit switch subnet (${name})`,
                    `${OVN}.${family}.internalTransitSwitchSubnet`,
                    ip?.internalTransitSwitchSubnet,
                    { fallback: defaults.transit, note: 'Holds one address per node' },
                ),
                specRow(
                    `masquerade-subnet-${family}`,
                    `Masquerade subnet (${name})`,
                    `${OVN}.gatewayConfig.${family}.internalMasqueradeSubnet`,
                    configured,
                    {
                        fallback: defaults.masquerade,
                        note: configured
                            ? undefined
                            : 'The default for a new cluster; an upgraded cluster keeps the subnet it was installed with. '
                                + 'Capacity and address layout are under Masquerade subnet',
                        immutable: 'Cannot be changed once a user-defined network exists',
                    },
                ),
            );
            if (reported.length > 0) {
                addressing.push(reportedRow(
                    `masquerade-subnet-effective-${family}`,
                    `Masquerade subnet in effect (${name})`,
                    SOURCE_LABELS.node,
                    MASQUERADE_SUBNET_ANNOTATION,
                    reported.join(', '),
                    reported.length > 1
                        ? 'Nodes disagree'
                        : `Reported by ${masquerade.nodes} node${masquerade.nodes === 1 ? '' : 's'}`,
                ));
            }
        };
        perFamily('ipv4', hasV4, { join: DEFAULTS.joinSubnetV4, transit: DEFAULTS.transitSwitchSubnetV4, masquerade: DEFAULTS.masqueradeSubnetV4 });
        perFamily('ipv6', hasV6, { join: DEFAULTS.joinSubnetV6, transit: DEFAULTS.transitSwitchSubnetV6, masquerade: DEFAULTS.masqueradeSubnetV6 });
        const deprecated = 'Deprecated: use the join subnet field';
        if (ovn?.v4InternalSubnet) addressing.push(specRow('v4-internal-subnet', 'v4InternalSubnet', `${OVN}.v4InternalSubnet`, ovn.v4InternalSubnet, { note: deprecated }));
        if (ovn?.v6InternalSubnet) addressing.push(specRow('v6-internal-subnet', 'v6InternalSubnet', `${OVN}.v6InternalSubnet`, ovn.v6InternalSubnet, { note: deprecated }));
        sections.push({ id: 'addressing', title: 'Plugin and addressing', rows: addressing, docs: operatorDocs });

        // Overlay and transport
        const writtenBack = 'The operator writes this into the spec, so it reads as set even when nobody set it';
        const overlay: ConfigRow[] = [
            specRow('transport', 'Transport', `${OVN}.transport`, ovn?.transport, {
                fallback: DEFAULTS.transport,
                immutable: 'Set at install only',
                note: 'NoOverlay needs the NoOverlayMode feature gate',
            }),
            specRow('geneve-port', 'Geneve port', `${OVN}.genevePort`, ovn?.genevePort, {
                fallback: DEFAULTS.genevePort,
                immutable: 'The operator refuses a change',
                note: ovn?.genevePort !== undefined ? writtenBack : undefined,
            }),
            specRow('mtu', 'MTU', `${OVN}.mtu`, ovn?.mtu, {
                unsetText: 'Left to the operator (host MTU less the encapsulation overhead)',
                immutable: 'Changed only through an MTU migration (spec.migration.mtu)',
                note: ovn?.mtu !== undefined ? writtenBack : undefined,
            }),
        ];
        if (clusterMtu !== undefined) {
            overlay.push(reportedRow(
                'cluster-mtu', 'Cluster network MTU in effect', SOURCE_LABELS.config, 'status.clusterNetworkMTU', String(clusterMtu),
                ovn?.mtu !== undefined && ovn.mtu !== clusterMtu ? `Differs from the configured MTU (${ovn.mtu})` : undefined,
            ));
        }
        const probedMtu = inputs.configMaps.mtu.data?.data?.mtu;
        if (probedMtu) {
            overlay.push(reportedRow('host-mtu', 'Probed host MTU', `ConfigMap ${CNO_CONFIG_MAPS.mtu}`, 'data.mtu', probedMtu));
        }
        const noOverlay = transport === 'NoOverlay';
        if (noOverlay || ovn?.noOverlayConfig) {
            overlay.push(
                specRow('no-overlay-snat', 'No-overlay outbound SNAT', `${OVN}.noOverlayConfig.outboundSNAT`, ovn?.noOverlayConfig?.outboundSNAT),
                specRow('no-overlay-routing', 'No-overlay routing', `${OVN}.noOverlayConfig.routing`, ovn?.noOverlayConfig?.routing, {
                    immutable: 'Cannot be changed once set',
                }),
            );
        }
        if (noOverlay || ovn?.bgpManagedConfig) {
            overlay.push(
                specRow('bgp-as-number', 'Managed BGP AS number', `${OVN}.bgpManagedConfig.asNumber`, ovn?.bgpManagedConfig?.asNumber, {
                    fallback: DEFAULTS.bgpAsNumber,
                }),
                specRow('bgp-topology', 'Managed BGP topology', `${OVN}.bgpManagedConfig.bgpTopology`, ovn?.bgpManagedConfig?.bgpTopology, {
                    fallback: DEFAULTS.bgpTopology,
                }),
            );
        }
        sections.push({ id: 'overlay', title: 'Overlay and transport', rows: overlay, docs: operatorDocs });

        // Gateway
        sections.push({
            id: 'gateway',
            title: 'Gateway',
            docs: operatorDocs,
            rows: [
                specRow('routing-via-host', 'Route through the host (routingViaHost)', `${OVN}.gatewayConfig.routingViaHost`, gateway?.routingViaHost, {
                    fallback: DEFAULTS.routingViaHost,
                    note: localGateway
                        ? 'Local gateway mode: egress goes through the host network stack; rules out hardware offload'
                        : 'Shared gateway mode: egress leaves OVN straight through br-ex',
                }),
                specRow('ip-forwarding', 'IP forwarding', `${OVN}.gatewayConfig.ipForwarding`, gateway?.ipForwarding, {
                    fallback: DEFAULTS.ipForwarding,
                }),
                specRow('uplink-mode', 'Uplink mode', `${OVN}.gatewayConfig.uplinkMode`, gateway?.uplinkMode, {
                    fallback: DEFAULTS.uplinkMode,
                    note: 'Optional needs the OVNKubernetesUplinkMode feature gate and routingViaHost',
                }),
            ],
        });

        // Routing
        sections.push({
            id: 'routing',
            title: 'Routing',
            docs: operatorDocs,
            rows: [
                specRow('routing-providers', 'Additional routing providers', 'spec.additionalRoutingCapabilities.providers', providers, {
                    fallback: DEFAULTS.none,
                    note: providers.includes('FRR') ? 'FRR deploys frr-k8s into openshift-frr-k8s' : undefined,
                }),
                specRow('route-advertisements', 'Route advertisements', `${OVN}.routeAdvertisements`, ovn?.routeAdvertisements, {
                    fallback: DEFAULTS.routeAdvertisements,
                    note: routeAdvertisements === 'Enabled'
                        ? 'Also turns on the EVPN components'
                        : 'RouteAdvertisements resources do nothing while this is Disabled; Enabled needs the FRR provider',
                }),
            ],
        });

        // Security
        const audit = ovn?.policyAuditConfig;
        const security: ConfigRow[] = [
            specRow('ipsec-mode', 'IPsec mode', `${OVN}.ipsecConfig.mode`, ovn?.ipsecConfig?.mode, { fallback: DEFAULTS.ipsecMode }),
        ];
        if (ipsecMode === 'Full' || ovn?.ipsecConfig?.full) {
            security.push(specRow('ipsec-encapsulation', 'IPsec encapsulation', `${OVN}.ipsecConfig.full.encapsulation`, ovn?.ipsecConfig?.full?.encapsulation, {
                fallback: DEFAULTS.ipsecEncapsulation,
            }));
        }
        const auditNote = audit ? writtenBack : undefined;
        security.push(
            specRow('audit-destination', 'Policy audit destination', `${OVN}.policyAuditConfig.destination`, audit?.destination, { fallback: DEFAULTS.auditDestination, note: auditNote }),
            specRow('audit-rate-limit', 'Policy audit rate limit (messages per second)', `${OVN}.policyAuditConfig.rateLimit`, audit?.rateLimit, { fallback: DEFAULTS.auditRateLimit }),
            specRow('audit-max-file-size', 'Policy audit maximum file size (MB)', `${OVN}.policyAuditConfig.maxFileSize`, audit?.maxFileSize, { fallback: DEFAULTS.auditMaxFileSize }),
            specRow('audit-max-log-files', 'Policy audit maximum log files', `${OVN}.policyAuditConfig.maxLogFiles`, audit?.maxLogFiles, { fallback: DEFAULTS.auditMaxLogFiles }),
            specRow('audit-syslog-facility', 'Policy audit syslog facility', `${OVN}.policyAuditConfig.syslogFacility`, audit?.syslogFacility, { fallback: DEFAULTS.auditSyslogFacility }),
        );
        sections.push({ id: 'security', title: 'Security', rows: security, docs: operatorDocs });

        // Multi-network
        const additional = spec?.additionalNetworks ?? [];
        sections.push({
            id: 'multi-network',
            title: 'Multi-network',
            docs: operatorDocs,
            rows: [
                specRow('disable-multi-network', 'Disable multi-network (Multus)', 'spec.disableMultiNetwork', spec?.disableMultiNetwork, {
                    fallback: DEFAULTS.falseByDefault,
                    note: spec?.disableMultiNetwork ? 'No NetworkAttachmentDefinitions or secondary networks' : undefined,
                }),
                specRow('use-multi-network-policy', 'MultiNetworkPolicy enforcement', 'spec.useMultiNetworkPolicy', spec?.useMultiNetworkPolicy, {
                    fallback: DEFAULTS.falseByDefault,
                }),
                specRow(
                    'additional-networks',
                    'Additional networks (legacy)',
                    'spec.additionalNetworks',
                    additional.map((network) => `${network.namespace ? `${network.namespace}/` : ''}${network.name ?? '?'} (${network.type ?? '?'})`),
                    { fallback: DEFAULTS.none },
                ),
            ],
        });

        // Egress and other
        const flows = spec?.exportNetworkFlows;
        const flowTargets = [
            ...(flows?.netFlow?.collectors?.length ? [`NetFlow: ${flows.netFlow.collectors.join(', ')}`] : []),
            ...(flows?.sFlow?.collectors?.length ? [`sFlow: ${flows.sFlow.collectors.join(', ')}`] : []),
            ...(flows?.ipfix?.collectors?.length ? [`IPFIX: ${flows.ipfix.collectors.join(', ')}`] : []),
        ];
        const hybrid = ovn?.hybridOverlayConfig;
        const hybridText = hybrid
            ? [
                ...(hybrid.hybridClusterNetwork ?? []).map((entry) => `${entry.cidr ?? '?'}, host prefix /${entry.hostPrefix ?? '?'}`),
                ...(hybrid.hybridOverlayVXLANPort !== undefined ? [`VXLAN port ${hybrid.hybridOverlayVXLANPort}`] : []),
            ].join('; ') || 'Configured'
            : undefined;
        const other: ConfigRow[] = [
            specRow('egress-ip-timeout', 'EgressIP reachability timeout (seconds)', `${OVN}.egressIPConfig.reachabilityTotalTimeoutSeconds`, ovn?.egressIPConfig?.reachabilityTotalTimeoutSeconds, {
                fallback: DEFAULTS.egressIpReachabilityTimeout,
            }),
            specRow('hybrid-overlay', 'Hybrid overlay (Windows nodes)', `${OVN}.hybridOverlayConfig`, hybridText, {
                unsetText: 'Not configured',
                immutable: 'The operator refuses a change',
            }),
            specRow('deploy-kube-proxy', 'Deploy kube-proxy', 'spec.deployKubeProxy', spec?.deployKubeProxy, { fallback: DEFAULTS.falseByDefault }),
            ...(spec?.kubeProxyConfig && Object.keys(spec.kubeProxyConfig).length > 0
                ? [specRow('kube-proxy-config', 'kube-proxy configuration', 'spec.kubeProxyConfig', Object.keys(spec.kubeProxyConfig))]
                : []),
            specRow('export-network-flows', 'Export network flows', 'spec.exportNetworkFlows', flowTargets, { fallback: DEFAULTS.none }),
            specRow('disable-network-diagnostics', 'Disable network diagnostics', 'spec.disableNetworkDiagnostics', spec?.disableNetworkDiagnostics, {
                fallback: DEFAULTS.falseByDefault,
            }),
        ];
        sections.push({ id: 'other', title: 'Egress and other', rows: other, docs: operatorDocs });
    }

    // --- Cluster network configuration ----------------------------------------------
    if (config) {
        const external = config.spec?.externalIP;
        const externalText = external
            ? [
                ...(external.policy?.allowedCIDRs?.length ? [`allowed ${external.policy.allowedCIDRs.join(', ')}`] : []),
                ...(external.policy?.rejectedCIDRs?.length ? [`rejected ${external.policy.rejectedCIDRs.join(', ')}`] : []),
                ...(external.autoAssignCIDRs?.length ? [`auto-assign ${external.autoAssignCIDRs.join(', ')}`] : []),
            ].join('; ') || 'No CIDRs allowed (external IPs are refused)'
            : undefined;
        const source = SOURCE_LABELS.config;
        sections.push({
            id: 'cluster-config',
            title: 'Cluster network configuration',
            docs: configDocs,
            rows: [
                ...(config.status?.networkType
                    ? [reportedRow('status-network-type', 'Network type in effect', source, 'status.networkType', config.status.networkType)]
                    : []),
                specRow('service-node-port-range', 'Service node port range', 'spec.serviceNodePortRange', config.spec?.serviceNodePortRange, {
                    fallback: DEFAULTS.serviceNodePortRange, source,
                }),
                specRow('external-ip', 'External IP policy', 'spec.externalIP', externalText, { unsetText: 'Not set (external IPs are refused)', source }),
                specRow('network-diagnostics', 'Network diagnostics mode', 'spec.networkDiagnostics.mode', config.spec?.networkDiagnostics?.mode, {
                    unsetText: 'Left to the platform', source,
                }),
                specRow('network-observability', 'Network observability installation', 'spec.networkObservability.installationPolicy', config.spec?.networkObservability?.installationPolicy, {
                    unsetText: 'Left to the platform', source,
                }),
            ],
        });
    }

    // --- Operator, platform and feature gates ---------------------------------------
    const operatorRows: ConfigRow[] = [];
    if (operator) {
        operatorRows.push(
            specRow('management-state', 'Management state', 'spec.managementState', spec?.managementState, { fallback: DEFAULTS.managementState }),
            specRow('log-level', 'Log level', 'spec.logLevel', spec?.logLevel, { fallback: DEFAULTS.logLevel }),
            specRow('operator-log-level', 'Operator log level', 'spec.operatorLogLevel', spec?.operatorLogLevel, { fallback: DEFAULTS.logLevel }),
            specRow('unsupported-config-overrides', 'Unsupported configuration overrides', 'spec.unsupportedConfigOverrides',
                isSet(spec?.unsupportedConfigOverrides) ? 'Set' : undefined, { fallback: DEFAULTS.none }),
        );
        if (applied.status !== 'loading') {
            operatorRows.push(reportedRow(
                'applied-configuration', 'Applied configuration', `ConfigMap ${CNO_CONFIG_MAPS.appliedCluster}`, 'data.applied', applied.text,
                applied.status === 'differs' ? 'A change was refused or is still pending' : undefined,
            ));
        }
        if (operator.status?.version) {
            operatorRows.push(reportedRow('operator-version', 'Applied version', SOURCE_LABELS.operator, 'status.version', operator.status.version));
        }
    }
    const operatorVersion = clusterOperator?.status?.versions?.find((version) => version.name === 'operator')?.version;
    if (operatorVersion) {
        operatorRows.push(reportedRow('cluster-operator-version', 'Operator version', SOURCE_LABELS.clusterOperator, 'status.versions', operatorVersion));
    }
    const platform = infrastructure?.status?.platformStatus?.type ?? infrastructure?.status?.platform;
    if (platform) {
        operatorRows.push(reportedRow('platform', 'Platform', SOURCE_LABELS.infrastructure, 'status.platformStatus.type', platform));
    }
    if (operatorRows.length > 0) {
        sections.push({ id: 'operator', title: 'Operator and platform', rows: operatorRows, docs: operatorDocs });
    }

    const gates = featureGate ? featureGateState(featureGate, operatorVersion ?? operator?.status?.version) : undefined;
    const capabilities = operator ? buildCapabilities(inputs, operator, gates, platform) : [];

    if (featureGate) {
        const state = gates ?? new Map<string, boolean>();
        const source = SOURCE_LABELS.featureGate;
        sections.push({
            id: 'feature-gates',
            title: 'Feature gates the network operator reads',
            docs: { apiVersion: FEATURE_GATE.apiVersion, kind: FEATURE_GATE.kind },
            rows: [
                specRow('feature-set', 'Feature set', 'spec.featureSet', featureGate.spec?.featureSet, {
                    fallback: 'Default', source, immutable: 'A non-default feature set cannot be undone',
                }),
                ...CNO_FEATURE_GATES.map((name) => {
                    const enabled = state.get(name);
                    return reportedRow(
                        `gate-${name}`, name, source, 'status.featureGates',
                        enabled === undefined ? 'Not listed in this release' : enabled ? 'Enabled' : 'Disabled',
                    );
                }),
            ],
        });
    }

    // --- Conditions ----------------------------------------------------------------
    const conditions = [
        ...(clusterOperator?.status?.conditions ?? []).map((condition) => conditionRow(SOURCE_LABELS.clusterOperator, condition, now)),
        ...(operator?.status?.conditions ?? []).map((condition) => conditionRow(SOURCE_LABELS.operator, condition, now)),
        ...(config?.status?.conditions ?? []).map((condition) => conditionRow(SOURCE_LABELS.config, condition, now)),
    ];
    // Stable: what needs attention first, otherwise as the resources list them.
    const ordered = conditions
        .map((condition, index) => ({ condition, index }))
        .sort((a, b) => SEVERITY_ORDER[a.condition.severity] - SEVERITY_ORDER[b.condition.severity] || a.index - b.index)
        .map(({ condition }) => condition);

    return {
        sources,
        loading: sources.every((source) => source.status === 'loading'),
        summary,
        notices,
        capabilities,
        sections,
        conditions: ordered,
        applied,
        masquerade: buildMasqueradeLayout({
            families: ipFamilies,
            configured: {
                ipv4: gateway?.ipv4?.internalMasqueradeSubnet,
                ipv6: gateway?.ipv6?.internalMasqueradeSubnet,
            },
            nodes: inputs.nodes,
            nads: inputs.nads,
            cudns: inputs.cudns,
            udns: inputs.udns,
        }),
    };
};
