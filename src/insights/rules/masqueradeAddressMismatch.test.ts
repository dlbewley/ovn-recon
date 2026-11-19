import type { LogicalDatabase } from '../../types';
import { DEFAULT_ANNOTATION, masqueradeNode, nadFor, primaryCudn, primaryNad, SNAPSHOT_NODES } from '../masqueradeTesting';
import { clusterContext, loadSnapshot } from '../testing';
import type { ClusterNetworkInputs, ZoneDatabase } from '../types';
import { masqueradeAddressMismatch } from './masqueradeAddressMismatch';

const GR = 'GR_cluster_udn_example.p.cudn_cnv-1';
const zones = (): ZoneDatabase[] => SNAPSHOT_NODES.map((node) => ({ node, database: loadSnapshot(node).database! }));

/** The snapshot fixtures: example-p-cudn has network ID 3 and its gateway routers carry 169.254.0.15. */
const consistent = (): Partial<ClusterNetworkInputs> => ({
    nodes: SNAPSHOT_NODES.map((name) => masqueradeNode(name, DEFAULT_ANNOTATION)),
    cudns: [primaryCudn],
    nads: [primaryNad],
    zoneDatabases: zones()
});

const cnv1 = (cluster: Partial<ClusterNetworkInputs>): LogicalDatabase =>
    cluster.zoneDatabases!.find((zone) => zone.node === 'cnv-1')!.database;

describe('masquerade-address-mismatch', () => {
    it('is quiet when every gateway router carries the address its network ID gives', () => {
        expect(masqueradeAddressMismatch.evaluate(clusterContext(consistent()))).toEqual([]);
    });

    it('never fires without a zone database', () => {
        const cluster = { ...consistent(), nads: [nadFor('example-p-cudn', 'example-ns', 5, 'primary')] };
        expect(masqueradeAddressMismatch.evaluate(clusterContext({ ...cluster, zoneDatabases: undefined }))).toEqual([]);
        expect(masqueradeAddressMismatch.evaluate(clusterContext({ ...cluster, zoneDatabases: [] }))).toEqual([]);
    });

    it('fires as info on every zone when the network ID gives another address, naming the network', () => {
        const cluster = { ...consistent(), nads: [nadFor('example-p-cudn', 'example-ns', 5, 'primary')] };
        const findings = masqueradeAddressMismatch.evaluate(clusterContext(cluster));
        expect(findings).toHaveLength(SNAPSHOT_NODES.length);
        const finding = findings.find((entry) => entry.scope.node === 'cnv-1')!;
        expect(finding).toEqual(expect.objectContaining({
            severity: 'info',
            subject: { kind: 'construct', node: 'cnv-1', constructKind: 'router', name: GR },
            scope: { node: 'cnv-1', network: expect.objectContaining({ kind: 'ClusterUserDefinedNetwork', name: 'example-p-cudn' }) },
            summary: `Gateway router ${GR} on cnv-1 carries 169.254.0.15, which differs from the expected address 169.254.0.19.`
        }));
        expect(finding.evidence.map((evidence) => evidence.fact)).toEqual([
            `${GR} carries 169.254.0.15 on router port rtoe-${GR}.`,
            `${GR} carries 169.254.0.15 on external_ids:physical_ips.`,
            `${GR} carries 169.254.0.15 on a snat rule.`,
            'Network example-p-cudn has network ID 5, so its gateway routers are expected to use 169.254.0.19 from 169.254.0.0/17.'
        ]);
        expect(finding.evidence[3].inferred).toMatch(/upstream implementation detail/);
    });

    it('fires when one router SNATs to another network\'s address', () => {
        const cluster = consistent();
        const database = cnv1(cluster);
        const router = database.logicalRouters.find((row) => row.name === GR)!;
        database.nats.filter((nat) => router.nat?.includes(nat.uuid)).forEach((nat) => { nat.externalIp = '169.254.0.17'; });
        const findings = masqueradeAddressMismatch.evaluate(clusterContext(cluster));
        expect(findings.map((finding) => finding.summary)).toEqual([
            `Gateway router ${GR} on cnv-1 carries 169.254.0.17, which differs from the expected address 169.254.0.15.`
        ]);
    });

    it('fires when the router carries no masquerade address at all', () => {
        const cluster = consistent();
        const database = cnv1(cluster);
        const router = database.logicalRouters.find((row) => row.name === GR)!;
        router.externalIds = { ...router.externalIds, physical_ips: '192.168.4.72' };
        router.nat = [];
        database.logicalRouterPorts.forEach((port) => {
            port.networks = (port.networks ?? []).filter((network) => !network.startsWith('169.254.'));
        });
        const [finding] = masqueradeAddressMismatch.evaluate(clusterContext(cluster));
        expect(finding.summary).toBe(`Gateway router ${GR} on cnv-1 carries no masquerade address; the expected address is 169.254.0.15.`);
        expect(finding.evidence[0].fact).toBe(`${GR} carries no gateway router masquerade address in 169.254.0.0/17.`);
    });

    it('is quiet for a network that is not primary, or whose NAD carries no ID', () => {
        const secondary = { ...consistent(), nads: [nadFor('example-p-cudn', 'example-ns', 5, 'secondary')] };
        expect(masqueradeAddressMismatch.evaluate(clusterContext(secondary))).toEqual([]);
        const noId = nadFor('example-p-cudn', 'example-ns', 5, 'primary');
        delete noId.metadata!.annotations;
        expect(masqueradeAddressMismatch.evaluate(clusterContext({ ...consistent(), nads: [noId] }))).toEqual([]);
    });
});
