import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';

import { NodeNetworkState, OvnBridgeMapping } from '../types';
import { buildTopologyEdges } from './nodeVisualizationModel';
import { extractLldpNeighbors } from './nodeVisualizationSelectors';

const loadFixture = (name: string): NodeNetworkState => {
    const fixturePath = path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`);
    const fixtureContent = fs.readFileSync(fixturePath, 'utf-8');
    try {
        return JSON.parse(fixtureContent) as NodeNetworkState;
    } catch {
        return yaml.load(fixtureContent) as NodeNetworkState;
    }
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
            lldpNeighbors: [],
            cudns: [],
            udns: [],
            attachmentNodes: [],
            nads: [],
            routeAdvertisements: [],
            showNads: false,
            showLldpNeighbors: false,
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

    it('adds LLDP neighbor edges to local interfaces only when LLDP rendering is enabled', () => {
        const nns = loadFixture('host-lldp');
        const interfaces = nns.status?.currentState?.interfaces || [];
        const lldpNeighbors = extractLldpNeighbors(interfaces);

        const withoutLldpEdges = buildTopologyEdges({
            interfaces,
            vrfInterfaces: [],
            bridgeMappings: [],
            lldpNeighbors,
            cudns: [],
            udns: [],
            attachmentNodes: [],
            nads: [],
            routeAdvertisements: [],
            showNads: false,
            showLldpNeighbors: false,
            resolveNodeId: (item) => item.name,
            getAttachmentNodeId: (attachment) => `attachment-${attachment.name}`,
            getUdnNodeId: (udn) => `udn-${udn.metadata?.namespace}-${udn.metadata?.name}`,
            getNadNodeId: (nad) => `nad-${nad.metadata?.namespace}-${nad.metadata?.name}`
        });

        const withLldpEdges = buildTopologyEdges({
            interfaces,
            vrfInterfaces: [],
            bridgeMappings: [],
            lldpNeighbors,
            cudns: [],
            udns: [],
            attachmentNodes: [],
            nads: [],
            routeAdvertisements: [],
            showNads: false,
            showLldpNeighbors: true,
            resolveNodeId: (item) => item.name,
            getAttachmentNodeId: (attachment) => `attachment-${attachment.name}`,
            getUdnNodeId: (udn) => `udn-${udn.metadata?.namespace}-${udn.metadata?.name}`,
            getNadNodeId: (nad) => `nad-${nad.metadata?.namespace}-${nad.metadata?.name}`
        });

        expect(withoutLldpEdges.some((edge) => edge.source.startsWith('lldp-'))).toBe(false);
        expect(withLldpEdges.map((edge) => `${edge.source}->${edge.target}`)).toEqual(expect.arrayContaining([
            'lldp-enp44s0-0->enp44s0',
            'lldp-enp45s0-0->enp45s0'
        ]));
    });
});
