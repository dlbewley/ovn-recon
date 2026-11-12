import * as React from 'react';
import {
    Checkbox,
    ExpandableSection,
    FormSelect,
    FormSelectOption,
    Label,
    LabelGroup,
    Spinner,
    TextInput,
    Toolbar,
    ToolbarContent,
    ToolbarItem,
} from '@patternfly/react-core';

import { LogicalDatabase } from '../types';
import { podAddressIndex, PodAddressOwner } from './routerRules';
import RuleTable, { RuleColumn } from './RuleTable';
import {
    DIRECT_SOURCE,
    groupServices,
    EndpointOwner,
    endpointOwnerResolver,
    EndpointSliceQuery,
    endpointSliceQueryFor,
    isIpAddress,
    KubeServiceLike,
    LoadBalancerAttachment,
    parseVip,
    scopeOf,
    ServiceFacets,
    serviceFacetCounts,
    ServiceGroupView,
    serviceGroupMatches,
    ServiceSection,
    ServiceVipView,
    splitSummaryText,
    summarizeSplit,
    VIP_CLASSES,
    VipClass,
    vipClassContext,
} from './serviceIndex';
import { useKubeService, useServiceEndpointSlices, useServiceNetworks } from './useServiceReads';
import { ConsoleLink } from '../linkOut/LinkOut';
import { resourceTarget } from '../linkOut/registry';
import { InfoPopover } from './drawerKit';

const SUBTLE: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const WRAP_ANYWHERE: React.CSSProperties = { overflowWrap: 'anywhere' };
const DASH = <span style={SUBTLE}>—</span>;

/**
 * Half PatternFly's cell padding: six columns at the default inset need about
 * 650px, more than the drawer's 612px body at its default half width
 * (ovn-recon-dp7.5 made the same trade for the Ports table).
 */
const SERVICE_TABLE_STYLE = {
    '--pf-v6-c-table--cell--Padding--base': 'var(--pf-t--global--spacer--sm)',
    '--pf-v6-c-table--cell--first-last-child--PaddingInline': 'var(--pf-t--global--spacer--xs)',
} as React.CSSProperties;

/** Long Service names wrap at their hyphens and after the slash, never
 * inside a word, so the column keeps a readable width. */
const BREAK_WORD: React.CSSProperties = { overflowWrap: 'break-word' };

/** "namespace/name" with a break opportunity after the slash. */
const LabelText: React.FC<{ label: string }> = ({ label }) => {
    const slash = label.indexOf('/');
    return slash < 0 ? (
        <>{label}</>
    ) : (
        <>
            {label.slice(0, slash + 1)}
            <wbr />
            {label.slice(slash + 1)}
        </>
    );
};

/** Rows per page in each section: a large cluster holds thousands of
 * Services, all of them in the cluster-wide section. */
export const SERVICE_PAGE_SIZE = 100;

/** Where the view renders: the drawer (narrow, halved padding) or the
 * construct detail page (full width, PatternFly padding, 50 rows a page). */
export type Surface = 'drawer' | 'page';
const PAGE_SURFACE_PAGE_SIZE = 50;
const PAGE_SURFACE_PER_PAGE = [20, 50, 100];

