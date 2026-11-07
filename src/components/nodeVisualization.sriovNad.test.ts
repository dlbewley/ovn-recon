import fs from 'fs';
import path from 'path';

import { buildGraphContext } from '../topology/context';
import { descriptorFor } from '../topology/descriptors';
import { nodeKindRegistry } from '../topology/registry';
import { Fact, FactItem } from '../topology/types';
import { buildNodeViewModel } from '../topology/viewModel';
import { describeSriovNadSettings, parseSriovOwnerRef } from './nodeVisualizationSelectors';
import { NetworkAttachmentDefinition, NodeNetworkState } from '../types';

/**
 * An sriov NAD in the drawer (ovn-recon-s3t.64).
 *
 * The SR-IOV Network Operator generates the NAD from an SriovNetwork and annotates it
 * with the SriovNetwork it came from and the device resource pods request. The drawer
 * used to show only `CNI Type: sriov`; now it links to the SriovNetwork, names the
 * resource, and reads the VF settings out of the config.
 */
const fixture = <T,>(...segments: string[]): T =>
    JSON.parse(fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', ...segments), 'utf-8')) as T;

const nns = fixture<NodeNetworkState>('nns', 'sriov.json');
const nads = fixture<NetworkAttachmentDefinition[]>('nad', 'sriov.json');
const ctx = buildGraphContext({ nns, nads });

const factsFor = (nad: NetworkAttachmentDefinition): Fact[] =>
    nodeKindRegistry.nad.facts!(buildNodeViewModel(nad, descriptorFor('nad')!, ctx), ctx);
const find = (facts: Fact[], label: string): Fact | undefined => facts.find((f) => f.label === label);

const nad = nads[0];

describe('sriov NAD fixture: sanitisation', () => {
    it('carries no identifying values and no server-managed noise', () => {
        const raw = fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'nad', 'sriov.json'), 'utf-8');
        expect(raw).not.toMatch(/managedFields|resourceVersion|last-applied-configuration/);
    });

    it('is the NAD for the pool the sriov NNS fixture carves', () => {
        // vm_igb is fed by the igb PF enp65s0f1, which has seven VFs; this is the
        // relationship a later SriovNetworkNodeState read would make an edge.
        expect(nad.metadata?.annotations?.['k8s.v1.cni.cncf.io/resourceName']).toBe('openshift.io/vm_igb');
        expect(ctx.interfaces.find((i) => i.name === 'enp65s0f1')?.ethernet?.['sr-iov']?.['total-vfs']).toBe(7);
    });
});

describe('the sriov NAD drawer', () => {
    const facts = factsFor(nad);

    it('still reads the config', () => {
        expect(find(facts, 'CNI Type')?.value).toBe('sriov');
        expect(find(facts, 'Network Name')?.value).toBe('vm-igb');
    });

    it('links to the SriovNetwork it was generated from', () => {
        const fact = find(facts, 'SR-IOV Network')!;
        expect(fact.provenance).toBe('declared');
        expect(fact.value).toEqual([{
            text: 'openshift-sriov-network-operator/vm-igb',
            ref: {
                apiVersion: 'sriovnetwork.openshift.io/v1',
                kind: 'SriovNetwork',
                namespace: 'openshift-sriov-network-operator',
                name: 'vm-igb'
            }
        }]);
        expect(fact.hint).toContain('sriovnetwork.openshift.io/owner-ref');
    });

    it('names the device resource pods request', () => {
        const fact = find(facts, 'Device Resource')!;
        expect(fact.value).toBe('openshift.io/vm_igb');
        expect(fact.provenance).toBe('declared');
        expect(fact.hint).toContain('k8s.v1.cni.cncf.io/resourceName');
        // This context carries no SriovNetworkNodeState, and the hint says what that costs.
        expect(fact.hint).toContain('SriovNetworkNodeState, which was not read');
    });

    it('reads the VF settings in the same words the PF drawer uses', () => {
        const fact = find(facts, 'VF Settings')!;
        expect((fact.value as FactItem[]).map((v) => v.text)).toEqual(['trust on', 'spoof check off']);
        expect(fact.provenance).toBe('declared');
    });

    it('orders the SR-IOV rows after the network name', () => {
        const labels = facts.map((f) => f.label);
        expect(labels).toEqual(['Type', 'CNI Type', 'Network Name', 'SR-IOV Network', 'Device Resource', 'VF Settings']);
    });

    it('adds nothing to a NAD that is not sriov', () => {
        const evpn = fixture<NetworkAttachmentDefinition[]>('nad', 'evpn-vxlan.json')[0];
        const labels = factsFor(evpn).map((f) => f.label);
        ['SR-IOV Network', 'Device Resource', 'VF Settings'].forEach((label) => expect(labels).not.toContain(label));
    });

    it('shows what it has when a hand-made sriov NAD carries no annotations', () => {
        const bare: NetworkAttachmentDefinition = {
            apiVersion: 'k8s.cni.cncf.io/v1',
            kind: 'NetworkAttachmentDefinition',
            metadata: { name: 'by-hand', namespace: 'default' },
            spec: { config: JSON.stringify({ cniVersion: '1.0.0', name: 'by-hand', type: 'sriov', vlan: 100, vlanQoS: 2, spoofchk: 'on' }) }
        };
        const facts = factsFor(bare);
        expect(find(facts, 'SR-IOV Network')).toBeUndefined();
        expect(find(facts, 'Device Resource')).toBeUndefined();
        expect((find(facts, 'VF Settings')?.value as FactItem[]).map((v) => v.text)).toEqual(['spoof check on', 'VLAN 100 qos 2']);
    });
});

describe('parseSriovOwnerRef', () => {
    it('splits Kind.group/namespace/name and assumes v1', () => {
        expect(parseSriovOwnerRef('SriovNetwork.sriovnetwork.openshift.io/openshift-sriov-network-operator/vm-igb')).toEqual({
            apiVersion: 'sriovnetwork.openshift.io/v1',
            kind: 'SriovNetwork',
            namespace: 'openshift-sriov-network-operator',
            name: 'vm-igb'
        });
    });

    it('rejects anything else rather than guessing', () => {
        expect(parseSriovOwnerRef('vm-igb')).toBeUndefined();
        expect(parseSriovOwnerRef('SriovNetwork/vm-igb')).toBeUndefined();
        expect(parseSriovOwnerRef(undefined)).toBeUndefined();
        expect(parseSriovOwnerRef(42)).toBeUndefined();
    });
});

describe('describeSriovNadSettings', () => {
    it('tolerates booleans and string numbers, and omits unset values', () => {
        expect(describeSriovNadSettings({ trust: true, spoofchk: false, vlan: 0, vlanQoS: 0 })).toEqual(['trust on', 'spoof check off']);
        expect(describeSriovNadSettings({ vlan: '200', min_tx_rate: 10, max_tx_rate: '100' })).toEqual(['VLAN 200', 'tx rate min 10 max 100 Mb/s']);
        expect(describeSriovNadSettings({ type: 'sriov' })).toEqual([]);
        expect(describeSriovNadSettings(null)).toEqual([]);
    });
});
