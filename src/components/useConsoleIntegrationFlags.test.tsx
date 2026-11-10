import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import { OvnRecon } from '../types';
import { FLAG_RESOURCE_ACTIONS, FLAG_RESOURCE_TABS } from './consoleIntegration';
import { useConsoleIntegrationFlags } from './useConsoleIntegrationFlags';

// What the OvnRecon watch returns; jest.mock factories may only reach `mock` names.
let mockWatch: [OvnRecon[] | undefined, boolean, unknown] = [undefined, false, undefined];
const mockWatchCalls: unknown[] = [];

jest.mock('@openshift-console/dynamic-plugin-sdk', () => ({
    useK8sWatchResource: (resource: unknown) => {
        mockWatchCalls.push(resource);
        return mockWatch;
    },
}));

const recon = (
    name: string,
    creationTimestamp: string,
    status?: OvnRecon['status'],
): OvnRecon => ({ kind: 'OvnRecon', metadata: { name, creationTimestamp }, status });

const resolved = (resourceTabs: boolean, resourceActions: boolean): OvnRecon['status'] => ({
    effective: { consolePlugin: { integration: { resourceTabs, resourceActions } } },
});

describe('useConsoleIntegrationFlags (ovn-recon-zdt.7)', () => {
    let container: HTMLDivElement;
    let root: Root;
    let setFlag: jest.Mock;

    const Probe: React.FC<{ setter: (flag: string, enabled: boolean) => void }> = ({ setter }) => {
        useConsoleIntegrationFlags(setter);
        return null;
    };

    /** The last value set for each flag. */
    const flags = () => Object.fromEntries(setFlag.mock.calls.map(([flag, value]) => [flag, value]));

    const render = () => act(() => root.render(<Probe setter={setFlag} />));

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
        setFlag = jest.fn();
        mockWatchCalls.length = 0;
    });

    afterEach(() => {
        act(() => root.unmount());
        container.remove();
    });

    const OFF = { [FLAG_RESOURCE_TABS]: false, [FLAG_RESOURCE_ACTIONS]: false };

    it('watches the OvnRecon list at the served version', () => {
        mockWatch = [[], true, undefined];
        render();
        expect(mockWatchCalls[0]).toEqual({
            groupVersionKind: { group: 'recon.bewley.net', version: 'v1beta1', kind: 'OvnRecon' },
            isList: true,
        });
    });

    it('sets both flags off while the watch is loading', () => {
        mockWatch = [undefined, false, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('fails closed when there is no OvnRecon', () => {
        mockWatch = [[], true, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('fails closed on a load error, such as a user who may not list OvnRecon', () => {
        const forbidden = Object.assign(new Error('ovnrecons.recon.bewley.net is forbidden'), { code: 403 });
        mockWatch = [undefined, true, forbidden];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('fails closed on a load error even when stale data is present', () => {
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(true, true))], true, new Error('watch failed')];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('fails closed for an OvnRecon the operator has not resolved', () => {
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z')], true, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('fails closed for a status from an older operator, without the integration fields', () => {
        const older: OvnRecon['status'] = { effective: { consolePlugin: {} } };
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', older)], true, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('ignores the spec: only what the operator resolved counts', () => {
        const specOnly = recon('ovn-recon', '2026-01-01T00:00:00Z');
        specOnly.spec = { consolePlugin: { integration: { resourceTabs: true, resourceActions: true } } };
        mockWatch = [[specOnly], true, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('sets each flag from its own switch', () => {
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(true, false))], true, undefined];
        render();
        expect(flags()).toEqual({ [FLAG_RESOURCE_TABS]: true, [FLAG_RESOURCE_ACTIONS]: false });

        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(false, true))], true, undefined];
        render();
        expect(flags()).toEqual({ [FLAG_RESOURCE_TABS]: false, [FLAG_RESOURCE_ACTIONS]: true });
    });

    it('turns the flags off again when the switches go off', () => {
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(true, true))], true, undefined];
        render();
        expect(flags()).toEqual({ [FLAG_RESOURCE_TABS]: true, [FLAG_RESOURCE_ACTIONS]: true });

        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(false, false))], true, undefined];
        render();
        expect(flags()).toEqual(OFF);

        mockWatch = [[], true, undefined];
        render();
        expect(flags()).toEqual(OFF);
    });

    it('follows the primary OvnRecon when there are several', () => {
        mockWatch = [[
            recon('second', '2026-05-01T00:00:00Z', resolved(true, true)),
            recon('primary', '2026-01-01T00:00:00Z', resolved(false, true)),
        ], true, undefined];
        render();
        expect(flags()).toEqual({ [FLAG_RESOURCE_TABS]: false, [FLAG_RESOURCE_ACTIONS]: true });
    });

    it('does not set the flags again while nothing changes', () => {
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(true, false))], true, undefined];
        render();
        const calls = setFlag.mock.calls.length;
        mockWatch = [[recon('ovn-recon', '2026-01-01T00:00:00Z', resolved(true, false))], true, undefined];
        render();
        expect(setFlag.mock.calls.length).toBe(calls);
    });
});