const CLASS_COLORS: Record<VipClass, 'blue' | 'purple' | 'teal' | 'orange'> = {
    ClusterIP: 'blue',
    NodePort: 'purple',
    LoadBalancer: 'teal',
    ExternalIP: 'orange',
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * A VIP class chip: filled when the Kubernetes Service declares it, outlined
 * (and read out as inferred) when it comes from the OVN rows alone.
 */
const VipClassChip: React.FC<{ vipClass: VipClass; inferred: boolean; reason?: string }> = ({
    vipClass,
    inferred,
    reason,
}) => (
    <>
        <Label
            isCompact
            color={CLASS_COLORS[vipClass]}
            variant={inferred ? 'outline' : 'filled'}
            data-testid="vip-class"
            data-basis={inferred ? 'inferred' : 'declared'}
        >
            {vipClass}
            {inferred && <span className="pf-v6-screen-reader"> (inferred)</span>}
        </Label>
        {reason && (
            <InfoPopover
                subject={`the ${vipClass} type`}
                header={inferred ? 'Inferred' : undefined}
                hint={`${vipClass}, ${inferred ? 'inferred' : 'declared'}: ${reason}`}
            />
        )}
    </>
);

const ClassChips: React.FC<{ group: ServiceGroupView }> = ({ group }) =>
    group.classes.length === 0 ? (
        DASH
    ) : (
        <LabelGroup isCompact numLabels={4} aria-label="VIP types">
            {group.classes.map(({ vipClass, inferred }) => (
                <VipClassChip key={vipClass} vipClass={vipClass} inferred={inferred} />
            ))}
        </LabelGroup>
    );

const PortChips: React.FC<{ group: ServiceGroupView }> = ({ group }) =>
    group.ports.length === 0 ? (
        DASH
    ) : (
        <LabelGroup isCompact numLabels={3} aria-label="Ports" data-testid="service-ports">
            {group.ports.map(({ port, protocol }) => (
                <Label key={`${port}/${protocol}`} isCompact>{`${port}/${protocol.toUpperCase()}`}</Label>
            ))}
        </LabelGroup>
    );

/**
 * The Service's name, linked, with its namespace on a subtle second line
 * (ovn-recon-dp7.9 item 3): "namespace/name" in one run wrapped long
 * operator Service names onto three or four lines.
 */
const ServiceName: React.FC<{ group: ServiceGroupView }> = ({ group }) =>
    group.service && group.service.kind === 'Service' ? (
        <>
            <span data-testid="service-name">
                <ConsoleLink
                    target={resourceTarget({
                        apiVersion: 'v1',
                        kind: 'Service',
                        namespace: group.service.namespace,
                        name: group.service.name,
                    })}
                    title={group.loadBalancers.map((row) => row.name).join('\n')}
                    style={BREAK_WORD}
                >
                    {group.service.name}
                </ConsoleLink>
            </span>
            <div style={{ ...SUBTLE, fontSize: '0.875em', ...BREAK_WORD }} data-testid="service-namespace">
                {group.service.namespace}
            </div>
        </>
    ) : (
        <code style={BREAK_WORD}>
            <LabelText label={group.label} />
        </code>
    );

const BackendsCell: React.FC<{ group: ServiceGroupView }> = ({ group }) => {
    if (group.vips.length > 0 && group.vipsWithoutEndpoints === group.vips.length) {
        return <Label isCompact color="yellow">No endpoints</Label>;
    }
    return (
        <>
            {group.backendCount}
            {group.vipsWithoutEndpoints > 0 && (
                <>
                    {' '}
                    <Label isCompact color="yellow">
                        {`${group.vipsWithoutEndpoints} of ${plural(group.vips.length, 'VIP')} without endpoints`}
                    </Label>
                </>
            )}
        </>
    );
};

const PodRef: React.FC<{ namespace: string; pod: string }> = ({ namespace, pod }) => (
    <ConsoleLink target={resourceTarget({ apiVersion: 'v1', kind: 'Pod', namespace, name: pod })} style={WRAP_ANYWHERE}>
        {namespace}/{pod}
    </ConsoleLink>
);

// ------------------------------------------------ backend resolution

type SliceResolver = (backend: string, protocol: string) => EndpointOwner | undefined;

/** The Service's EndpointSlices as an expanded row sees them. */
interface SliceState {
    /** Set once the slices have loaded. */
    resolve?: SliceResolver;
    loaded: boolean;
    error?: string;
}

/**
 * Watches the Service's EndpointSlices while it is mounted (the row is
 * expanded) and hands the resolver to its children. One list per row,
 * stopped on collapse.
 */
const EndpointSliceOwners: React.FC<{
    namespace: string;
    name: string;
    query: EndpointSliceQuery;
    children: (state: SliceState) => React.ReactNode;
}> = ({ namespace, name, query, children }) => {
    const { slices, loaded, error } = useServiceEndpointSlices(namespace, name, query.labelKey);
    const resolve = React.useMemo(() => endpointOwnerResolver(slices, query.network), [slices, query.network]);
    return <>{children({ resolve: loaded && !error ? resolve : undefined, loaded, error })}</>;
};

/**
 * A backend's pod: this zone's ports first, as before; then the Service's
 * EndpointSlices, which declare it (and resolve host-network backends,
 * whose address is a node's). Neither: the address stands alone.
 */
const BackendOwner: React.FC<{
    local?: PodAddressOwner;
    declared?: EndpointOwner;
    databaseNode?: string;
}> = ({ local, declared, databaseNode }) => {
    if (local) {
        return (
            <span data-testid="backend-pod" data-basis="zone">
                <PodRef namespace={local.namespace} pod={local.pod} />
                {databaseNode && <span style={SUBTLE}> on {databaseNode}</span>}
            </span>
        );
    }
    if (!declared) return null;
    return (
        <span data-testid="backend-pod" data-basis="declared">
            <PodRef namespace={declared.namespace} pod={declared.pod} />
            <span style={SUBTLE}>
                {declared.node ? ` on ${declared.node}` : ''} · declared
            </span>
            <InfoPopover subject={`the backend ${declared.pod}`} hint={`Declared by EndpointSlice ${declared.slice ?? ''}`.trim()} />
        </span>
    );
};

// ------------------------------------------------------- expanded row

/** Reads the Service while its row is open and reports it upwards. */
const DeclaredService: React.FC<{
    namespace: string;
    name: string;
    label: string;
    onRead: (label: string, service: KubeServiceLike) => void;
}> = ({ namespace, name, label, onRead }) => {
    const { service, loaded, error } = useKubeService(namespace, name);
    React.useEffect(() => {
        if (service) onRead(label, service);
    }, [service, label, onRead]);
    if (error) {
        return (
            <div style={SUBTLE} data-testid="service-declared">
                The Service could not be read ({error}); its types stay inferred.
            </div>
        );
    }
    if (!loaded || !service) {
        return (
            <div style={SUBTLE} data-testid="service-declared">
                <Spinner size="sm" aria-label="Reading the Service" /> Reading the Service…
            </div>
        );
    }
    const spec = service.spec ?? {};
    const parts = [`type ${spec.type ?? 'ClusterIP'}`];
    if (spec.externalTrafficPolicy) parts.push(`externalTrafficPolicy ${spec.externalTrafficPolicy}`);
    if (spec.internalTrafficPolicy && spec.internalTrafficPolicy !== 'Cluster') {
        parts.push(`internalTrafficPolicy ${spec.internalTrafficPolicy}`);
    }
    return (
        <div data-testid="service-declared">
            <strong>Declared</strong> {parts.join(' · ')}
        </div>
    );
};

const rejectNote = (vip: ServiceVipView): string =>
    vip.loadBalancer.options?.reject === 'true'
        ? 'No endpoints: the Service has no ready endpoints, and OVN rejects connections to this VIP.'
        : 'No endpoints: the Service has no ready endpoints.';

const sourceText = (sources: string[]): string =>
    sources.map((source) => (source === DIRECT_SOURCE ? 'set directly' : `via ${source}`)).join(', ');

interface ServiceDetailProps {
    group: ServiceGroupView;
    ownerOf: (address: string) => PodAddressOwner | undefined;
    databaseNode?: string;
    onDeclared: (label: string, service: KubeServiceLike) => void;
    sourcesOf: (uuid: string) => string[];
}

/** True when some backend of the row is an address this zone's ports do not hold. */
const needsEndpointSlices = (group: ServiceGroupView, ownerOf: ServiceDetailProps['ownerOf']): boolean =>
    group.vips.some((vip) =>
        vip.backends.some((backend) => {
            const { address } = parseVip(backend);
            return isIpAddress(address) && !ownerOf(address);
        }),
    );

/**
 * Every VIP of the row with its class and backends, each backend's address
 * beside its pod; then the load balancer rows and session affinity. Backends
 * the zone's ports resolve cost nothing; the rest are matched against the
 * Service's EndpointSlices, read once while the row stays open.
 */
const ServiceDetail: React.FC<ServiceDetailProps> = ({ group, ownerOf, databaseNode, onDeclared, sourcesOf }) => {
    const affinity = group.loadBalancers.map((row) => row.options?.affinity_timeout).find(Boolean);
    const service = group.service?.kind === 'Service' ? group.service : undefined;
    const query = React.useMemo(() => endpointSliceQueryFor(group.loadBalancers), [group.loadBalancers]);

    const body = (slices?: SliceState) => (
        <div style={{ width: 0, minWidth: '100%' }} data-testid="service-detail">
            {service && (
                <DeclaredService namespace={service.namespace} name={service.name} label={group.label} onRead={onDeclared} />
            )}
            <div className="pf-u-mt-sm">
                {group.vips.map((vip) => (
                    <div key={vip.key} className="pf-u-mb-sm" data-testid="service-vip">
                        <div>
                            <code style={WRAP_ANYWHERE}>{vip.vip}</code>{' '}
                            <span style={SUBTLE}>{vip.protocol.toUpperCase()}</span>{' '}
                            <VipClassChip
                                vipClass={vip.classification.vipClass}
                                inferred={vip.classification.basis === 'inferred'}
                                reason={vip.classification.reason}
                            />
                        </div>
                        <div style={{ paddingInlineStart: 'var(--pf-t--global--spacer--md)' }}>
                            {vip.backends.length === 0 ? (
                                <div style={SUBTLE}>{rejectNote(vip)}</div>
                            ) : (
                                vip.backends.map((backend) => {
                                    const local = ownerOf(parseVip(backend).address);
                                    return (
                                        <div key={backend} data-testid="service-backend">
                                            <code style={WRAP_ANYWHERE}>{backend}</code>{' '}
                                            <BackendOwner
                                                local={local}
                                                declared={local ? undefined : slices?.resolve?.(backend, vip.protocol)}
                                                databaseNode={databaseNode}
                                            />
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </div>
                ))}
            </div>
            {slices && !slices.loaded && !slices.error && (
                <div style={SUBTLE} className="pf-u-mb-sm" data-testid="backend-slices-loading">
                    <Spinner size="sm" aria-label="Reading EndpointSlices" /> Reading the Service&apos;s EndpointSlices…
                </div>
            )}
            {slices?.error && (
                <div style={SUBTLE} className="pf-u-mb-sm" data-testid="backend-slices-error">
                    Backends on other nodes could not be resolved: the Service&apos;s EndpointSlices could not be read.
                    <InfoPopover subject="the EndpointSlice error" hint={slices.error} />
                </div>
            )}
            <div>
                <strong>Load balancer{group.loadBalancers.length === 1 ? '' : 's'}</strong>
                {group.loadBalancers.map((row) => (
                    <div key={row.uuid}>
                        <code style={WRAP_ANYWHERE}>{row.name}</code>{' '}
                        <span style={SUBTLE}>({sourceText(sourcesOf(row.uuid))})</span>
                    </div>
                ))}
            </div>
            {affinity && (
                <div className="pf-u-mt-sm">
                    <strong>Session affinity</strong> {affinity}s
                </div>
            )}
        </div>
    );

    return service && needsEndpointSlices(group, ownerOf) ? (
        <EndpointSliceOwners namespace={service.namespace} name={service.name} query={query}>
            {body}
        </EndpointSliceOwners>
    ) : (
        body()
    );
};

// ----------------------------------------------------------- sections

const VIP_CLASS_RANK = new Map<VipClass, number>(VIP_CLASSES.map((vipClass, index) => [vipClass, index]));

const ServiceSectionView: React.FC<{
    section: ServiceSection;
    title: string;
    note?: string;
    allRows: ServiceGroupView[];
    rows: ServiceGroupView[];
    loadBalancerCount: number;
    filtered: boolean;
    isExpanded: boolean;
    onToggle: (expanded: boolean) => void;
    expandedContent: (group: ServiceGroupView) => React.ReactNode;
    surface: Surface;
}> = ({ section, title, note, allRows, rows, loadBalancerCount, filtered, isExpanded, onToggle, expandedContent, surface }) => {
    const columns: RuleColumn<ServiceGroupView>[] = [
        {
            key: 'service',
            title: 'Service',
            cell: (group) => <ServiceName group={group} />,
            sortValue: (group) => group.label,
        },
        {
            key: 'type',
            title: 'Type',
            cell: (group) => <ClassChips group={group} />,
            sortValue: (group) =>
                group.classes.length === 0 ? VIP_CLASSES.length : VIP_CLASS_RANK.get(group.classes[0].vipClass) ?? 0,
        },
        {
            key: 'ports',
            title: 'Ports',
            cell: (group) => <PortChips group={group} />,
            sortValue: (group) => group.ports[0]?.port ?? -1,
        },
        {
            key: 'vips',
            title: 'VIPs',
            cell: (group) => group.vips.length,
            sortValue: (group) => group.vips.length,
        },
        {
            key: 'backends',
            title: 'Backends',
            cell: (group) => <BackendsCell group={group} />,
            sortValue: (group) =>
                group.vips.length > 0 && group.vipsWithoutEndpoints === group.vips.length ? -1 : group.backendCount,
        },
    ];

    const count = filtered
        ? `${rows.length} of ${plural(allRows.length, 'Service')}`
        : `${plural(allRows.length, 'Service')} · ${plural(loadBalancerCount, 'load balancer')}`;

    return (
        <ExpandableSection
            toggleContent={
                // Link buttons do not wrap; the cluster-wide heading is longer
                // than the drawer is wide.
                <span
                    data-testid={`services-section-${section}`}
                    style={{ whiteSpace: 'normal', textAlign: 'start', display: 'inline-block' }}
                >
                    {title}
                    {note && <span style={SUBTLE}> ({note})</span>} · {count}
                </span>
            }
            isExpanded={isExpanded}
            onToggle={(_event, expanded) => onToggle(expanded)}
            className="pf-u-mb-sm"
        >
            {isExpanded &&
                (allRows.length === 0 ? (
                    <div style={SUBTLE}>
                        {section === 'node'
                            ? 'No node-scoped load balancer is set on this construct.'
                            : 'No cluster-wide load balancer reaches this construct.'}
                    </div>
                ) : rows.length === 0 ? (
                    <div>No services match.</div>
                ) : (
                    <RuleTable
                        ariaLabel={section === 'node' ? 'Services on this node' : 'Cluster-wide services'}
                        columns={columns}
                        rows={rows}
                        rowKey={(group) => group.key}
                        expandedContent={expandedContent}
                        pageSize={surface === 'page' ? PAGE_SURFACE_PAGE_SIZE : SERVICE_PAGE_SIZE}
                        perPageOptions={surface === 'page' ? PAGE_SURFACE_PER_PAGE : undefined}
                        tableStyle={surface === 'page' ? undefined : SERVICE_TABLE_STYLE}
                    />
                ))}
        </ExpandableSection>
    );
};

// ---------------------------------------------------------------- tab

const ALL = '';

/** "shared by every node switch and gateway router" for the cluster group. */
const sharedNote = (groups: ServiceGroupView[]): string => {
    const names = [...new Set(groups.flatMap((group) => group.sources))].filter((source) => source !== DIRECT_SOURCE);
    if (names.length === 0) return 'the same on every node';
    if (names.length === 1 && names[0] === 'clusterLBGroup') return 'shared by every node switch and gateway router';
    return `shared through ${names.sort().join(', ')}`;
};

export interface ServicesViewProps {
    attachment: LoadBalancerAttachment;
    /** The zone database the attachment was resolved from. */
    database: LogicalDatabase;
    /** The node that database came from. */
    databaseNode?: string;
    /** Default 'drawer'. */
    surface?: Surface;
    /** The text filter, when the caller keeps it (the detail page's q). */
    query?: string;
    onQueryChange?: (value: string) => void;
}

/**
 * The Services tab (ovn-recon-dp7.6): one row per Service, the load
 * balancers set on this node's constructs first and open, the cluster-wide
 * ones second and collapsed; facets for type, protocol, namespace and
 * missing endpoints; VIP classes inferred from the rows, declared once a
 * Service has been read; backends resolved to pods.
 */
export const ServicesView: React.FC<ServicesViewProps> = ({
    attachment,
    database,
    databaseNode,
    surface = 'drawer',
    query: controlledQuery,
    onQueryChange,
}) => {
    const networks = useServiceNetworks();
    const context = React.useMemo(
        () => vipClassContext(database, networks.serviceNetworks),
        [database, networks.serviceNetworks],
    );
    const [declared, setDeclared] = React.useState<ReadonlyMap<string, KubeServiceLike>>(() => new Map());
    const onDeclared = React.useCallback(
        (label: string, service: KubeServiceLike) =>
            setDeclared((current) => (current.get(label) === service ? current : new Map(current).set(label, service))),
        [],
    );
    const groups = React.useMemo(() => groupServices(attachment, context, declared), [attachment, context, declared]);
    const split = React.useMemo(() => summarizeSplit(attachment), [attachment]);
    const counts = React.useMemo(() => serviceFacetCounts(groups), [groups]);
    const ownerOf = React.useMemo(() => podAddressIndex(database), [database]);
    const sourcesByUuid = React.useMemo(() => {
        const map = new Map<string, string[]>();
        for (const loadBalancer of attachment.direct) map.set(loadBalancer.uuid, [DIRECT_SOURCE]);
        for (const { group, members } of attachment.viaGroups) {
            for (const loadBalancer of members) map.set(loadBalancer.uuid, [...(map.get(loadBalancer.uuid) ?? []), group.name]);
        }
        return map;
    }, [attachment]);

    const [ownQuery, setOwnQuery] = React.useState('');
    const query = controlledQuery ?? ownQuery;
    const setQuery = (value: string) => {
        if (controlledQuery === undefined) setOwnQuery(value);
        onQueryChange?.(value);
    };
    const [vipClass, setVipClass] = React.useState<string>(ALL);
    const [protocol, setProtocol] = React.useState<string>(ALL);
    const [namespace, setNamespace] = React.useState<string>(ALL);
    const [withoutEndpoints, setWithoutEndpoints] = React.useState(false);
    const [open, setOpen] = React.useState<Record<ServiceSection, boolean>>({ node: true, cluster: false });

    const filtered = query.trim() !== '' || vipClass !== ALL || protocol !== ALL || namespace !== ALL || withoutEndpoints;
    const visible = React.useMemo(() => {
        const facets: ServiceFacets = {
            query,
            vipClass: vipClass === ALL ? undefined : (vipClass as VipClass),
            protocol: protocol === ALL ? undefined : protocol,
            namespace: namespace === ALL ? undefined : namespace,
            withoutEndpoints,
        };
        return groups.filter((group) => serviceGroupMatches(group, facets));
    }, [groups, query, vipClass, protocol, namespace, withoutEndpoints]);
    const bySection = (list: ServiceGroupView[], section: ServiceSection) => list.filter((group) => group.section === section);
    const nodeAll = bySection(groups, 'node');
    const clusterAll = bySection(groups, 'cluster');
    const nodeRows = React.useMemo(() => bySection(visible, 'node'), [visible]);
    const clusterRows = React.useMemo(() => bySection(visible, 'cluster'), [visible]);

    const nodeName =
        nodeAll.flatMap((group) => group.loadBalancers).map((row) => scopeOf(row).node).find(Boolean) ?? databaseNode;
    const sourcesOf = React.useCallback((uuid: string) => sourcesByUuid.get(uuid) ?? [], [sourcesByUuid]);
    const expandedContent = (group: ServiceGroupView) => (
        <ServiceDetail
            group={group}
            ownerOf={ownerOf}
            databaseNode={databaseNode}
            onDeclared={onDeclared}
            sourcesOf={sourcesOf}
        />
    );

    const serviceCount = new Set(groups.map((group) => group.label)).size;
    const namespaces = [...counts.namespaces.entries()].sort(([a], [b]) => a.localeCompare(b));
    const protocols = [...counts.protocols.entries()].sort(([a], [b]) => a.localeCompare(b));

    return (
        <>
            <Toolbar inset={{ default: 'insetNone' }} className="pf-u-pb-sm">
                <ToolbarContent>
                    <ToolbarItem>
                        <TextInput
                            aria-label="Filter services"
                            type="search"
                            placeholder={`Filter ${plural(serviceCount, 'Service')}`}
                            value={query}
                            onChange={(_event, value) => setQuery(value)}
                        />
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect aria-label="Filter by type" value={vipClass} onChange={(_event, value) => setVipClass(value)}>
                            <FormSelectOption value={ALL} label="All types" />
                            {VIP_CLASSES.filter((value) => counts.classes.has(value)).map((value) => (
                                <FormSelectOption key={value} value={value} label={`${value} (${counts.classes.get(value)})`} />
                            ))}
                        </FormSelect>
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect aria-label="Filter by protocol" value={protocol} onChange={(_event, value) => setProtocol(value)}>
                            <FormSelectOption value={ALL} label="All protocols" />
                            {protocols.map(([value, count]) => (
                                <FormSelectOption key={value} value={value} label={`${value.toUpperCase()} (${count})`} />
                            ))}
                        </FormSelect>
                    </ToolbarItem>
                    <ToolbarItem>
                        <FormSelect
                            aria-label="Filter by namespace"
                            value={namespace}
                            onChange={(_event, value) => setNamespace(value)}
                        >
                            <FormSelectOption value={ALL} label={`All namespaces (${namespaces.length})`} />
                            {namespaces.map(([value, count]) => (
                                <FormSelectOption key={value} value={value} label={`${value} (${count})`} />
                            ))}
                        </FormSelect>
                    </ToolbarItem>
                    <ToolbarItem alignSelf="center">
                        <Checkbox
                            id="services-without-endpoints"
                            label={`No endpoints (${plural(counts.servicesWithoutEndpoints, 'Service')})`}
                            isChecked={withoutEndpoints}
                            onChange={(_event, checked) => setWithoutEndpoints(checked)}
                        />
                    </ToolbarItem>
                </ToolbarContent>
            </Toolbar>
            <div className="pf-u-mb-xs" data-testid="services-summary">
                Load balancers: {splitSummaryText(attachment, counts.servicesWithoutEndpoints)}
            </div>
            <div className="pf-u-mb-sm" style={SUBTLE} data-testid="services-basis">
                {split.total > 0 && (
                    <>
                        Outlined types are inferred from OVN
                        {networks.serviceNetworks.length > 0
                            ? ` and the service network ${networks.serviceNetworks.join(', ')}`
                            : networks.error
                                ? ` alone: the cluster Network config could not be read (${networks.error}), so only the node's own subnet counts as external`
                                : networks.loaded
                                    ? ' alone: the cluster Network config names no service network'
                                    : ' (reading the service network…)'}
                        ; expanding a Service reads its declared type.
                    </>
                )}
                {databaseNode ? ` Load_Balancer rows from node ${databaseNode}.` : ''}
            </div>
            <ServiceSectionView
                section="node"
                title="On this node"
                note={nodeName}
                allRows={nodeAll}
                rows={nodeRows}
                loadBalancerCount={split.here}
                filtered={filtered}
                isExpanded={open.node}
                onToggle={(expanded) => setOpen((current) => ({ ...current, node: expanded }))}
                expandedContent={expandedContent}
                surface={surface}
            />
            <ServiceSectionView
                section="cluster"
                title="Cluster-wide"
                note={sharedNote(clusterAll)}
                allRows={clusterAll}
                rows={clusterRows}
                loadBalancerCount={split.clusterWide}
                filtered={filtered}
                isExpanded={open.cluster}
                onToggle={(expanded) => setOpen((current) => ({ ...current, cluster: expanded }))}
                expandedContent={expandedContent}
                surface={surface}
            />
        </>
    );
};

export default ServicesView;
