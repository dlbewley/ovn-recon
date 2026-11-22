import { CNO_NAMESPACE, CnoConfigInputs, Prerequisite, SOURCE_LABELS } from '../components/cnoConfigModel';
import type { ClusterMtu } from '../topology/context';
import type { ClusterUserDefinedNetwork, NetworkMigration, OperatorNetwork, RouteAdvertisements, Vtep } from '../types';
import { operatorNetworkRef } from './masquerade';
import { sameRef } from './refs';
import type { ClusterNetworkConfig, Evidence, K8sRef } from './types';

/**
 * What the Cluster Network Operator rules (ovn-recon-n7r.3) share. Pure. The
 * configuration itself is modelled in src/components/cnoConfigModel.ts; where its
 * capability checklist already says whether a prerequisite is met, the rules read
 * that answer rather than working it out again.
 */

export { operatorNetworkRef };

export const configNetworkRef: K8sRef = { group: 'config.openshift.io', version: 'v1', kind: 'Network', name: 'cluster' };

export const networkClusterOperatorRef: K8sRef = {
    group: 'config.openshift.io', version: 'v1', kind: 'ClusterOperator', name: 'network'
};

export const cnoConfigMapRef = (name: string): K8sRef =>
    ({ group: '', version: 'v1', kind: 'ConfigMap', namespace: CNO_NAMESPACE, name });

export const routeAdvertisementsRef = (resource: RouteAdvertisements): K8sRef => ({
    group: 'k8s.ovn.org', version: 'v1', kind: 'RouteAdvertisements', name: resource.metadata?.name || ''
});

export const vtepRef = (vtep: Vtep): K8sRef =>
    ({ group: 'k8s.ovn.org', version: 'v1', kind: 'VTEP', name: vtep.metadata?.name || '' });

/** The objects the Network config tab draws, which a finding about them links to. */
export const isNetworkConfigRef = (ref: K8sRef): boolean =>
    [operatorNetworkRef, configNetworkRef, networkClusterOperatorRef].some((candidate) => sameRef(candidate, ref));

/** The operator configuration, once it has been read. */
export const readOperator = (config: ClusterNetworkConfig | undefined): OperatorNetwork | undefined =>
    (config?.sources.operatorNetwork.status === 'ok' ? config.sources.operatorNetwork.data : undefined);

/** One prerequisite of one capability on the checklist. */
export const prerequisite = (
    config: ClusterNetworkConfig | undefined, capabilityId: string, prerequisiteId: string
): Prerequisite | undefined =>
    config?.model.capabilities
        .find((capability) => capability.id === capabilityId)
        ?.prerequisites.find((candidate) => candidate.id === prerequisiteId);

/** The named prerequisites of a capability that the checklist reports unmet, in the order asked. */
export const unmetPrerequisites = (
    config: ClusterNetworkConfig | undefined, capabilityId: string, prerequisiteIds: readonly string[]
): Prerequisite[] =>
    prerequisiteIds
        .map((id) => prerequisite(config, capabilityId, id))
        .filter((candidate): candidate is Prerequisite => candidate?.state === 'unmet');

const SOURCE_REFS: Record<string, K8sRef> = {
    [SOURCE_LABELS.operator]: operatorNetworkRef,
    [SOURCE_LABELS.config]: configNetworkRef,
    [SOURCE_LABELS.clusterOperator]: networkClusterOperatorRef,
    [SOURCE_LABELS.featureGate]: { group: 'config.openshift.io', version: 'v1', kind: 'FeatureGate', name: 'cluster' },
    [SOURCE_LABELS.infrastructure]: { group: 'config.openshift.io', version: 'v1', kind: 'Infrastructure', name: 'cluster' }
};

/** The object a checklist or condition row's source label names. */
export const refForSource = (label: string): K8sRef => SOURCE_REFS[label] ?? operatorNetworkRef;

