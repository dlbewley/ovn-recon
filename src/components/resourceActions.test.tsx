import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import type { Action, K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';

import {
    OPEN_IN_OVN_RECON,
    useClusterUserDefinedNetworkActions,
    useNetworkAttachmentDefinitionActions,
    useNodeActions,
    useUserDefinedNetworkActions,
} from './resourceActions';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({}));

type Provider = (resource: K8sResourceCommon) => [Action[], boolean, unknown];

describe('Open in OVN Recon actions (ovn-recon-zdt.2)', () => {
    let container: HTMLDivElement;
    let root: Root;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const run = (provider: Provider, resource: K8sResourceCommon) => {
        let result: [Action[], boolean, unknown] = [[], false, undefined];
        const Probe = () => {
            result = provider(resource);
            return null;
        };
        act(() => root.render(<Probe />));
        return result;
    };

    it.each<[string, Provider, K8sResourceCommon, string]>([
        ['Node', useNodeActions, { kind: 'Node', metadata: { name: 'worker-1' } }, '/ovn-recon/node-network-state/worker-1'],
        ['CUDN', useClusterUserDefinedNetworkActions, { kind: 'ClusterUserDefinedNetwork', metadata: { name: 'vlan-1924' } }, '/ovn-recon/networks/cudn/vlan-1924'],
        ['UDN', useUserDefinedNetworkActions, { kind: 'UserDefinedNetwork', metadata: { name: 'blue', namespace: 'tenant' } }, '/ovn-recon/networks/udn/tenant/blue'],
        ['NAD', useNetworkAttachmentDefinitionActions, { kind: 'NetworkAttachmentDefinition', metadata: { name: 'vm-igb', namespace: 'default' } }, '/ovn-recon/networks/nad/default/vm-igb'],
    ])('%s opens its OVN Recon page', (_kind, provider, resource, href) => {
        const [actions, loaded, error] = run(provider, resource);
        expect(loaded).toBe(true);
        expect(error).toBeUndefined();
        expect(actions).toHaveLength(1);
        expect(actions[0].label).toBe(OPEN_IN_OVN_RECON);
        expect(actions[0].cta).toEqual({ href });
    });

    it('uses the model kind when the object carries none', () => {
        const [actions] = run(useNodeActions, { metadata: { name: 'worker-2' } });
        expect(actions[0].cta).toEqual({ href: '/ovn-recon/node-network-state/worker-2' });
    });

    it('offers nothing for an object without a name', () => {
        const [actions] = run(useNodeActions, { kind: 'Node', metadata: {} });
        expect(actions).toEqual([]);
    });
});
