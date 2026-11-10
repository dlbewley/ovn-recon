import { OvnRecon } from '../types';
import { INTEGRATION_OFF, ovnReconPathFor, resolveIntegrationFlags, selectPrimaryOvnRecon } from './consoleIntegration';

const recon = (
    name: string,
    creationTimestamp: string,
    integration?: { resourceTabs?: boolean; resourceActions?: boolean },
): OvnRecon => ({
    apiVersion: 'recon.bewley.net/v1beta1',
    kind: 'OvnRecon',
    metadata: { name, creationTimestamp },
    status: integration ? { effective: { consolePlugin: { integration } } } : undefined,
});

describe('selectPrimaryOvnRecon', () => {
    it('picks the oldest, as the operator does', () => {
        const older = recon('b', '2026-01-01T00:00:00Z');
        const newer = recon('a', '2026-02-01T00:00:00Z');
        expect(selectPrimaryOvnRecon([newer, older])).toBe(older);
    });

    it('breaks a creation-time tie by name', () => {
        const a = recon('a', '2026-01-01T00:00:00Z');
        const b = recon('b', '2026-01-01T00:00:00Z');
        expect(selectPrimaryOvnRecon([b, a])).toBe(a);
    });

    it('has no primary without instances', () => {
        expect(selectPrimaryOvnRecon([])).toBeUndefined();
        expect(selectPrimaryOvnRecon(undefined)).toBeUndefined();
    });
});

describe('resolveIntegrationFlags', () => {
    it('reads the primary instance, not any other', () => {
        const primary = recon('primary', '2026-01-01T00:00:00Z', { resourceTabs: false, resourceActions: false });
        const other = recon('other', '2026-03-01T00:00:00Z', { resourceTabs: true, resourceActions: true });
        expect(resolveIntegrationFlags([other, primary], true, undefined)).toEqual(INTEGRATION_OFF);
    });

    it('accepts only a literal true', () => {
        const odd = recon('odd', '2026-01-01T00:00:00Z');
        (odd as unknown as { status: unknown }).status = {
            effective: { consolePlugin: { integration: { resourceTabs: 'true', resourceActions: 1 } } },
        };
        expect(resolveIntegrationFlags([odd], true, undefined)).toEqual(INTEGRATION_OFF);
    });
});

describe('ovnReconPathFor', () => {
    it('opens a Node in its physical topology', () => {
        expect(ovnReconPathFor({ kind: 'Node', metadata: { name: 'worker-1' } }))
            .toBe('/ovn-recon/node-network-state/worker-1');
    });

    it('opens each network kind on its network page', () => {
        expect(ovnReconPathFor({ kind: 'ClusterUserDefinedNetwork', metadata: { name: 'vlan-1924' } }))
            .toBe('/ovn-recon/networks/cudn/vlan-1924');
        expect(ovnReconPathFor({ kind: 'UserDefinedNetwork', metadata: { name: 'blue', namespace: 'tenant' } }))
            .toBe('/ovn-recon/networks/udn/tenant/blue');
        expect(ovnReconPathFor({ kind: 'NetworkAttachmentDefinition', metadata: { name: 'vm-igb', namespace: 'default' } }))
            .toBe('/ovn-recon/networks/nad/default/vm-igb');
    });

    it('falls back to the given kind when the object carries none', () => {
        expect(ovnReconPathFor({ metadata: { name: 'worker-1' } }, 'Node')).toBe('/ovn-recon/node-network-state/worker-1');
    });

    it('opens nothing for an incomplete or unrelated object', () => {
        expect(ovnReconPathFor({ kind: 'Node', metadata: {} })).toBeUndefined();
        expect(ovnReconPathFor({ kind: 'UserDefinedNetwork', metadata: { name: 'no-namespace' } })).toBeUndefined();
        expect(ovnReconPathFor({ kind: 'Pod', metadata: { name: 'p', namespace: 'n' } })).toBeUndefined();
        expect(ovnReconPathFor(undefined)).toBeUndefined();
    });
});
