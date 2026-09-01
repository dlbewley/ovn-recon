import {
    LogicalDatabase,
    LogicalRouterPortRow,
    LogicalSwitchPortRow,
} from '../types';
import { LadderConstruct } from './logicalLadderModel';

/**
 * Per-OVN-kind drawer behavior as DATA (ovn-recon-jxh), mirroring the physical
 * view's nodeKindRegistry. Today OVN Recon models three kinds — routers,
 * switches, and the synthesized bridge-mapping constructs — but OVN defines
 * many more (Load_Balancer, ACL, Port_Group, ...) that the collector does not
 * yet gather. The registry is the seam they plug into: adding a kind is one
 * collector table command, one types row, and one entry here — the drawer
 * shell never changes, and unknown kinds fall back to a generic entry rather
 * than breaking.
 */

/** How many port rows the Config tab inlines before pointing at the download. */
const MAX_RAW_PORT_ROWS = 100;

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
    rawRows(construct: LadderConstruct, database: LogicalDatabase): Record<string, unknown> | null;
}

/** Find a row by uuid first (node view), then by name (merged cluster view,
 * where the surviving uuid belongs to one representative zone). */
const findRow = <T extends { uuid: string; name: string }>(
    rows: T[] | undefined,
    construct: LadderConstruct,
): T | undefined =>
    rows?.find((row) => row.uuid === construct.uuid) ?? rows?.find((row) => row.name === construct.name);

const capPorts = <T,>(ports: T[]): { ports: T[]; portsOmitted?: number } =>
    ports.length > MAX_RAW_PORT_ROWS
        ? { ports: ports.slice(0, MAX_RAW_PORT_ROWS), portsOmitted: ports.length - MAX_RAW_PORT_ROWS }
        : { ports };

const routerKind: OvnKindDefinition = {
    table: 'Logical_Router',
    rawRows(construct, database) {
        const row = findRow(database.logicalRouters, construct);
        if (!row) return null;
        const portByUuid = new Map(database.logicalRouterPorts.map((port) => [port.uuid, port]));
        const natByUuid = new Map((database.nats ?? []).map((nat) => [nat.uuid, nat]));
        const routeByUuid = new Map((database.staticRoutes ?? []).map((route) => [route.uuid, route]));
        return {
            logicalRouter: row,
            ...capPorts(
                row.ports
                    .map((uuid) => portByUuid.get(uuid))
                    .filter((port): port is LogicalRouterPortRow => Boolean(port)),
            ),
            nat: (row.nat ?? []).map((uuid) => natByUuid.get(uuid)).filter(Boolean),
            staticRoutes: (row.staticRoutes ?? []).map((uuid) => routeByUuid.get(uuid)).filter(Boolean),
        };
    },
};

const switchKind: OvnKindDefinition = {
    table: 'Logical_Switch',
    rawRows(construct, database) {
        const row = findRow(database.logicalSwitches, construct);
        if (!row) return null;
        const portByUuid = new Map(database.logicalSwitchPorts.map((port) => [port.uuid, port]));
        return {
            logicalSwitch: row,
            ...capPorts(
                row.ports
                    .map((uuid) => portByUuid.get(uuid))
                    .filter((port): port is LogicalSwitchPortRow => Boolean(port)),
            ),
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
): { source: 'nb-rows' | 'model'; payload: Record<string, unknown> } => {
    if (database) {
        const rows = ovnKindFor(construct).rawRows(construct, database);
        if (rows) return { source: 'nb-rows', payload: rows };
    }
    return { source: 'model', payload: { construct } };
};
