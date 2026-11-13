import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { LogicalDatabase, LogicalTopologySnapshot, Pod } from '../types';
import ConstructDrawerBody from './ConstructDrawerBody';
import { buildLadderModel } from './logicalLadderModel';
import { NodeLogicalTopologyBody } from './NodeLogicalTopologyDetails';
import { TestRouter } from './testRouter';

import cnv1 from '../../collector/fixtures/snapshots/cnv-1.json';

/*
 * The logical findings reach their surfaces (ovn-recon-7i6.3): a badge on the
 * construct's ladder card, the Findings section at the top of the drawer, and the
 * zone findings above the ladder.
 */

const POD_PORT = 'openshift-mtv_forklift-volume-populator-controller-6d5f776884-cllnz';

// jest.mock factories may only close over identifiers prefixed `mock`.
const mockPods: Pod[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    DocumentTitle: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    useK8sWatchResource: (resource: { groupVersionKind?: { kind?: string } } | null) =>
        (resource?.groupVersionKind?.kind === 'Pod' ? [mockPods, true, undefined] : [[], true, undefined]),
}));

jest.mock('./useOvnCollectorFeatureGate', () => ({
    useOvnCollectorFeatureGate: () => ({ enabled: true, loaded: true, loadError: undefined }),
}));

jest.mock('react-router', () => ({
    ...jest.requireActual('react-router'),
    Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={String(to)}>{children}</a>,
}));

const snapshotWith = (vary: (snapshot: LogicalTopologySnapshot) => void): LogicalTopologySnapshot => {
    const snapshot = JSON.parse(JSON.stringify(cnv1)) as LogicalTopologySnapshot;
    vary(snapshot);
    return snapshot;
};

const portDown = (snapshot: LogicalTopologySnapshot) => {
    snapshot.database!.logicalSwitchPorts.find((port) => port.name === POD_PORT)!.up = false;
};

const runningPod: Pod = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { namespace: 'openshift-mtv', name: 'forklift-volume-populator-controller-6d5f776884-cllnz' },
    spec: { nodeName: 'cnv-1' },
    status: { phase: 'Running', startTime: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
};

describe('logical findings on their surfaces', () => {
    let container: HTMLDivElement;
    let root: Root;

    const serve = (snapshot: LogicalTopologySnapshot) => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => snapshot }) as unknown as typeof fetch;
    };

    const renderPage = async () => {
        await act(async () => {
            root.render(
                <TestRouter initialEntry="/ovn-recon/ovn/cnv-1">
                    <NodeLogicalTopologyBody name="cnv-1" />
                </TestRouter>,
            );
        });
        await act(async () => {
            await Promise.resolve();
        });
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        mockPods.splice(0, mockPods.length);
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
        jest.restoreAllMocks();
    });

    it('badges the switch of a running pod whose port is down, and opens the finding in its drawer', async () => {
        mockPods.push(runningPod);
        serve(snapshotWith(portDown));
        await renderPage();

        const card = container.querySelector('[data-testid="construct-cnv-1"]')!;
        const badge = card.querySelector('[data-testid="findings-badge"]');
        expect(badge?.getAttribute('aria-label')).toBe('1 warning');
        expect(container.querySelectorAll('[data-testid="findings-badge"]')).toHaveLength(1);

        await act(async () => {
            card.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });
        const section = container.querySelector('[data-testid="drawer-findings"]')!;
        expect(section).not.toBeNull();
        const entries = [...section.querySelectorAll('[data-testid="finding"]')];
        expect(entries.map((entry) => entry.getAttribute('data-rule'))).toEqual(['lsp-down']);
        expect(section.textContent).toContain(`but its port ${POD_PORT} is down`);
        expect(section.textContent).toContain('From the northbound database of node cnv-1');
        expect(section.textContent).toContain('View Pod openshift-mtv/forklift-volume-populator-controller-6d5f776884-cllnz');
    });

    it('draws no badge and no section for the capture as taken', async () => {
        mockPods.push(runningPod);
        serve(snapshotWith(() => undefined));
        await renderPage();

        expect(container.querySelector('[data-testid="construct-cnv-1"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="findings-badge"]')).toBeNull();
        expect(container.querySelector('[data-testid="zone-findings"]')).toBeNull();
    });

    it('lists a degraded collection above the ladder, not on a card', async () => {
        serve(snapshotWith((snapshot) => {
            snapshot.warnings = [{ code: 'LIVE_PROBE_FAILED', message: 'Live probe collection failed for node cnv-1: timeout' }];
        }));
        await renderPage();

        const zone = container.querySelector('[data-testid="zone-findings"]')!;
        expect(zone.querySelector('[data-rule="collector-degraded"]')).not.toBeNull();
        expect(container.querySelector('[data-testid="findings-badge"]')).toBeNull();
    });

    it('adds the policy-section finding once the drawer holds that section', async () => {
        const snapshot = snapshotWith((varied) => {
            const database = varied.database!;
            const group = database.portGroups!.find((pg) => pg.ports.length > 0 && pg.acls.length > 0)!;
            database.acls!.find((acl) => acl.uuid === group.acls[0])!.match = 'outport == @pg_gone';
        });
        const database = snapshot.database as LogicalDatabase;
        const model = buildLadderModel(database);
        const group = database.portGroups!.find((pg) => pg.ports.length > 0 && pg.acls.length > 0)!;
        const switchRow = database.logicalSwitches.find((ls) => ls.ports.includes(group.ports[0]))!;
        const construct = model.constructs.find((candidate) => candidate.kind === 'switch' && candidate.name === switchRow.name)!;

        await act(async () => {
            root.render(
                <ConstructDrawerBody
                    construct={construct}
                    model={model}
                    database={database}
                    databaseNode="cnv-1"
                    findings={[]}
                />,
            );
        });

        const section = container.querySelector('[data-testid="drawer-findings"]')!;
        expect([...section.querySelectorAll('[data-testid="finding"]')].map((entry) => entry.getAttribute('data-rule')))
            .toEqual(['match-ref-unresolved']);
    });

    it('shows no findings section in a drawer whose page passes no findings', async () => {
        const database = (cnv1 as unknown as LogicalTopologySnapshot).database as LogicalDatabase;
        const model = buildLadderModel(database);
        const construct = model.constructs.find((candidate) => candidate.name === 'cnv-1')!;
        await act(async () => {
            root.render(<ConstructDrawerBody construct={construct} model={model} database={database} />);
        });
        expect(container.querySelector('[data-testid="drawer-findings"]')).toBeNull();
    });
});
