import * as React from 'react';
import {
    DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm
} from '@patternfly/react-core';

import {
    findRouteAdvertisementForVrf,
    getCudnAssociatedNamespaces,
    getCudnsSelectedByRouteAdvertisement,
    getIpv4Addresses,
    getRouteAdvertisementsMatchingCudn,
    getVrfConnectionInfo,
    getVrfRoutesForInterface,
    parseNadConfig
} from '../components/nodeVisualizationSelectors';
import {
    ClusterUserDefinedNetwork,
    Interface,
    NetworkAttachmentDefinition,
    RouteAdvertisements,
    UserDefinedNetwork
} from '../types';
import { GraphContext } from './context';
import { getProjectPath, getResourceLinks } from './links';
import { NodeKind, NodeKindDefinition, NodeViewModel, ResourceRef } from './types';

/**
 * Per-kind drawer content. Lifted out of the component body, where every renderer
 * closed over the component's props and nothing could be tested or memoised.
 *
 * Behaviour-preserving: the JSX is unchanged apart from taking `ctx` rather than
 * reaching for a prop in scope. ovn-recon-s3t.12 replaces all of it with a Fact
 * model, at which point most of this file disappears.
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



export const renderBaseSummary = (node: NodeViewModel, extras?: React.ReactNode) => (
    <DescriptionList isCompact>
        <DescriptionListGroup>
            <DescriptionListTerm>Type</DescriptionListTerm>
            <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
        </DescriptionListGroup>
        {node.state && (
            <DescriptionListGroup>
                <DescriptionListTerm>State</DescriptionListTerm>
                <DescriptionListDescription>{node.state}</DescriptionListDescription>
            </DescriptionListGroup>
        )}
        {extras}
    </DescriptionList>
);

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

export const nodeKindRegistry: Record<NodeKind, NodeKindDefinition> = {
    interface: {
        label: 'Interface',
        renderSummary: (node) => renderBaseSummary(
            node,
            node.raw?.type === 'vlan' && node.raw?.vlan ? (
                <DescriptionListGroup>
                    {/* A kernel VLAN interface, created via NNCP -- not an OVN Localnet. */}
                    <DescriptionListTerm>VLAN</DescriptionListTerm>
                    <DescriptionListDescription>
                        Base: {node.raw.vlan['base-iface']} <br />
                        ID: {node.raw.vlan.id}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            ) : undefined
        ),
        renderDetails: (node) => {
            const isBridgeNode = node.raw?.type === 'linux-bridge' || node.raw?.type === 'ovs-bridge';
            const macAddress = getMacAddress(node.raw);
            const rawPorts = node.raw?.bridge?.port || node.raw?.bridge?.ports || node.raw?.ports || [];
            const bridgePorts = Array.isArray(rawPorts)
                ? rawPorts
                    .map((port: unknown) => {
                        if (typeof port === 'string') return port;
                        if (port && typeof port === 'object' && 'name' in (port as Record<string, unknown>)) {
                            const name = (port as Record<string, unknown>).name;
                            return typeof name === 'string' ? name : '';
                        }
                        return '';
                    })
                    .filter(Boolean)
                : [];

            return (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Type</DescriptionListTerm>
                        <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
                    </DescriptionListGroup>
                    {node.state && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>State</DescriptionListTerm>
                            <DescriptionListDescription>{node.state}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {macAddress && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>MAC Address</DescriptionListTerm>
                            <DescriptionListDescription>{macAddress}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {node.raw?.mtu && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>MTU</DescriptionListTerm>
                            <DescriptionListDescription>{node.raw.mtu}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {getIpv4Addresses(node.raw).length > 0 && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>IPv4</DescriptionListTerm>
                            <DescriptionListDescription>{getIpv4Addresses(node.raw).join(', ')}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {isBridgeNode && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Ports</DescriptionListTerm>
                            <DescriptionListDescription>
                                {bridgePorts.length > 0 ? (
                                    <ul className="pf-v6-c-list">
                                        {bridgePorts.map((portName) => (
                                            <li key={portName}>{portName}</li>
                                        ))}
                                    </ul>
                                ) : (
                                    <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>No bridge ports reported in NNS.</span>
                                )}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                </DescriptionList>
            );
        }
    },
    'ovn-mapping': {
        label: 'OVN Mapping',
        // Not the base summary: that would label the bridge as 'State', and a
        // mapping is never up or down -- it is a name OVN gives a bridge.
        renderSummary: (node) => (
            <DescriptionList isCompact>
                <DescriptionListGroup>
                    <DescriptionListTerm>Type</DescriptionListTerm>
                    <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
                </DescriptionListGroup>
                {node.raw?.bridge && (
                    <DescriptionListGroup>
                        <DescriptionListTerm>Bridge</DescriptionListTerm>
                        <DescriptionListDescription>{node.raw.bridge}</DescriptionListDescription>
                    </DescriptionListGroup>
                )}
            </DescriptionList>
        ),
        renderDetails: (node, ctx) => {
            // Find all CUDNs that reference this bridge mapping
            const localnetName = node.raw?.localnet;
            const referencingCudns = ctx.cudns.filter((cudn: ClusterUserDefinedNetwork) => {
                const physicalNetworkName = cudn.spec?.network?.localNet?.physicalNetworkName || cudn.spec?.network?.localnet?.physicalNetworkName;
                return physicalNetworkName === localnetName;
            });

            return (
                <DescriptionList isCompact>
                    {node.raw?.bridge && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Bridge</DescriptionListTerm>
                            <DescriptionListDescription>{node.raw.bridge}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {referencingCudns.length > 0 && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Referenced by CUDNs</DescriptionListTerm>
                            <DescriptionListDescription>
                                <ul className="pf-v6-c-list">
                                    {referencingCudns.map((cudn: ClusterUserDefinedNetwork) => {
                                        const cudnName = cudn.metadata?.name || 'Unknown';
                                        // Build resource link for CUDN (cluster-scoped resource)
                                        const resourceRef: ResourceRef = {
                                            apiVersion: cudn.apiVersion || 'k8s.ovn.org/v1',
                                            kind: cudn.kind || 'ClusterUserDefinedNetwork',
                                            name: cudnName,
                                            namespace: undefined // CUDN is cluster-scoped
                                        };
                                        const resourceLinks = getResourceLinks(resourceRef);
                                        const resourceLink = resourceLinks.find(link => link.label === 'Resource') || resourceLinks[0];

                                        return (
                                            <li key={cudnName}>
                                                <a
                                                    href={`${window.location.origin}${resourceLink?.href || '#'}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    {cudnName}
                                                </a>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {referencingCudns.length === 0 && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Referenced by CUDNs</DescriptionListTerm>
                            <DescriptionListDescription>
                                <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>No CUDNs reference this bridge mapping</span>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                </DescriptionList>
            );
        }
    },
    cudn: {
        label: 'CUDN',
        renderSummary: (node) => renderBaseSummary(
            node,
            <DescriptionListGroup>
                <DescriptionListTerm>CUDN</DescriptionListTerm>
                <DescriptionListDescription>{node.label}</DescriptionListDescription>
            </DescriptionListGroup>
        ),
        renderDetails: (node, ctx) => {
            const topology = node.raw?.spec?.network?.topology;
            const hasRole = topology === 'Layer2' || topology === 'Layer3' || topology === 'Localnet';
            const role =
                topology === 'Layer2' ? node.raw?.spec?.network?.layer2?.role
                    : topology === 'Layer3' ? node.raw?.spec?.network?.layer3?.role
                        : topology === 'Localnet' ? (node.raw?.spec?.network?.localnet?.role || node.raw?.spec?.network?.localNet?.role || 'Secondary')
                        : undefined;
            const matchingRAs =
                (topology === 'Layer2' || topology === 'Layer3')
                    ? getRouteAdvertisementsMatchingCudn(ctx.routeAdvertisements, node.raw as ClusterUserDefinedNetwork)
                    : [];
            const associatedNamespaces = getCudnAssociatedNamespaces(node.raw as ClusterUserDefinedNetwork);

            return (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Topology</DescriptionListTerm>
                        <DescriptionListDescription>{topology || 'Unknown'}</DescriptionListDescription>
                    </DescriptionListGroup>

                    {hasRole && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Role</DescriptionListTerm>
                            <DescriptionListDescription>{role || 'Unknown'}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}

                    {(topology === 'Layer2' || topology === 'Layer3') && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Subnets</DescriptionListTerm>
                            <DescriptionListDescription>
                                {(topology === 'Layer2' ? node.raw?.spec?.network?.layer2?.subnets : node.raw?.spec?.network?.layer3?.subnets)?.join(', ') || '-'}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}

                    {(node.raw?.spec?.network?.localNet?.vlan?.access?.id || node.raw?.spec?.network?.localnet?.vlan?.access?.id) && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>VLAN ID</DescriptionListTerm>
                            <DescriptionListDescription>
                                {node.raw?.spec?.network?.localNet?.vlan?.access?.id || node.raw?.spec?.network?.localnet?.vlan?.access?.id}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}

                    {node.raw?.spec?.network?.localNet?.physicalNetworkName && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Physical Network</DescriptionListTerm>
                            <DescriptionListDescription>{node.raw.spec.network.localNet.physicalNetworkName}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {node.raw?.spec?.network?.localnet?.physicalNetworkName && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Physical Network</DescriptionListTerm>
                            <DescriptionListDescription>{node.raw.spec.network.localnet.physicalNetworkName}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}

                    {associatedNamespaces.length > 0 && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Namespaces</DescriptionListTerm>
                            <DescriptionListDescription>
                                <ul className="pf-v6-c-list">
                                    {associatedNamespaces.map((ns: string) => (
                                        <li key={ns}>
                                            <a
                                                href={`/k8s/ns/${ns}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${node.raw.metadata.name}`}
                                                className="pf-v6-c-button pf-m-link pf-m-inline"
                                            >
                                                {ns}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}

                    {matchingRAs.length > 0 && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Route Advertisements</DescriptionListTerm>
                            <DescriptionListDescription>
                                <ul className="pf-v6-c-list">
                                    {matchingRAs.map((ra: RouteAdvertisements) => {
                                        const raName = ra.metadata?.name || 'Unknown';
                                        const resourceRef: ResourceRef = {
                                            apiVersion: ra.apiVersion || 'k8s.ovn.org/v1',
                                            kind: ra.kind || 'RouteAdvertisements',
                                            name: raName,
                                            namespace: undefined // Cluster scoped
                                        };
                                        const resourceLinks = getResourceLinks(resourceRef);
                                        const resourceLink = resourceLinks.find(link => link.label === 'Resource') || resourceLinks[0];

                                        return (
                                            <li key={raName}>
                                                <a
                                                    href={`${window.location.origin}${resourceLink?.href || '#'}`}
                                                    target="_blank"
                                                    rel="noopener noreferrer"
                                                >
                                                    {raName}
                                                </a>
                                            </li>
                                        );
                                    })}
                                </ul>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                </DescriptionList>
            );
        }
    },
    udn: {
        label: 'UDN',
        renderDetails: (node, ctx) => {
            const udn = node.raw as UserDefinedNetwork;
            const namespace = udn?.metadata?.namespace || '';
            const { topology, role } = getUdnTopologyAndRole(udn);
            const name = udn?.metadata?.name || '';
            const nadInNs = name && namespace ? ctx.nads.find((nad: NetworkAttachmentDefinition) => nad.metadata?.namespace === namespace && nad.metadata?.name === name) : undefined;
            return (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Topology</DescriptionListTerm>
                        <DescriptionListDescription>{topology}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Role</DescriptionListTerm>
                        <DescriptionListDescription>{role}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Namespace</DescriptionListTerm>
                        <DescriptionListDescription>
                            <a href={getProjectPath(namespace)} className="pf-v6-c-button pf-m-link pf-m-inline">{namespace}</a>
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    {(topology === 'Layer2' || topology === 'Layer3') && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Subnets</DescriptionListTerm>
                            <DescriptionListDescription>
                                {(topology === 'Layer2' ? udn?.spec?.layer2?.subnets : udn?.spec?.layer3?.subnets)?.join(', ') || '-'}
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {nadInNs && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>NetworkAttachmentDefinition</DescriptionListTerm>
                            <DescriptionListDescription>
                                <a
                                    href={`/k8s/ns/${namespace}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${name}`}
                                    className="pf-v6-c-button pf-m-link pf-m-inline"
                                >
                                    {name}
                                </a>
                            </DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                </DescriptionList>
            );
        }
    },
    attachment: {
        label: 'Attachment',
        buildBadges: (node) => (node.isSynthetic ? ['synthetic', 'derived'] : []),
        buildLinks: (node, ctx) => {
            const namespaceLinks = getAttachmentNamespaces(node).map((namespace) => ({
                label: `Namespace: ${namespace}`,
                href: getProjectPath(namespace)
            }));
            const nadLinks = getAttachmentNadRefs(node, ctx).map((ref) => ({
                label: `NAD: ${ref.namespace}/${ref.name}`,
                href: `/k8s/ns/${ref.namespace}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${ref.name}`
            }));
            return [...namespaceLinks, ...nadLinks];
        },
        renderDetails: (node, ctx) => {
            const namespaces = getAttachmentNamespaces(node);
            const nadRefs = getAttachmentNadRefs(node, ctx);
            return (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Type</DescriptionListTerm>
                        <DescriptionListDescription>{node.subtitle}</DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Namespaces</DescriptionListTerm>
                        <DescriptionListDescription>
                            {namespaces.length > 0 ? (
                                <ul className="pf-v6-c-list">
                                    {namespaces.map((namespace) => (
                                        <li key={namespace}>
                                            <a href={getProjectPath(namespace)} className="pf-v6-c-button pf-m-link pf-m-inline">
                                                {namespace}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            ) : 'No namespaces discovered.'}
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>NetworkAttachmentDefinitions</DescriptionListTerm>
                        <DescriptionListDescription>
                            {nadRefs.length > 0 ? (
                                <ul className="pf-v6-c-list">
                                    {nadRefs.map((ref) => (
                                        <li key={`${ref.namespace}/${ref.name}`}>
                                            <a
                                                href={`/k8s/ns/${ref.namespace}/k8s.cni.cncf.io~v1~NetworkAttachmentDefinition/${ref.name}`}
                                                className="pf-v6-c-button pf-m-link pf-m-inline"
                                            >
                                                {ref.namespace}/{ref.name}
                                            </a>
                                        </li>
                                    ))}
                                </ul>
                            ) : 'No matching NetworkAttachmentDefinition found.'}
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                </DescriptionList>
            );
        }
    },
    nad: {
        label: 'NAD',
        renderDetails: (node) => {
            const config = parseNadConfig(node.raw?.spec?.config);
            const nadType = typeof config?.type === 'string' ? config.type : 'Unknown';
            const nadName = typeof config?.name === 'string' ? config.name : undefined;
            return (
                <DescriptionList isCompact>
                    <DescriptionListGroup>
                        <DescriptionListTerm>Type</DescriptionListTerm>
                        <DescriptionListDescription>{nadType}</DescriptionListDescription>
                    </DescriptionListGroup>
                    {nadName && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Network Name</DescriptionListTerm>
                            <DescriptionListDescription>{nadName}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                </DescriptionList>
            );
        }
    },
    'lldp-neighbor': {
        label: 'LLDP Neighbor',
        renderSummary: (node) => renderBaseSummary(
            node,
            <>
                <DescriptionListGroup>
                    <DescriptionListTerm>Local Interface</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.localInterface || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>Remote Port ID</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.portId || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
            </>
        ),
        renderDetails: (node) => (
            <DescriptionList isCompact>
                <DescriptionListGroup>
                    <DescriptionListTerm>Local Interface</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.localInterface || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>System Name</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.systemName || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>Port ID</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.portId || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>Chassis ID</DescriptionListTerm>
                    <DescriptionListDescription>{node.raw?.chassisId || '-'}</DescriptionListDescription>
                </DescriptionListGroup>
                {node.raw?.systemDescription && (
                    <DescriptionListGroup>
                        <DescriptionListTerm>System Description</DescriptionListTerm>
                        <DescriptionListDescription>{node.raw.systemDescription}</DescriptionListDescription>
                    </DescriptionListGroup>
                )}
                <DescriptionListGroup>
                    <DescriptionListTerm>Capabilities</DescriptionListTerm>
                    <DescriptionListDescription>
                        {Array.isArray(node.raw?.capabilities) && node.raw.capabilities.length > 0 ? (
                            <ul className="pf-v6-c-list">
                                {node.raw.capabilities.map((capability: string) => (
                                    <li key={capability}>{capability}</li>
                                ))}
                            </ul>
                        ) : (
                            'No capabilities reported'
                        )}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            </DescriptionList>
        )
    },
    vrf: {
        label: 'VRF',
        renderSummary: (node, ctx) => {
            const ra = findRouteAdvertisementForVrf(ctx.routeAdvertisements, node.raw?.name || '');
            const matchedCudnNames = getCudnsSelectedByRouteAdvertisement(ra, ctx.cudns)
                .map((cudn) => cudn.metadata?.name)
                .filter(Boolean);

            return renderBaseSummary(
                node,
                <DescriptionListGroup>
                    <DescriptionListTerm>Matched CUDNs</DescriptionListTerm>
                    <DescriptionListDescription>
                        {matchedCudnNames.length > 0 ? matchedCudnNames.join(', ') : 'N/A'}
                    </DescriptionListDescription>
                </DescriptionListGroup>
            );
        },
        renderDetails: (node, ctx) => {
            const ra = findRouteAdvertisementForVrf(ctx.routeAdvertisements, node.raw.name);
            const matchedCudns = getCudnsSelectedByRouteAdvertisement(ra, ctx.cudns);
            const { brIntPorts } = getVrfConnectionInfo(node.raw as Interface, ctx.interfaces);
            const macAddress = getMacAddress(node.raw);
            // Route association is priced for one node: it walks the whole NNS route
            // table, so it runs here, for the drawer, never during graph render.
            const vrfRoutes = getVrfRoutesForInterface(node.raw as Interface, ctx.nns);

            return (
                <DescriptionList isCompact>
                    {macAddress && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>MAC Address</DescriptionListTerm>
                            <DescriptionListDescription>{macAddress}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    {node.raw?.vrf?.['route-table-id'] && (
                        <DescriptionListGroup>
                            <DescriptionListTerm>Route Table</DescriptionListTerm>
                            <DescriptionListDescription>{node.raw.vrf['route-table-id']}</DescriptionListDescription>
                        </DescriptionListGroup>
                    )}
                    <DescriptionListGroup>
                        <DescriptionListTerm>Routes</DescriptionListTerm>
                        <DescriptionListDescription>
                            {vrfRoutes.length > 0 ? (
                                <ul className="pf-v6-c-list">
                                    {vrfRoutes.map((route, index) => (
                                        <li key={`${route.destination}-${route.nextHopAddress || ''}-${route.nextHopInterface || ''}-${index}`}>
                                            {route.destination}
                                            {route.nextHopAddress ? ` via ${route.nextHopAddress}` : ''}
                                            {route.nextHopInterface ? ` dev ${route.nextHopInterface}` : ''}
                                            {route.metric ? ` metric ${route.metric}` : ''}
                                            {route.protocol ? ` proto ${route.protocol}` : ''}
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>No associated routes found in NNS.</span>
                            )}
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    <DescriptionListGroup>
                        <DescriptionListTerm>br-int Ports</DescriptionListTerm>
                        <DescriptionListDescription>
                            {brIntPorts.length > 0 ? (
                                <ul className="pf-v6-c-list">
                                    {brIntPorts.map((iface) => {
                                        const addresses = getIpv4Addresses(iface);
                                        return (
                                            <li key={iface.name}>
                                                {iface.name}
                                                {addresses.length > 0 ? ` ${addresses.join(', ')}` : ''}
                                            </li>
                                        );
                                    })}
                                </ul>
                            ) : (
                                <span style={{ color: 'var(--pf-t--global--text--color--subtle)' }}>No matching br-int ports inferred from NNS.</span>
                            )}
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                    {ra && (
                        <>
                            <DescriptionListGroup>
                                <DescriptionListTerm>Route Advertisement</DescriptionListTerm>
                                <DescriptionListDescription>
                                    <ul className="pf-v6-c-list">
                                        <li>
                                            <a
                                                href={`/k8s/cluster/k8s.ovn.org~v1~RouteAdvertisements/${ra.metadata?.name}`}
                                                className="pf-v6-c-button pf-m-link pf-m-inline"
                                            >
                                                {ra.metadata?.name}
                                            </a>
                                        </li>
                                    </ul>
                                </DescriptionListDescription>
                            </DescriptionListGroup>
                            {matchedCudns.length > 0 && (
                                <DescriptionListGroup>
                                    <DescriptionListTerm>Matched CUDNs</DescriptionListTerm>
                                    <DescriptionListDescription>
                                        <ul className="pf-v6-c-list">
                                            {matchedCudns.map(cudn => (
                                                <li key={cudn.metadata?.name}>
                                                    <a
                                                        href={`/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/${cudn.metadata?.name}`}
                                                        className="pf-v6-c-button pf-m-link pf-m-inline"
                                                    >
                                                        {cudn.metadata?.name}
                                                    </a>
                                                </li>
                                            ))}
                                        </ul>
                                    </DescriptionListDescription>
                                </DescriptionListGroup>
                            )}
                        </>
                    )}

                </DescriptionList >
            );
        }
    },
    other: {
        label: 'Other'
    }
};
