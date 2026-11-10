import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import { OvnRecon } from '../types';
import { NetworkAddress, networkPath, physicalViewPath } from './networkPageModel';

/**
 * Console integration (ovn-recon-zdt): what OVN Recon adds to console pages it does
 * not own. Nothing here may be unconditional (ovn-recon-zdt.7). Every tab and action
 * the plugin contributes requires one of these feature flags in console-extensions.json,
 * and the flags are set only from the OvnRecon resource's status.effective, so they
 * stay off until an administrator turns a switch on.
 */

/** Gates every console.tab/horizontalNav extension the plugin contributes. */
export const FLAG_RESOURCE_TABS = 'OVN_RECON_RESOURCE_TABS';
/** Gates every console.action/resource-provider extension the plugin contributes. */
export const FLAG_RESOURCE_ACTIONS = 'OVN_RECON_RESOURCE_ACTIONS';

/** The href of every "OVN Recon" tab: the last path element of the tab's URL. */
export const TAB_HREF = 'ovn-recon';

export interface IntegrationFlags {
    resourceTabs: boolean;
    resourceActions: boolean;
}

export const INTEGRATION_OFF: IntegrationFlags = Object.freeze({ resourceTabs: false, resourceActions: false });

const creationTime = (item: OvnRecon): number => {
    const parsed = Date.parse(item.metadata?.creationTimestamp ?? '');
    return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
};

/**
 * The OvnRecon the operator acts on, by the operator's own rule (selectPrimaryInstance
 * in operator/internal/controller/ovnrecon_controller.go): the oldest by creation time,
 * then by namespace, then by name. The operator skips every other instance and never
 * resolves its status.effective, so the primary is the only one whose switches are real.
 */
export const selectPrimaryOvnRecon = (instances: OvnRecon[] | undefined | null): OvnRecon | undefined => {
    if (!instances || instances.length === 0) return undefined;
    return [...instances].sort((a, b) => {
        const byTime = creationTime(a) - creationTime(b);
        if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
        const byNamespace = (a.metadata?.namespace ?? '').localeCompare(b.metadata?.namespace ?? '');
        if (byNamespace !== 0) return byNamespace;
        return (a.metadata?.name ?? '').localeCompare(b.metadata?.name ?? '');
    })[0];
};

/**
 * The integration switches, failing closed. Off unless the watch has loaded without
 * error and the primary OvnRecon's status.effective says true in so many words:
 * no resource, a resource an older operator resolved (no integration in its status),
 * a load error, or a user who may not read OvnRecon all mean off.
 */
export const resolveIntegrationFlags = (
    instances: OvnRecon[] | undefined | null,
    loaded: boolean,
    loadError: unknown,
): IntegrationFlags => {
    if (!loaded || loadError) return INTEGRATION_OFF;
    const integration = selectPrimaryOvnRecon(instances)?.status?.effective?.consolePlugin?.integration;
    return {
        resourceTabs: integration?.resourceTabs === true,
        resourceActions: integration?.resourceActions === true,
    };
};

/* Where a console resource opens in OVN Recon. */

const NETWORK_KINDS: Record<string, NetworkAddress['kind']> = {
    ClusterUserDefinedNetwork: 'cudn',
    UserDefinedNetwork: 'udn',
    NetworkAttachmentDefinition: 'nad',
};

/** The network page address of a CUDN, UDN or NAD, or undefined for anything else. */
export const networkAddressOf = (
    resource: K8sResourceCommon | undefined,
    kind: string | undefined = resource?.kind,
): NetworkAddress | undefined => {
    const networkKind = kind ? NETWORK_KINDS[kind] : undefined;
    const name = resource?.metadata?.name;
    if (!networkKind || !name) return undefined;
    if (networkKind === 'cudn') return { kind: networkKind, name };
    const namespace = resource?.metadata?.namespace;
    return namespace ? { kind: networkKind, namespace, name } : undefined;
};

/**
 * The OVN Recon page for a resource: a Node's physical topology, or a network's page.
 * `kind` stands in when the object lacks one (the console's list rows usually carry it,
 * but nothing promises that).
 */
export const ovnReconPathFor = (
    resource: K8sResourceCommon | undefined,
    kind: string | undefined = resource?.kind,
): string | undefined => {
    if (kind === 'Node') {
        const name = resource?.metadata?.name;
        return name ? physicalViewPath(name) : undefined;
    }
    const address = networkAddressOf(resource, kind);
    return address ? networkPath(address) : undefined;
};
