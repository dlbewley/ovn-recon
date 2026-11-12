import type { LogicalDatabase } from '../../types';
import { snapshotFact, zoneSubject } from '../logical';
import { makeFinding, nodeRef } from '../refs';
import type { LogicalRule } from '../types';

/**
 * One NB Static_MAC_Binding row, in the shape ovn-recon-e2b.7 plans to collect it
 * (`staticMacBindings` in the database). Not in the snapshot contract yet: until the
 * collector sends the key, the rule below reports nothing.
 */
export interface StaticMacBindingRow {
    uuid: string;
    /** A Logical_Router_Port name. */
    logicalPort: string;
    ip: string;
    mac: string;
    overrideDynamicMac?: boolean;
}

type WithStaticMacBindings = LogicalDatabase & { staticMacBindings?: StaticMacBindingRow[] };

/**
 * mac-binding-orphan: a Static_MAC_Binding names a router port the zone does not
 * hold. One finding per row, on the zone: with its port gone the row belongs to no
 * one router.
 */
export const macBindingOrphan: LogicalRule = {
    id: 'mac-binding-orphan',
    severity: 'warning',
    scope: 'node',
    domain: 'logical',
    title: 'Static MAC binding on a missing router port',
    evaluate: ({ nodeName, snapshot }) => {
        const database = snapshot.database as WithStaticMacBindings | undefined;
        const rows = database?.staticMacBindings;
        if (!database || !rows) return [];
        const routerPorts = new Set(database.logicalRouterPorts.map((port) => port.name));
        return rows.filter((row) => !routerPorts.has(row.logicalPort)).map((row) => makeFinding({
            ruleId: macBindingOrphan.id,
            severity: macBindingOrphan.severity,
            subject: zoneSubject(nodeName),
            scope: { node: nodeName },
            summary: `A static MAC binding for ${row.ip} names router port ${row.logicalPort}, `
                + `which does not exist on ${nodeName}.`,
            evidence: [
                snapshotFact(nodeName, `Static_MAC_Binding ${row.ip} to ${row.mac} names logical_port ${row.logicalPort}.`,
                    `Static_MAC_Binding[uuid=${row.uuid}].logical_port`),
                snapshotFact(nodeName, `No Logical_Router_Port named ${row.logicalPort} exists in this zone.`,
                    'Logical_Router_Port.name')
            ],
            remedy: {
                text: 'OVN-Kubernetes writes these bindings for its gateway routers, so one left pointing at a '
                    + 'removed port is a leftover it did not clean up. Look for errors in the ovnkube-controller '
                    + `container of the ovnkube-node pod on ${nodeName}.`,
                target: nodeRef(nodeName),
                verb: 'view'
            }
        }, row.uuid));
    }
};
