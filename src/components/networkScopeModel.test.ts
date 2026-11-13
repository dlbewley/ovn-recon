import { loadItems } from '../insights/testing';
import type { ClusterUserDefinedNetwork, NetworkAttachmentDefinition, NodeNetworkState } from '../types';
import { findNetwork, NetworkInputs } from './networkPageModel';
import {
    networkDisplayName,
    networkHeaderFacts,
    networkNotCreated,
    networkNotFoundText,
    networkRowFor,
    networkScopeState,
} from './networkScopeModel';
import { overviewNetworkRows } from './overviewModel';

const inputs: NetworkInputs = {
    cudns: loadItems<ClusterUserDefinedNetwork>('cudn', 'cluster-localnet-coverage.json'),
    udns: [],
    nads: loadItems<NetworkAttachmentDefinition>('nad', 'cluster-localnet-coverage.json'),
    routeAdvertisements: [],
};
const nns = loadItems<NodeNetworkState>('nns', 'cluster-localnet-coverage.json');

describe('networkScopeModel (ovn-recon-gbr.6)', () => {
    describe('networkScopeState', () => {
        const vlan1924 = { kind: 'cudn' as const, name: 'vlan-1924' };

        it('finds a watched network whether or not every kind has settled', () => {
            for (const loaded of [false, true]) {
                const state = networkScopeState(vlan1924, inputs, loaded);
                expect(state.status).toBe('found');
                expect(state.status === 'found' && state.record.name).toBe('vlan-1924');
            }
        });

        it('is loading until every kind settles, then missing (never loading for good)', () => {
            const missing = { kind: 'udn' as const, namespace: 'team', name: 'blue' };
            expect(networkScopeState(missing, inputs, false)).toEqual({ status: 'loading' });
            expect(networkScopeState(missing, inputs, true)).toEqual({ status: 'missing' });
        });

        it('finds a generated NAD by its namespace', () => {
            const state = networkScopeState({ kind: 'nad', namespace: 'demo-mirror', name: 'vlan-1924' }, inputs, true);
            expect(state.status === 'found' && state.record.owner).toMatchObject({ kind: 'cudn', name: 'vlan-1924' });
            expect(networkScopeState({ kind: 'nad', namespace: 'other', name: 'vlan-1924' }, inputs, true).status)
                .toBe('missing');
        });
    });

    describe('the header', () => {
        const rows = overviewNetworkRows(inputs, nns, []);

        it('gives topology, role and the wired count', () => {
            const record = findNetwork({ kind: 'cudn', name: 'vlan-1924' }, inputs)!;
            const row = networkRowFor(rows, record);
            expect(row?.wired).toEqual({ wired: 4, total: 10 });
            const facts = networkHeaderFacts(record, row);
            expect(facts[0]).toBe('Localnet');
            expect(facts[facts.length - 1]).toBe('wired on 4 of 10 nodes');
        });

        it('leaves the count out for a network with no row (a generated NAD) or no node-local check', () => {
            const nad = findNetwork({ kind: 'nad', namespace: 'demo-mirror', name: 'vlan-1924' }, inputs)!;
            expect(networkRowFor(rows, nad)).toBeUndefined();
            expect(networkHeaderFacts(nad).join(' ')).not.toContain('wired');
            const layer2 = {
                ...findNetwork({ kind: 'cudn', name: 'vlan-1924' }, inputs)!,
                topology: 'Layer2',
                role: 'Secondary',
            };
            expect(networkHeaderFacts(layer2, { ...rows[0], wired: undefined })).toEqual(['Layer2', 'Secondary']);
        });

        it('matches a row by kind, namespace and name', () => {
            expect(networkRowFor(rows, { kind: 'cudn', name: 'vlan-333' })?.record.name).toBe('vlan-333');
            expect(networkRowFor(rows, { kind: 'nad', namespace: 'default', name: 'vlan-333' })).toBeUndefined();
            expect(networkRowFor(rows, { kind: 'udn', namespace: 'x', name: 'vlan-333' })).toBeUndefined();
        });

        it('says when OVN-Kubernetes did not create the network', () => {
            const record = findNetwork({ kind: 'cudn', name: 'vlan-1924' }, inputs)!;
            expect(networkNotCreated(record)).toBe(false);
            const refused = {
                ...record,
                resource: {
                    ...record.resource,
                    status: { conditions: [{ type: 'NetworkCreated', status: 'False', reason: 'SyncError' }] },
                } as ClusterUserDefinedNetwork,
            };
            expect(networkNotCreated(refused)).toBe(true);
        });
    });

    it('names networks as the tree does, and the kind in the not-found text', () => {
        expect(networkDisplayName({ name: 'vlan-1924' })).toBe('vlan-1924');
        expect(networkDisplayName({ namespace: 'team', name: 'blue' })).toBe('team/blue');
        expect(networkNotFoundText({ kind: 'nad', namespace: 'team', name: 'blue' }))
            .toBe('No NetworkAttachmentDefinition named team/blue is visible.');
    });
});
