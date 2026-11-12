import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { DrawerBodyProps } from './ConstructDrawerBody';
import { policyIndexFor } from './policyIndex';
import { switchAclRows } from './policyRows';
import PolicyBody from './PolicyTables';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: () => [[], true, undefined],
}));

jest.mock('@patternfly/react-code-editor', () => ({
    CodeEditor: ({ code }: { code: string }) => <pre data-testid="code-editor">{code}</pre>,
}));

/**
 * The cases the captured snapshots do not hold: an ACL that reaches the switch
 * through several port groups, and ACLs of more than one network on one switch.
 */
describe('PolicyBody ACL table', () => {
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

    const captured = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
    const database = (): LogicalDatabase => JSON.parse(JSON.stringify(captured));
    const nodeSwitch = (db: LogicalDatabase) => db.logicalSwitches.find((row) => row.name === 'cnv-1')!;

    const render = async (db: LogicalDatabase) => {
        const props = {
            construct: { ports: [] },
            policy: { status: 'ready', index: policyIndexFor(db), database: db, switchUuid: nodeSwitch(db).uuid },
            databaseNode: 'cnv-1',
        } as unknown as DrawerBodyProps;
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon/ovn/cnv-1/switch/cnv-1?tab=policy">
                    <PolicyBody {...props} />
                </TestRouter>,
            );
        });
    };

    const headers = () =>
        [...container.querySelectorAll('table[aria-label="ACLs"] thead th')].map((th) => th.textContent);
    const row = (uuid: string) => container.querySelector(`tr[data-testid="rule-row-${uuid}"]`)!;

    it('shows the first port group and a count, and names them all in the expanded row', async () => {
        // Rows are picked from the capture as it is: the index is cached per database
        // object, so the copy that gets the second group must not be indexed first.
        const target = switchAclRows(policyIndexFor(captured), captured, nodeSwitch(captured).uuid)
            .find((candidate) => candidate.via.length === 1)!;
        const db = database();
        const first = db.portGroups!.find((group) => group.uuid === target.via[0].uuid)!;
        db.portGroups!.push({ ...first, uuid: 'second-group-uuid', name: 'a_second_group', externalIds: {} });
        await render(db);

        const cell = row(target.acl.uuid).querySelector('[data-testid="acl-via"]')!;
        expect(cell.querySelector('[data-testid="acl-via-ports"]')?.textContent).toMatch(/^\+1 more · \d+ ports? here$/);
        expect(cell.getAttribute('title')).toContain('a_second_group');

        await act(async () => {
            row(target.acl.uuid).querySelector('button')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const detail = container.querySelector(`[data-testid="acl-detail-${target.acl.uuid}"] [data-testid="acl-detail-via"]`)!;
        expect(detail.textContent).toContain(`@${first.name}`);
        expect(detail.textContent).toContain('@a_second_group');
    });

    it('says the network once, without a column, when every ACL shares it', async () => {
        await render(database());
        expect(headers()).not.toContain('Network');
        expect(container.querySelector('[data-testid="acl-one-network"]')?.textContent).toBe(' · all on Default cluster network');
    });

    it('keeps the Network column when the ACLs belong to more than one network', async () => {
        const target = switchAclRows(policyIndexFor(captured), captured, nodeSwitch(captured).uuid)[0];
        const db = database();
        const acl = db.acls!.find((candidate) => candidate.uuid === target.acl.uuid)!;
        acl.externalIds = { ...acl.externalIds, 'k8s.ovn.org/owner-controller': 'cluster_udn_tenant-network-controller' };
        await render(db);
        expect(headers()).toEqual(['Row expansion', 'Priority', 'Action', 'Owner', 'Network', 'Applied via', 'Match']);
        expect(container.querySelector('[data-testid="acl-one-network"]')).toBeNull();
    });
});
