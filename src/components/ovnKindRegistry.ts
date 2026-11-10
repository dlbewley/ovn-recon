import {
    GatewayChassisRow,
    LogicalDatabase,
    LogicalRouterPortRow,
    LogicalSwitchPortRow,
} from '../types';
import { LadderConstruct } from './logicalLadderModel';
import { policyIndexFor } from './policyIndex';
import { loadBalancersFor } from './serviceIndex';

/**
 * Per-OVN-kind drawer behavior as DATA (ovn-recon-jxh), mirroring the physical
 * view's nodeKindRegistry. Today OVN Recon models three kinds — routers,
 * switches, and the synthesized bridge-mapping constructs — but OVN defines
 * many more (Load_Balancer, ACL, Port_Group, ...) that are collected as rows
 * without being constructs of their own. The registry is the seam a new
 * construct kind plugs into: adding a kind is one
 * collector table command, one types row, and one entry here — the drawer
 * shell never changes, and unknown kinds fall back to a generic entry rather
 * than breaking.
 */

/** How many port rows the Config tab inlines before pointing at the download. */
const MAX_RAW_PORT_ROWS = 100;

export interface RawRowOptions {
    /** Port rows inlined before the rest are counted as omitted; default
     * MAX_RAW_PORT_ROWS. The construct detail page passes Infinity. */
    maxPorts?: number;
}

export interface OvnKindDefinition {
    /** The OVN northbound table this kind renders from. */
    table: string;
    /**
     * Assemble the construct's raw NB rows — its own row plus the rows it
     * references — for the Config tab. `database` is the snapshot of one
     * representative node (cluster view: the first zone the construct appears
     * in); null when no database is at hand, in which case the caller falls
     * back to the construct itself.
     */
    rawRows(construct: LadderConstruct, database: LogicalDatabase, options?: RawRowOptions): Record<string, unknown> | null;
}

/** Find a row by uuid first (node view), then by name (merged cluster view,
 * where the surviving uuid belongs to one representative zone). */
const findRow = <T extends { uuid: string; name: string }>(
    rows: T[] | undefined,
    construct: LadderConstruct,
): T | undefined =>
    rows?.find((row) => row.uuid === construct.uuid) ?? rows?.find((row) => row.name === construct.name);

const capPorts = <T,>(ports: T[], max = MAX_RAW_PORT_ROWS): { ports: T[]; portsOmitted?: number } =>
    ports.length > max ? { ports: ports.slice(0, max), portsOmitted: ports.length - max } : { ports };

/**
 * The Load_Balancer rows set directly on a switch or router and the
 * Load_Balancer_Group rows it attaches, when the database carries the
 * services section and the construct references any. Group members stay
 * uuids: clusterLBGroup alone holds every cluster-scoped Service, which is
 * the Services tab's table, not a Config payload.
 */
const loadBalancerRows = (
    construct: LadderConstruct,
    database: LogicalDatabase,
): { loadBalancers?: unknown[]; loadBalancerGroups?: unknown[] } => {
    const attachment = loadBalancersFor(construct, database);
    if (!attachment) return {};
    return {
        ...(attachment.direct.length > 0 ? { loadBalancers: attachment.direct } : {}),
        ...(attachment.viaGroups.length > 0
            ? { loadBalancerGroups: attachment.viaGroups.map(({ group }) => group) }
            : {}),
    };
};

/**
 * The ACL rows set on the switch's own acls column, when the database carries
 * the policy section and the switch references any. The ACLs that reach its
 * ports through port groups are the Ports tab's business, per port.
 */
const directAclRows = (switchUuid: string, database: LogicalDatabase): { acls?: unknown[] } => {
    const direct = policyIndexFor(database).aclsBySwitch.get(switchUuid)?.direct ?? [];
    return direct.length > 0 ? { acls: direct } : {};
};

