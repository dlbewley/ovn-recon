import type { NodeNetworkState } from '../types';
import { evaluatePhysical } from './evaluate';
import { DEFAULT_ANNOTATION, masqueradeNode, primaryCudn, primaryNad, SNAPSHOT_NODES } from './masqueradeTesting';
import { loadFixture, loadSnapshot } from './testing';
import type { ClusterNetworkInputs } from './types';

/**
 * The four masquerade rules together (ovn-recon-2n6.5): a healthy cluster, with the
 * default /17 on every Node, a primary CUDN whose gateway routers carry its derived
 * address, br-ex's own masquerade address and the zones' join and transit ports,
 * raises none of them.
 */
describe('masquerade rules on a healthy cluster', () => {
    it('raise no finding', () => {
        const cluster: ClusterNetworkInputs = {
            cudns: [primaryCudn],
            udns: [],
            nads: [primaryNad],
            nodeNetworkStates: [loadFixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json')],
            nodes: SNAPSHOT_NODES.map((name) => masqueradeNode(name, DEFAULT_ANNOTATION)),
            zoneDatabases: SNAPSHOT_NODES.map((node) => ({ node, database: loadSnapshot(node).database! }))
        };
        const findings = evaluatePhysical.network(cluster).filter((finding) => finding.ruleId.startsWith('masquerade-'));
        expect(findings).toEqual([]);
    });
});
