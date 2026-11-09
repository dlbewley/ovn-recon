import { ACLRow, AddressSetRow, LogicalDatabase, LogicalSwitchRow, PortGroupRow } from '../types';
import { OWNER_NAME_KEY, OWNER_TYPE_KEY } from './ovnOwner';

/**
 * The policy plane as a pure model over one node's database (ovn-recon-e2b.5):
 * which port groups a switch port belongs to and which ACLs apply to it.
 *
 * An ACL takes effect where it is attached, and there are two places. Almost
 * all hang on a Port_Group (Port_Group.acls) and apply to that group's member
 * ports; a few sit on a Logical_Switch (Logical_Switch.acls) and apply to
 * every port of the switch. So:
 *
 *   ACLs on a port   = ACLs of the groups containing the port
 *                      + the ACLs set on its switch
 *   ACLs on a switch = the ACLs set on it
 *                      + ACLs of every group with a port on the switch
 *
 * That is the apply side. The match of an ACL names more port groups (`@name`)
 * and address sets (`$name`): the peer side, which `matchRefs` parses.
 *
 * Under interconnect a zone's port groups list only that zone's own ports, so
 * everything here is per zone: a pod on another node is in no group of this
 * database.
 *
 * The rows come from the optional `policy` section. Without it every index is
 * empty and `present` is false, which lets a caller tell "not collected" from
 * "no policy".
 */

export interface SwitchAcls {
    /** ACLs set on the switch's own `acls` column. */
    direct: ACLRow[];
    /**
     * The port groups that have a port on the switch and carry ACLs, with the
     * ACLs each brings and how many of the switch's ports are members.
     */
    viaGroups: Array<{ group: PortGroupRow; acls: ACLRow[]; ports: number }>;
    /** `direct` plus every group's ACLs, each ACL once. */
    all: ACLRow[];
}

export interface PolicyIndex {
    /** False when the database carries no policy section. */
    present: boolean;
    portGroupByUuid: Map<string, PortGroupRow>;
    /** By Port_Group.name, which is what `@name` in a match refers to. */
    portGroupByName: Map<string, PortGroupRow>;
    /** By Address_Set.name, which is what `$name` in a match refers to. */
    addressSetByName: Map<string, AddressSetRow>;
    aclByUuid: Map<string, ACLRow>;
    /** Logical_Switch_Port uuid to the groups it is a member of. */
    portGroupsByPort: Map<string, PortGroupRow[]>;
    /** Port_Group uuid to its ACL rows. */
    aclsByPortGroup: Map<string, ACLRow[]>;
    /** Logical_Switch uuid to the ACLs that apply on it. */
    aclsBySwitch: Map<string, SwitchAcls>;
    /** Logical_Switch_Port uuid to the switch that holds it. */
    switchByPort: Map<string, LogicalSwitchRow>;
}

const emptyIndex = (): PolicyIndex => ({
    present: false,
    portGroupByUuid: new Map(),
    portGroupByName: new Map(),
    addressSetByName: new Map(),
    aclByUuid: new Map(),
    portGroupsByPort: new Map(),
    aclsByPortGroup: new Map(),
    aclsBySwitch: new Map(),
    switchByPort: new Map(),
});

/** The index of a database without the policy section. */
export const EMPTY_POLICY_INDEX: PolicyIndex = emptyIndex();

/**
 * True when the database carries the policy section. `acls` and `portGroups`
 * are both needed to say what applies where; `addressSets` only resolves
 * names in a match, so its absence (a table that failed on its own) leaves
 * those names unresolved rather than hiding the section.
 */
export const hasPolicySection = (
    database: LogicalDatabase | null | undefined,
): database is LogicalDatabase & { acls: ACLRow[]; portGroups: PortGroupRow[] } =>
    database?.acls !== undefined && database.portGroups !== undefined;

const DIRECTION_ORDER: Record<string, number> = { 'from-lport': 0, 'to-lport': 1 };

/**
 * Display order for ACLs: by direction (from-lport, then to-lport), then in
 * the order OVN evaluates them: lower tier first, higher priority first.
 */
export const compareAcls = (a: ACLRow, b: ACLRow): number =>
    (DIRECTION_ORDER[a.direction] ?? 2) - (DIRECTION_ORDER[b.direction] ?? 2) ||
    a.direction.localeCompare(b.direction) ||
    a.tier - b.tier ||
    b.priority - a.priority ||
    (a.name ?? '').localeCompare(b.name ?? '') ||
    a.uuid.localeCompare(b.uuid);

