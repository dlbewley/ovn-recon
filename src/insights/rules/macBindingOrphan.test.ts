import type { LogicalTopologySnapshot } from '../../types';
import { loadSnapshot, logicalContext } from '../testing';
import { macBindingOrphan, StaticMacBindingRow } from './macBindingOrphan';

/**
 * cnv-1 with Static_MAC_Binding rows added in the shape ovn-recon-e2b.7 plans: the
 * collector does not send the table yet, so no capture holds it.
 */
const withBindings = (rows: StaticMacBindingRow[]): LogicalTopologySnapshot => {
    const snapshot = loadSnapshot('cnv-1');
    (snapshot.database as unknown as { staticMacBindings: StaticMacBindingRow[] }).staticMacBindings = rows;
    return snapshot;
};

const binding = (logicalPort: string): StaticMacBindingRow => ({
    uuid: `smb-${logicalPort}`,
    logicalPort,
    ip: '169.254.0.4',
    mac: '0a:58:a9:fe:00:04',
    overrideDynamicMac: true
});

describe('mac-binding-orphan', () => {
    it('fires for a binding whose router port does not exist, on the zone', () => {
        const findings = macBindingOrphan.evaluate(logicalContext(withBindings([binding('rtoe-GR_gone')])));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'mac-binding-orphan',
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'Node', name: 'cnv-1' }) },
            summary: 'A static MAC binding for 169.254.0.4 names router port rtoe-GR_gone, which does not exist on cnv-1.'
        }));
    });

    it('stays quiet for a binding on a router port the zone holds', () => {
        const snapshot = loadSnapshot('cnv-1');
        const port = snapshot.database!.logicalRouterPorts[0].name;
        expect(macBindingOrphan.evaluate(logicalContext(withBindings([binding(port)])))).toEqual([]);
    });

    it('stays quiet while the collector does not send the table', () => {
        expect(macBindingOrphan.evaluate(logicalContext(loadSnapshot('cnv-1')))).toEqual([]);
    });
});
