import fs from 'fs';
import path from 'path';

import { buildGraphContext } from './context';
import { descriptorFor } from './descriptors';
import { physicalIdentifiers, physicalIdentity } from './drawerIdentity';
import { buildNodeViewModel } from './viewModel';
import { ClusterUserDefinedNetwork, NodeNetworkState } from '../types';
import { NodeViewModel } from './types';

const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const ctx = buildGraphContext({
    nns: fixture<NodeNetworkState>('nns', 'primary-cudn-vrf.json'),
    cudns: fixture<ClusterUserDefinedNetwork[]>('cudn', 'primary-cudn-vrf.json')
});

describe('physical identity header (ovn-recon-dp7.1)', () => {
    it('names an interface by its nmstate type, its oper state as a status, and the node', () => {
        const brEx = ctx.interfaces.find((i) => i.name === 'br-ex' && i.type === 'ovs-bridge')!;
        const node = buildNodeViewModel(brEx, descriptorFor('bridge' as never)!, ctx);
        expect(physicalIdentity(node, ctx)).toEqual({
            name: 'br-ex',
            kind: 'ovs-bridge',
            state: { text: 'up', status: 'success' },
            chips: [{ kind: 'Node', value: 'worker-1', href: '/k8s/cluster/core~v1~Node/worker-1' }]
        });
    });

    it('gives a VRF the network it serves, marked inferred when matched by name', () => {
        const vrf = ctx.interfaces.find((i) => i.type === 'vrf')!;
        const node = buildNodeViewModel(vrf, descriptorFor('vrf')!, ctx);
        const identity = physicalIdentity(node, ctx);
        expect(identity.kind).toBe('VRF');
        expect(identity.chips?.[1]).toEqual({
            kind: 'Network',
            value: 'example-p-cudn',
            href: '/k8s/cluster/k8s.ovn.org~v1~ClusterUserDefinedNetwork/example-p-cudn',
            inferred: true
        });
    });

    it('holds a resource\'s UID as its identifier, and nothing for an interface', () => {
        expect(physicalIdentifiers({ raw: { metadata: { uid: 'abc-123' } } } as NodeViewModel))
            .toEqual([{ label: 'UID', value: 'abc-123' }]);
        expect(physicalIdentifiers({ raw: { name: 'ens192' } } as NodeViewModel)).toEqual([]);
    });
});