/** Port groups by owner type, then readable name, then the hashed name. */
export const comparePortGroups = (a: PortGroupRow, b: PortGroupRow): number =>
    (a.externalIds?.[OWNER_TYPE_KEY] ?? '').localeCompare(b.externalIds?.[OWNER_TYPE_KEY] ?? '') ||
    (a.externalIds?.[OWNER_NAME_KEY] ?? '').localeCompare(b.externalIds?.[OWNER_NAME_KEY] ?? '') ||
    a.name.localeCompare(b.name);

const present = <T>(value: T | undefined): value is T => value !== undefined;

const indexCache = new WeakMap<LogicalDatabase, PolicyIndex>();

/**
 * The indexes over a database's policy section, built once per database
 * object. A database without the section (or no database) yields the empty
 * index with `present: false`.
 */
export const policyIndexFor = (database: LogicalDatabase | null | undefined): PolicyIndex => {
    if (!hasPolicySection(database)) return EMPTY_POLICY_INDEX;
    const cached = indexCache.get(database);
    if (cached) return cached;

    const index = emptyIndex();
    index.present = true;
    for (const acl of database.acls) index.aclByUuid.set(acl.uuid, acl);
    for (const set of database.addressSets ?? []) index.addressSetByName.set(set.name, set);
    for (const logicalSwitch of database.logicalSwitches) {
        for (const portUuid of logicalSwitch.ports) index.switchByPort.set(portUuid, logicalSwitch);
    }

    // Per switch: the groups that reach it, with their member count there.
    const groupsBySwitch = new Map<string, Map<string, number>>();
    for (const group of database.portGroups) {
        index.portGroupByUuid.set(group.uuid, group);
        index.portGroupByName.set(group.name, group);
        index.aclsByPortGroup.set(
            group.uuid,
            (group.acls ?? []).map((uuid) => index.aclByUuid.get(uuid)).filter(present).sort(compareAcls),
        );
        for (const portUuid of group.ports ?? []) {
            const groups = index.portGroupsByPort.get(portUuid) ?? [];
            groups.push(group);
            index.portGroupsByPort.set(portUuid, groups);

            const logicalSwitch = index.switchByPort.get(portUuid);
            if (!logicalSwitch) continue;
            const reached = groupsBySwitch.get(logicalSwitch.uuid) ?? new Map<string, number>();
            reached.set(group.uuid, (reached.get(group.uuid) ?? 0) + 1);
            groupsBySwitch.set(logicalSwitch.uuid, reached);
        }
    }
    for (const groups of index.portGroupsByPort.values()) groups.sort(comparePortGroups);

    for (const logicalSwitch of database.logicalSwitches) {
        const direct = (logicalSwitch.acls ?? [])
            .map((uuid) => index.aclByUuid.get(uuid))
            .filter(present)
            .sort(compareAcls);
        const viaGroups = [...(groupsBySwitch.get(logicalSwitch.uuid) ?? new Map<string, number>()).entries()]
            .map(([groupUuid, ports]) => ({
                group: index.portGroupByUuid.get(groupUuid)!,
                acls: index.aclsByPortGroup.get(groupUuid) ?? [],
                ports,
            }))
            .filter((entry) => entry.acls.length > 0)
            .sort((a, b) => comparePortGroups(a.group, b.group));
        const seen = new Set<string>();
        const all: ACLRow[] = [];
        for (const acl of [...direct, ...viaGroups.flatMap((entry) => entry.acls)]) {
            if (seen.has(acl.uuid)) continue;
            seen.add(acl.uuid);
            all.push(acl);
        }
        index.aclsBySwitch.set(logicalSwitch.uuid, { direct, viaGroups, all: all.sort(compareAcls) });
    }

    indexCache.set(database, index);
    return index;
};

/** The part of a ladder construct or port the lookups need. */
export interface NamedRow {
    uuid: string;
    name: string;
}

/**
 * This database's row for a construct or port: by uuid, then by name. In the
 * merged cluster view the uuid at hand may be another zone's, and only the
 * name is shared. Undefined when this zone holds no such row.
 */
export const zoneRowFor = <T extends NamedRow>(rows: T[] | undefined, subject: NamedRow): T | undefined =>
    rows?.find((row) => row.uuid === subject.uuid) ?? rows?.find((row) => row.name === subject.name);

