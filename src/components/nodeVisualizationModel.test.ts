import fs from 'fs';
import path from 'path';

import { NodeNetworkState, OvnBridgeMapping } from '../types';
import { buildTopologyEdges } from './nodeVisualizationModel';

const loadFixture = (name: string): NodeNetworkState => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`);
    return JSON.parse(fs.readFileSync(fixturePath, 'utf-8')) as NodeNetworkState;
};

describe('nodeVisualizationModel fixture coverage', () => {
    it('builds deduped topology edges from interface masters/controllers and bridge mappings', () => {
        const nns = loadFixture('basic-host');
        const interfaces = nns.status?.currentState?.interfaces || [];
        const bridgeMappings = (nns.status?.currentState?.ovn?.['bridge-mappings'] || []) as OvnBridgeMapping[];

        const edges = buildTopologyEdges({
            interfaces,
            vrfInterfaces: [],
            bridgeMappings,
            cudns: [],
            udns: [],
            attachmentNodes: [],
            nads: [],
            routeAdvertisements: [],
            showNads: false,
            resolveNodeId: (item) => item.name,
            getAttachmentNodeId: (attachment) => `attachment-${attachment.name}`,
            getUdnNodeId: (udn) => `udn-${udn.metadata?.namespace}-${udn.metadata?.name}`,
            getNadNodeId: (nad) => `nad-${nad.metadata?.namespace}-${nad.metadata?.name}`
        });

        expect(edges.map((edge) => `${edge.source}->${edge.target}`).sort()).toEqual([
            'br-ex->ovn-physnet',
            'eno1->br-ex',
            'ovn-k8s-mp0->br-int'
        ]);
    });
});
