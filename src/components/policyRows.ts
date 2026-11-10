import { ACLRow, AddressSetRow, LogicalDatabase, PortGroupRow } from '../types';
import { matchRefs, PolicyIndex, policyForPort } from './policyIndex';

/**
 * The construct detail page's Policy tab as rows (ovn-recon-e2b.8, decision
 * 9): the ACLs that apply on one switch, the port groups with a port on it,
 * and the address sets those ACLs name. Pure functions over one zone's
 * policy index; everything is per zone, as policyIndex.ts explains.
 */

/** One ACL as it applies on the switch. */
export interface SwitchAclRow {
    acl: ACLRow;
    /** The port groups with a port on the switch that carry this ACL. */
    via: PortGroupRow[];
    /** Set on the switch's own acls column. */
    direct: boolean;
    /** Distinct ports of the switch the ACL reaches. */
    portsHere: number;
}

/** The switch's ports, by uuid, in this zone. */
const switchPortSet = (database: LogicalDatabase, switchUuid: string): Set<string> => {
    const row = database.logicalSwitches.find((candidate) => candidate.uuid === switchUuid);
    return new Set(row?.ports ?? []);
};

/** A group's member ports that are on the switch. */
const portsOnSwitch = (group: PortGroupRow, switchPorts: Set<string>): string[] =>
    (group.ports ?? []).filter((uuid) => switchPorts.has(uuid));

/**
 * Every ACL that applies on the switch (policyIndex.aclsBySwitch), in display
 * order, with the groups that bring it and the ports it reaches. With
 * `portUuid` (this zone's uuid of one port) only the ACLs on that port.
 */
export const switchAclRows = (
    index: PolicyIndex,
    database: LogicalDatabase,
    switchUuid: string,
    portUuid?: string,
): SwitchAclRow[] => {
    const switchAcls = index.aclsBySwitch.get(switchUuid);
    if (!switchAcls) return [];
    const switchPorts = switchPortSet(database, switchUuid);
    const directUuids = new Set(switchAcls.direct.map((acl) => acl.uuid));
    const groupsByAcl = new Map<string, PortGroupRow[]>();
    for (const { group, acls } of switchAcls.viaGroups) {
        for (const acl of acls) groupsByAcl.set(acl.uuid, [...(groupsByAcl.get(acl.uuid) ?? []), group]);
    }
    const row = (acl: ACLRow): SwitchAclRow => {
        const direct = directUuids.has(acl.uuid);
        const via = groupsByAcl.get(acl.uuid) ?? [];
        const reached = new Set<string>(direct ? switchPorts : []);
        for (const group of via) for (const uuid of portsOnSwitch(group, switchPorts)) reached.add(uuid);
        return { acl, via, direct, portsHere: reached.size };
    };
    if (portUuid) return policyForPort(index, portUuid).acls.map(({ acl }) => row(acl));
    return switchAcls.all.map(row);
};

/** One port group with a port on the switch. */
export interface SwitchPortGroupRow {
    group: PortGroupRow;
    /** Its member ports on this switch (uuids). */
    portsHere: string[];
    acls: ACLRow[];
}

/**
 * The port groups with at least one port on the switch, ACLs or not, and how
 * many of the zone's groups have none here (the empty Namespace groups, for
 * one: a namespace with no pod on this node).
 */
export const switchPortGroups = (
    index: PolicyIndex,
    database: LogicalDatabase,
    switchUuid: string,
): { here: SwitchPortGroupRow[]; elsewhere: number } => {
    const switchPorts = switchPortSet(database, switchUuid);
    const here: SwitchPortGroupRow[] = [];
    let elsewhere = 0;
    for (const group of index.portGroupByUuid.values()) {
        const ports = portsOnSwitch(group, switchPorts);
        if (ports.length === 0) {
            elsewhere += 1;
            continue;
        }
        here.push({ group, portsHere: ports, acls: index.aclsByPortGroup.get(group.uuid) ?? [] });
    }
    return { here, elsewhere };
};

/** An address set an ACL names, with how many of the listed ACLs name it. */
export interface ReferencedAddressSet {
    name: string;
    /** Undefined when no row of this zone carries the name. */
    row?: AddressSetRow;
    acls: number;
}

/** The address sets the ACLs' matches name (`$name`), each once, by name. */
export const referencedAddressSets = (index: PolicyIndex, acls: readonly ACLRow[]): ReferencedAddressSet[] => {
    const counts = new Map<string, number>();
    for (const acl of acls) {
        for (const name of matchRefs(acl).addressSets) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([name, count]) => ({ name, row: index.addressSetByName.get(name), acls: count }))
        .sort((a, b) => a.name.localeCompare(b.name));
};

/** The counts the Ports tab shows for one port: its groups and its ACLs. */
export const portPolicyCounts = (index: PolicyIndex, portUuid: string): { groups: number; acls: number } => {
    const policy = policyForPort(index, portUuid);
    return { groups: policy.groups.length, acls: policy.acls.length };
};