const routerKind: OvnKindDefinition = {
    table: 'Logical_Router',
    rawRows(construct, database, options) {
        const row = findRow(database.logicalRouters, construct);
        if (!row) return null;
        const portByUuid = new Map(database.logicalRouterPorts.map((port) => [port.uuid, port]));
        const natByUuid = new Map((database.nats ?? []).map((nat) => [nat.uuid, nat]));
        const routeByUuid = new Map((database.staticRoutes ?? []).map((route) => [route.uuid, route]));
        const gatewayChassisByUuid = new Map(
            (database.gatewayChassis ?? []).map((chassis) => [chassis.uuid, chassis]),
        );
        const ports = row.ports
            .map((uuid) => portByUuid.get(uuid))
            .filter((port): port is LogicalRouterPortRow => Boolean(port));
        // Gateway_Chassis rows the router's ports reference; omitted when the
        // snapshot predates the table or the router has no gateway port.
        const gatewayChassis = ports
            .flatMap((port) => port.gatewayChassis ?? [])
            .map((uuid) => gatewayChassisByUuid.get(uuid))
            .filter((chassis): chassis is GatewayChassisRow => Boolean(chassis));
        return {
            logicalRouter: row,
            ...capPorts(ports, options?.maxPorts),
            nat: (row.nat ?? []).map((uuid) => natByUuid.get(uuid)).filter(Boolean),
            staticRoutes: (row.staticRoutes ?? []).map((uuid) => routeByUuid.get(uuid)).filter(Boolean),
            ...(gatewayChassis.length > 0 ? { gatewayChassis } : {}),
            ...loadBalancerRows(construct, database),
        };
    },
};

const switchKind: OvnKindDefinition = {
    table: 'Logical_Switch',
    rawRows(construct, database, options) {
        const row = findRow(database.logicalSwitches, construct);
        if (!row) return null;
        const portByUuid = new Map(database.logicalSwitchPorts.map((port) => [port.uuid, port]));
        return {
            logicalSwitch: row,
            ...capPorts(
                row.ports
                    .map((uuid) => portByUuid.get(uuid))
                    .filter((port): port is LogicalSwitchPortRow => Boolean(port)),
                options?.maxPorts,
            ),
            ...directAclRows(row.uuid, database),
            ...loadBalancerRows(construct, database),
        };
    },
};

/** Bridge mappings are synthesized per (network, localnet) from chassis
 * ovn-bridge-mappings plus the localnet switch ports that reference them —
 * there is no single NB row, so Config shows both sources. */
const physnetKind: OvnKindDefinition = {
    table: 'Chassis ovn-bridge-mappings',
    rawRows(construct, database) {
        const mappings = (database.bridgeMappings ?? []).filter(
            (mapping) => mapping.localnet === construct.name,
        );
        const localnetPorts = database.logicalSwitchPorts.filter(
            (port) => port.type === 'localnet' && port.options?.['network_name'] === construct.name,
        );
        if (mappings.length === 0 && localnetPorts.length === 0) return null;
        return { bridgeMappings: mappings, localnetPorts };
    },
};

/** Kinds the model does not know yet degrade to this rather than breaking. */
const fallbackKind: OvnKindDefinition = {
    table: 'OVN northbound',
    rawRows() {
        return null;
    },
};

const registry: Record<string, OvnKindDefinition> = {
    router: routerKind,
    switch: switchKind,
    physnet: physnetKind,
};

export const ovnKindFor = (construct: LadderConstruct): OvnKindDefinition =>
    registry[construct.kind] ?? fallbackKind;

/**
 * The Config tab's payload: the registry's raw rows when a database is at
 * hand and the rows resolve, else the construct as the model retains it —
 * honest about being derived rather than raw.
 */
export const configPayloadFor = (
    construct: LadderConstruct,
    database: LogicalDatabase | null,
    options?: RawRowOptions,
): { source: 'nb-rows' | 'model'; payload: Record<string, unknown> } => {
    if (database) {
        const rows = ovnKindFor(construct).rawRows(construct, database, options);
        if (rows) return { source: 'nb-rows', payload: rows };
    }
    return { source: 'model', payload: { construct } };
};