/** Evidence that one prerequisite is not met: what is needed, and what was read. */
export const unmetEvidence = (unmet: Prerequisite): Evidence => ({
    fact: `Not met: ${unmet.label}. The cluster has ${unmet.actual}.`,
    sources: [refForSource(unmet.source)],
    path: unmet.sourcePath
});

/**
 * The ClusterUserDefinedNetworks carried over EVPN: those that declare
 * `spec.network.evpn`, or name EVPN as their transport. A UserDefinedNetwork has no
 * EVPN field in the API this plugin reads.
 */
export const evpnCudns = (cudns: readonly ClusterUserDefinedNetwork[]): ClusterUserDefinedNetwork[] =>
    cudns.filter((cudn) => Boolean(cudn.spec?.network?.evpn) || cudn.spec?.network?.transport === 'EVPN');

/** The field that shows a CUDN is carried over EVPN. */
export const evpnPath = (cudn: ClusterUserDefinedNetwork): string =>
    (cudn.spec?.network?.evpn ? 'spec.network.evpn' : 'spec.network.transport');

const migrating = (migration: NetworkMigration['mtu'] | undefined): boolean =>
    Boolean(migration && Object.keys(migration).length > 0);

/** What OVN-Kubernetes' Geneve encapsulation adds to a pod's packet, as the MTU docs state it. */
export const GENEVE_OVERHEAD = 100;
/** What IPsec adds on top, when pod traffic between nodes is encrypted (mode Full). */
export const IPSEC_OVERHEAD = 46;

/**
 * The cluster network MTU and the encapsulation overhead the uplinks must carry on
 * top of it, for the mtu-exceeds-uplink rule. The MTU is the one the cluster network
 * configuration reports (`status.clusterNetworkMTU`), else the one the Cluster
 * Network Operator writes into its spec. Undefined while the operator configuration
 * is unread (the transport and IPsec mode decide the overhead) and while an MTU
 * migration runs, when the numbers are expected to disagree.
 */
export const clusterMtuOf = (sources: CnoConfigInputs | undefined): ClusterMtu | undefined => {
    const operator = sources?.operatorNetwork.status === 'ok' ? sources.operatorNetwork.data : undefined;
    if (!operator) return undefined;
    const config = sources?.configNetwork.status === 'ok' ? sources.configNetwork.data : undefined;
    if (migrating(operator.spec?.migration?.mtu) || migrating(config?.status?.migration?.mtu)) return undefined;

    const ovn = operator.spec?.defaultNetwork?.ovnKubernetesConfig;
    const reported = config?.status?.clusterNetworkMTU;
    const value = typeof reported === 'number' && reported > 0 ? reported : ovn?.mtu;
    if (typeof value !== 'number' || value <= 0) return undefined;
    const fromConfig = value === reported;

    const transport = ovn?.transport ?? 'Geneve';
    const ipsec = ovn?.ipsecConfig?.mode ?? 'Disabled';
    const overhead = transport === 'NoOverlay' ? 0 : GENEVE_OVERHEAD + (ipsec === 'Full' ? IPSEC_OVERHEAD : 0);
    const overheadBasis = transport === 'NoOverlay'
        ? 'The transport is NoOverlay, so pod packets leave unencapsulated.'
        : ipsec === 'Full'
            ? `Geneve adds ${GENEVE_OVERHEAD} bytes and IPsec (mode Full) ${IPSEC_OVERHEAD} more.`
            : `Geneve adds ${GENEVE_OVERHEAD} bytes.`;
    return {
        value,
        source: fromConfig ? configNetworkRef : operatorNetworkRef,
        path: fromConfig ? 'status.clusterNetworkMTU' : 'spec.defaultNetwork.ovnKubernetesConfig.mtu',
        overhead,
        overheadBasis
    };
};

export const plural = (count: number, one: string, many = `${one}s`): string => `${count} ${count === 1 ? one : many}`;
