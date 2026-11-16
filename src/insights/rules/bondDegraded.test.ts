import type { Interface, NodeNetworkConfigurationEnactment, NodeNetworkState } from '../../types';
import { clone, loadFixture, physicalContext } from '../testing';
import { bondDegraded } from './bondDegraded';

const bonded = loadFixture<NodeNetworkState>('nns', 'bonded-lldp.json');
const NODE = 'worker-2.example.com';

// Kernel bond0 under br-ex, and OVS bond bond1 (ens161 + ens256) inside br-vmdata.
const ovsBonded = loadFixture<NodeNetworkState>('nns', 'ovs-bond-slb.json');
const BOND1_PORT = 'status.currentState.interfaces[name=br-vmdata].bridge.port[name=bond1].link-aggregation.port';

const withInterfaces = (
    nns: NodeNetworkState,
    change: (interfaces: Interface[]) => void
): NodeNetworkState => {
    const copy = clone(nns);
    change(copy.status!.currentState!.interfaces);
    return copy;
};

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

    describe('OVS bonds (ovn-recon-1tw.4)', () => {
        it('fires on the bond\'s own node when a member of an OVS bond is down (ovn-recon-1tw.2)', () => {
            const nns = withInterfaces(ovsBonded, (interfaces) => interfaces.forEach((iface) => {
                if (iface.name === 'ens256') iface.state = 'down';
            }));

            const findings = bondDegraded.evaluate(physicalContext({ nns }));

            expect(findings).toHaveLength(1);
            expect(findings[0]).toEqual(expect.objectContaining({
                subject: { kind: 'graph-node', node: 'worker-1', graphNodeId: 'ovs-bond:br-vmdata/bond1' },
                summary: 'OVS bond bond1 in bridge br-vmdata on worker-1 has 1 of 2 members down.'
            }));
            expect(findings[0].evidence.map((e) => [e.fact, e.path])).toEqual([
                ['Bridge br-vmdata reports OVS bond bond1 with members ens161, ens256.', BOND1_PORT],
                ['Member ens256 is in state down.', 'status.currentState.interfaces[name=ens256].state']
            ]);
            expect(findings[0].remedy).toEqual(expect.objectContaining({
                text: 'Check the links of ens256 on worker-1 and their switch ports. '
                    + 'ovs-appctl bond/show bond1 on the node shows which members OVS has enabled.',
                target: expect.objectContaining({ kind: 'Node', name: 'worker-1' })
            }));
        });

        it('counts a member the node no longer reports', () => {
            const nns = withInterfaces(ovsBonded, (interfaces) => {
                interfaces.splice(interfaces.findIndex((iface) => iface.name === 'ens256'), 1);
            });

            const findings = bondDegraded.evaluate(physicalContext({ nns }));

            expect(findings.map((f) => f.summary)).toEqual([
                'OVS bond bond1 in bridge br-vmdata on worker-1 has 1 of 2 members down.'
            ]);
            expect(findings[0].evidence[1]).toEqual(expect.objectContaining({
                fact: 'Member ens256 is not reported by the node.', path: 'status.currentState.interfaces'
            }));
        });

        it('counts a member an enactment declares but the bridge no longer reports in the bond', () => {
            const nns = withInterfaces(ovsBonded, (interfaces) => {
                const bridge = interfaces.find((iface) => iface.name === 'br-vmdata' && iface.type === 'ovs-bridge')!;
                const bond1 = bridge.bridge!.port!.find((port) => port.name === 'bond1')!;
                bond1['link-aggregation']!.port = [{ name: 'ens161' }];
                interfaces.splice(interfaces.findIndex((iface) => iface.name === 'ens256'), 1);
            });
            const enactment: NodeNetworkConfigurationEnactment = {
                apiVersion: 'nmstate.io/v1beta1',
                kind: 'NodeNetworkConfigurationEnactment',
                metadata: { name: 'worker-1.br-vmdata', labels: { 'nmstate.io/node': 'worker-1', 'nmstate.io/policy': 'br-vmdata' } },
                status: {
                    desiredState: {
                        interfaces: [{
                            name: 'br-vmdata',
                            type: 'ovs-bridge',
                            bridge: {
                                port: [
                                    { name: 'ovs-br1' },
                                    { name: 'bond1', 'link-aggregation': { mode: 'balance-slb', port: [{ name: 'ens161' }, { name: 'ens256' }] } }
                                ]
                            }
                        } as { name: string; type: string }]
                    }
                }
            };

            const findings = bondDegraded.evaluate(physicalContext({ nns, enactments: [enactment] }));

            expect(findings.map((f) => f.summary)).toEqual([
                'OVS bond bond1 in bridge br-vmdata on worker-1 has 1 of 2 members down.'
            ]);
            expect(findings[0].evidence.map((e) => e.fact)).toEqual([
                'Bridge br-vmdata reports OVS bond bond1 with members ens161.',
                'Enactment worker-1.br-vmdata declares ens256 a member of OVS bond bond1 in br-vmdata, '
                    + 'but bridge br-vmdata does not report it.',
                'Member ens256 is not reported by the node.'
            ]);
            expect(findings[0].evidence[1].path).toBe(
                'status.desiredState.interfaces[name=br-vmdata].bridge.port[name=bond1].link-aggregation.port');
            expect(findings[0].remedy).toEqual(expect.objectContaining({
                text: expect.stringContaining('NodeNetworkConfigurationPolicy br-vmdata configures OVS bond bond1 in br-vmdata.'),
                target: expect.objectContaining({ kind: 'NodeNetworkConfigurationPolicy', name: 'br-vmdata' })
            }));
        });

        it('still reports a kernel bond on the same node as before', () => {
            const nns = withInterfaces(ovsBonded, (interfaces) => interfaces.forEach((iface) => {
                if (iface.name === 'ens224') iface.state = 'down';
            }));
            const findings = bondDegraded.evaluate(physicalContext({ nns }));
            expect(findings.map((f) => [f.subject, f.summary])).toEqual([[
                { kind: 'graph-node', node: 'worker-1', graphNodeId: 'iface:bond0' },
                'Bond bond0 on worker-1 has 1 of 2 members down.'
            ]]);
        });

        it('puts two degraded OVS bonds on one bridge on two nodes, with two keys (ovn-recon-1tw.2)', () => {
            const nns = withInterfaces(ovsBonded, (interfaces) => {
                const bridge = interfaces.find((iface) => iface.name === 'br-vmdata' && iface.type === 'ovs-bridge')!;
                (bridge.bridge!.port as unknown[]).push({
                    name: 'bond2', 'link-aggregation': { mode: 'active-backup', port: [{ name: 'ens300' }] }
                });
                interfaces.forEach((iface) => { if (iface.name === 'ens256') iface.state = 'down'; });
            });

            const findings = bondDegraded.evaluate(physicalContext({ nns }));

            expect(findings.map((f) => f.subject)).toEqual([
                { kind: 'graph-node', node: 'worker-1', graphNodeId: 'ovs-bond:br-vmdata/bond1' },
                { kind: 'graph-node', node: 'worker-1', graphNodeId: 'ovs-bond:br-vmdata/bond2' }
            ]);
            expect(new Set(findings.map((f) => f.key)).size).toBe(2);
        });

        it('is quiet when every member of the OVS bond is up', () => {
            expect(bondDegraded.evaluate(physicalContext({ nns: ovsBonded }))).toEqual([]);
        });
    });
});