/** The names a match refers to, each once, in order of appearance. */
export interface MatchRefs {
    /** `@name`: port groups. */
    portGroups: string[];
    /** `$name`: address sets. */
    addressSets: string[];
}

const QUOTED = /"(?:[^"\\]|\\.)*"/g;
const REFERENCE = /([@$])([A-Za-z_][A-Za-z0-9_.]*)/g;

/**
 * The port groups (`@name`) and address sets (`$name`) an ACL's match names.
 * Quoted strings (port names) are not scanned.
 */
export const matchRefs = (acl: Pick<ACLRow, 'match'> | string): MatchRefs => {
    const match = (typeof acl === 'string' ? acl : acl.match) ?? '';
    const portGroups: string[] = [];
    const addressSets: string[] = [];
    for (const [, sigil, name] of match.replace(QUOTED, '""').matchAll(REFERENCE)) {
        const names = sigil === '@' ? portGroups : addressSets;
        if (!names.includes(name)) names.push(name);
    }
    return { portGroups, addressSets };
};

/** A match's references resolved against the index; `row` is undefined for a
 * name no row carries. */
export interface ResolvedMatchRefs {
    portGroups: Array<{ name: string; row?: PortGroupRow }>;
    addressSets: Array<{ name: string; row?: AddressSetRow }>;
}

export const resolveMatchRefs = (index: PolicyIndex, acl: Pick<ACLRow, 'match'> | string): ResolvedMatchRefs => {
    const refs = matchRefs(acl);
    return {
        portGroups: refs.portGroups.map((name) => ({ name, row: index.portGroupByName.get(name) })),
        addressSets: refs.addressSets.map((name) => ({ name, row: index.addressSetByName.get(name) })),
    };
};

/** An ACL as it applies to one port, with how it got there. */
export interface AppliedAcl {
    acl: ACLRow;
    /** The port group it is attached to; undefined for an ACL set on the switch. */
    group?: PortGroupRow;
}

export interface PortPolicy {
    /** The groups the port is a member of. */
    groups: PortGroupRow[];
    /** Every ACL that applies to the port, each once, in display order. */
    acls: AppliedAcl[];
}

/**
 * The policy on one port: its groups, and the ACLs of those groups plus the
 * ACLs set on its switch. `portUuid` is this database's uuid for the port
 * (see zoneRowFor).
 */
export const policyForPort = (index: PolicyIndex, portUuid: string): PortPolicy => {
    const groups = index.portGroupsByPort.get(portUuid) ?? [];
    const applied = new Map<string, AppliedAcl>();
    for (const group of groups) {
        for (const acl of index.aclsByPortGroup.get(group.uuid) ?? []) {
            if (!applied.has(acl.uuid)) applied.set(acl.uuid, { acl, group });
        }
    }
    const logicalSwitch = index.switchByPort.get(portUuid);
    for (const acl of (logicalSwitch && index.aclsBySwitch.get(logicalSwitch.uuid)?.direct) || []) {
        if (!applied.has(acl.uuid)) applied.set(acl.uuid, { acl });
    }
    return {
        groups,
        acls: [...applied.values()].sort((a, b) => compareAcls(a.acl, b.acl)),
    };
};

export interface SwitchAclSummary {
    /** ACLs set on the switch itself. */
    direct: number;
    /** Distinct ACLs that reach the switch's ports through port groups. */
    viaGroups: number;
    /** How many port groups bring them. */
    groups: number;
    /** Distinct ACLs in total. */
    total: number;
}

export const summarizeSwitchAcls = (acls: SwitchAcls | undefined): SwitchAclSummary => {
    if (!acls) return { direct: 0, viaGroups: 0, groups: 0, total: 0 };
    const viaGroups = new Set(acls.viaGroups.flatMap((entry) => entry.acls.map((acl) => acl.uuid)));
    return {
        direct: acls.direct.length,
        viaGroups: viaGroups.size,
        groups: acls.viaGroups.length,
        total: acls.all.length,
    };
};

/** The Overview line: "1 direct · 372 via 96 port groups", or "No ACLs". */
export const switchAclSummaryText = (summary: SwitchAclSummary): string => {
    const parts: string[] = [];
    if (summary.direct > 0) parts.push(`${summary.direct} direct`);
    if (summary.viaGroups > 0) {
        parts.push(`${summary.viaGroups} via ${summary.groups} port group${summary.groups === 1 ? '' : 's'}`);
    }
    return parts.length > 0 ? parts.join(' · ') : 'No ACLs';
};
