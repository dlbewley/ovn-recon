import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { NBGlobalRow } from '../types';
import SnapshotStatusLine, { ovnReleaseOf, summarizeOvnZones } from './SnapshotStatusLine';

const nbGlobal = (name: string, overrides: Partial<NBGlobalRow> = {}): NBGlobalRow => ({
    uuid: `nbg-${name}`,
    name,
    nbCfg: 10,
    sbCfg: 10,
    hvCfg: 10,
    options: { name, northd_internal_version: '26.03.4-57.el9fdp-21.8.0-82.14' },
    ...overrides,
});

describe('summarizeOvnZones', () => {
    it('returns nothing when no zone carries NB_Global (older collectors)', () => {
        expect(summarizeOvnZones([undefined, undefined])).toBeUndefined();
        expect(summarizeOvnZones([])).toBeUndefined();
    });

    it('names the zone and version for a single zone', () => {
        expect(summarizeOvnZones([nbGlobal('cnv-1')])).toEqual({
            versions: ['26.03.4-57.el9fdp-21.8.0-82.14'],
            zoneName: 'cnv-1',
            laggingZones: [],
        });
    });

    it('collapses identical versions across zones and drops the zone name', () => {
        const summary = summarizeOvnZones([nbGlobal('cnv-1'), nbGlobal('cnv-2'), undefined]);
        expect(summary?.versions).toHaveLength(1);
        expect(summary?.zoneName).toBeUndefined();
    });

    it('reports zones whose chassis lag the NB configuration', () => {
        const summary = summarizeOvnZones([nbGlobal('cnv-1'), nbGlobal('cnv-2', { hvCfg: 9 })]);
        expect(summary?.laggingZones).toEqual(['cnv-2']);
    });

    it('extracts the OVN release from northd_internal_version', () => {
        expect(ovnReleaseOf('26.03.4-57.el9fdp-21.8.0-82.14')).toBe('26.03.4');
        expect(ovnReleaseOf('24.09.2')).toBe('24.09.2');
    });
});

describe('SnapshotStatusLine', () => {
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

    it('labels the OVN release and zone, and flags lagging chassis', () => {
        act(() => {
            root.render(
                <SnapshotStatusLine
                    freshness="fresh"
                    ageMs={1000}
                    ovn={summarizeOvnZones([nbGlobal('cnv-1', { hvCfg: 9 })])}
                />,
            );
        });
        const text = container.textContent ?? '';
        expect(text).toContain('OVN 26.03.4 · zone cnv-1');
        expect(text).toContain('Chassis behind NB config');
        expect(text).not.toContain('Mixed OVN versions');
    });

    it('flags mixed versions across zones', () => {
        act(() => {
            root.render(
                <SnapshotStatusLine
                    freshness="fresh"
                    ageMs={1000}
                    zoneCount={2}
                    ovn={summarizeOvnZones([
                        nbGlobal('cnv-1'),
                        nbGlobal('cnv-2', { options: { northd_internal_version: '26.09.0-1' } }),
                    ])}
                />,
            );
        });
        const text = container.textContent ?? '';
        expect(text).toContain('OVN 26.03.4 / 26.09.0');
        expect(text).toContain('Mixed OVN versions');
    });

    it('renders no OVN label when the summary is absent', () => {
        act(() => {
            root.render(<SnapshotStatusLine freshness="fresh" ageMs={1000} />);
        });
        expect(container.textContent).not.toContain('OVN');
    });
});
