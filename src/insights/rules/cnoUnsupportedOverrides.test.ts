import { cnoWith, networkConfigOf } from '../cnoTesting';
import { clusterContext } from '../testing';
import { cnoUnsupportedOverrides } from './cnoUnsupportedOverrides';

describe('cno-unsupported-overrides', () => {
    it('reports unsupportedConfigOverrides as info', () => {
        const data = cnoWith((d) => { d.operatorNetwork.spec!.unsupportedConfigOverrides = { foo: 'bar' }; });
        const findings = cnoUnsupportedOverrides.evaluate(clusterContext({ networkConfig: networkConfigOf(data) }));
        expect(findings).toHaveLength(1);
        expect(findings[0].severity).toBe('info');
        expect(findings[0].remedy.path).toBe('spec.unsupportedConfigOverrides');
    });

    it('reports the hidden overrides ConfigMap', () => {
        const findings = cnoUnsupportedOverrides.evaluate(clusterContext({
            networkConfig: networkConfigOf(undefined, {
                configMaps: {
                    appliedCluster: { status: 'absent' }, mtu: { status: 'absent' }, gatewayMode: { status: 'absent' },
                    overrides: { status: 'ok', data: { metadata: { name: 'ovn-kubernetes-config-overrides' }, data: { 'ovnkube.conf': '' } } }
                }
            })
        }));
        expect(findings).toHaveLength(1);
        expect(findings[0].evidence[0].fact).toContain('with keys ovnkube.conf');
        expect(findings[0].remedy.target).toEqual(expect.objectContaining({
            kind: 'ConfigMap', namespace: 'openshift-network-operator', name: 'ovn-kubernetes-config-overrides'
        }));
    });

    it('is quiet when nothing is overridden (an empty object included)', () => {
        expect(cnoUnsupportedOverrides.evaluate(clusterContext({ networkConfig: networkConfigOf() }))).toEqual([]);
        const empty = cnoWith((d) => { d.operatorNetwork.spec!.unsupportedConfigOverrides = {}; });
        expect(cnoUnsupportedOverrides.evaluate(clusterContext({ networkConfig: networkConfigOf(empty) }))).toEqual([]);
    });
});
