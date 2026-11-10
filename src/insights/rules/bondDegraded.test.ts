import type { NodeNetworkConfigurationEnactment, NodeNetworkState } from '../../types';
import { clone, loadFixture, physicalContext } from '../testing';
import { bondDegraded } from './bondDegraded';

const bonded = loadFixture<NodeNetworkState>('nns', 'bonded-lldp.json');
const NODE = 'worker-2.example.com';

describe('bond-degraded', () => {
    it('fires when a member of a bond is down', () => {
        const nns = clone(bonded);
        nns.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === 'ens5f0np0') iface.state = 'down'; });

        const findings = bondDegraded.evaluate(physicalContext({ nns }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'graph-node', node: NODE, graphNodeId: 'iface:bond0' },
            summary: `Bond bond0 on ${NODE} has 1 of 2 members down.`
        }));
        expect(findings[0].evidence.map((e) => e.fact)).toEqual([
            'bond0 reports members ens2f0np0, ens5f0np0.',
            'Member ens5f0np0 is in state down.'
        ]);
    });

    it('counts a member an enactment declares but the bond no longer reports', () => {
        const enactment: NodeNetworkConfigurationEnactment = {
            apiVersion: 'nmstate.io/v1beta1',
            kind: 'NodeNetworkConfigurationEnactment',
            metadata: { name: `${NODE}.bond1`, labels: { 'nmstate.io/node': NODE, 'nmstate.io/policy': 'bond1' } },
            status: {
                desiredState: {
                    interfaces: [{
                        name: 'bond1',
                        type: 'bond',
                        'link-aggregation': { mode: '802.3ad', port: ['ens2f1np1', 'ens5f1np1', 'ens6f1np1'] }
                    } as { name: string; type: string }]
                }
            }
        };
        const findings = bondDegraded.evaluate(physicalContext({ nns: bonded, enactments: [enactment] }));

        expect(findings.map((f) => f.summary)).toEqual([`Bond bond1 on ${NODE} has 1 of 3 members down.`]);
        expect(findings[0].evidence.map((e) => e.fact)).toEqual([
            'bond1 reports members ens2f1np1, ens5f1np1.',
            `Enactment ${NODE}.bond1 declares ens6f1np1 a member of bond1, but the bond does not report it.`,
            'Member ens6f1np1 is not reported by the node.'
        ]);
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({
            kind: 'NodeNetworkConfigurationPolicy', name: 'bond1'
        }));
    });

    it('does not count a member nmstate does not manage as down', () => {
        const nns = clone(bonded);
        nns.status!.currentState!.interfaces.forEach((iface) => { if (iface.name === 'ens5f0np0') iface.state = 'ignore'; });
        expect(bondDegraded.evaluate(physicalContext({ nns }))).toEqual([]);
    });

    it.each(['bonded-lldp.json', 'sriov.json'])('is quiet on the %s capture, whose bonds are whole', (name) => {
        const nns = loadFixture<NodeNetworkState>('nns', name);
        expect(bondDegraded.evaluate(physicalContext({ nns }))).toEqual([]);
    });
});
