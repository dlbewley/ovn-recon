import * as React from 'react';
import { act } from 'react';
import { createRoot, Root } from 'react-dom/client';

import { ACLRow, LogicalDatabase, LogicalTopologySnapshot, SnapshotSection } from '../types';

const fetchCollectorSnapshot = jest.fn();

jest.mock('./collectorApi', () => ({
    ...jest.requireActual('./collectorApi'),
    fetchCollectorSnapshot: (...args: unknown[]) => fetchCollectorSnapshot(...args),
}));

import { OptionalSectionsState, useOptionalSections } from './useOptionalSections';

const database = (extra: Partial<LogicalDatabase> = {}): LogicalDatabase => ({
    logicalRouters: [],
    logicalRouterPorts: [],
    logicalSwitches: [],
    logicalSwitchPorts: [],
    nats: [],
    staticRoutes: [],
    ...extra,
});

const acl = (uuid: string): ACLRow => ({
    uuid,
    priority: 1001,
    direction: 'to-lport',
    action: 'allow-related',
    match: 'ip4',
    tier: 2,
});

const snapshotWith = (db: LogicalDatabase): LogicalTopologySnapshot => ({
    metadata: { schemaVersion: '2', generatedAt: '2026-11-08T12:00:00Z', sourceHealth: 'healthy', nodeName: 'cnv-1' },
    database: db,
    nodes: [],
    edges: [],
    groups: [],
    warnings: [],
});

interface ProbeProps {
    nodeName?: string;
    sections: SnapshotSection[];
    refreshKey?: string;
}

let latest: OptionalSectionsState;
let root: Root;
let container: HTMLDivElement;

const Probe: React.FC<ProbeProps> = ({ nodeName, sections, refreshKey }) => {
    latest = useOptionalSections(nodeName, sections, refreshKey);
    return null;
};

const render = async (props: ProbeProps) => {
    await act(async () => {
        root.render(<Probe {...props} />);
    });
};

beforeEach(() => {
    fetchCollectorSnapshot.mockReset();
    container = document.createElement('div');
    root = createRoot(container);
});

afterEach(() => {
    act(() => root.unmount());
    container.remove();
});

describe('useOptionalSections', () => {
    it('fetches nothing until a node and at least one section are given', async () => {
        await render({ nodeName: 'cnv-1', sections: [] });
        expect(latest).toEqual({ loading: false });
        await render({ nodeName: undefined, sections: ['policy'] });
        expect(latest).toEqual({ loading: false });
        expect(fetchCollectorSnapshot).not.toHaveBeenCalled();
    });

    it('requests the sections sorted and returns the database that carries them', async () => {
        const withPolicy = database({ acls: [acl('acl-1')], portGroups: [], addressSets: [] });
        fetchCollectorSnapshot.mockResolvedValue(snapshotWith(withPolicy));

        await render({ nodeName: 'cnv-1', sections: ['services', 'policy'] });

        expect(fetchCollectorSnapshot).toHaveBeenCalledTimes(1);
        expect(fetchCollectorSnapshot).toHaveBeenCalledWith('cnv-1', { include: ['policy', 'services'] });
        expect(latest.loading).toBe(false);
        expect(latest.error).toBeUndefined();
        expect(latest.database).toBe(withPolicy);
        // A section the collector did not deliver stays undefined.
        expect(latest.database?.loadBalancers).toBeUndefined();
    });

    it('does not refetch when the caller passes an equal section list again', async () => {
        fetchCollectorSnapshot.mockResolvedValue(snapshotWith(database()));
        await render({ nodeName: 'cnv-1', sections: ['policy'] });
        await render({ nodeName: 'cnv-1', sections: ['policy'] });
        expect(fetchCollectorSnapshot).toHaveBeenCalledTimes(1);
    });

    it('reports loading while the request is in flight', async () => {
        let resolve: (value: LogicalTopologySnapshot) => void = () => undefined;
        fetchCollectorSnapshot.mockReturnValue(new Promise<LogicalTopologySnapshot>((r) => { resolve = r; }));

        await render({ nodeName: 'cnv-1', sections: ['services'] });
        expect(latest).toEqual({ database: undefined, loading: true, error: undefined });

        await act(async () => resolve(snapshotWith(database({ loadBalancers: [] }))));
        expect(latest.loading).toBe(false);
        expect(latest.database?.loadBalancers).toEqual([]);
    });

    it('surfaces a failure and keeps the last good database on a refresh', async () => {
        const good = database({ acls: [] });
        fetchCollectorSnapshot.mockResolvedValueOnce(snapshotWith(good));
        await render({ nodeName: 'cnv-1', sections: ['policy'], refreshKey: 't1' });
        expect(latest.database).toBe(good);

        fetchCollectorSnapshot.mockRejectedValueOnce(new Error('collector unreachable'));
        await render({ nodeName: 'cnv-1', sections: ['policy'], refreshKey: 't2' });

        expect(fetchCollectorSnapshot).toHaveBeenCalledTimes(2);
        expect(latest.error).toBe('collector unreachable');
        expect(latest.loading).toBe(false);
        expect(latest.database).toBe(good);
    });

    it('drops the previous node\'s rows when the node changes', async () => {
        const first = database({ acls: [acl('from-cnv-1')] });
        fetchCollectorSnapshot.mockResolvedValueOnce(snapshotWith(first));
        await render({ nodeName: 'cnv-1', sections: ['policy'] });
        expect(latest.database).toBe(first);

        let resolve: (value: LogicalTopologySnapshot) => void = () => undefined;
        fetchCollectorSnapshot.mockReturnValueOnce(new Promise<LogicalTopologySnapshot>((r) => { resolve = r; }));
        await render({ nodeName: 'cnv-2', sections: ['policy'] });
        expect(latest.database).toBeUndefined();
        expect(latest.loading).toBe(true);

        const second = database({ acls: [acl('from-cnv-2')] });
        await act(async () => resolve(snapshotWith(second)));
        expect(latest.database).toBe(second);
    });
});
