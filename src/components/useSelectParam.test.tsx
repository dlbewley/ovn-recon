import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';
import { useNavigate } from 'react-router';

import { LocationRecord, TestRouter } from './testRouter';
import {
    constructSelectValue,
    encodeSelectValue,
    findConstructBySelectValue,
    parseConstructSelectValue,
    readSelectParam,
    useSelectionDeepLink,
    withSelectParam,
} from './useSelectParam';
import { LadderConstruct, LadderModel } from './logicalLadderModel';

describe('select parameter helpers', () => {
    it('reads the value, decoding either spelling of the separators', () => {
        expect(readSelectParam('?select=vrf:blue')).toBe('vrf:blue');
        expect(readSelectParam('?a=1&select=udn%3Ans1%2Fblue')).toBe('udn:ns1/blue');
        expect(readSelectParam('?a=1')).toBeNull();
        expect(readSelectParam('?select=')).toBeNull();
    });

    it('keeps : and / readable but encodes everything else', () => {
        expect(encodeSelectValue('udn:ns1/blue')).toBe('udn:ns1/blue');
        expect(encodeSelectValue('switch:a b&c=d')).toBe('switch:a%20b%26c%3Dd');
    });

    it('sets, replaces and removes select without touching other parameters', () => {
        expect(withSelectParam('', 'vrf:blue')).toBe('?select=vrf:blue');
        expect(withSelectParam('?q=a+b&z=%2F', 'vrf:blue')).toBe('?q=a+b&z=%2F&select=vrf:blue');
        expect(withSelectParam('?a=1&select=old&b=2', 'vrf:red')).toBe('?a=1&select=vrf:red&b=2');
        expect(withSelectParam('?a=1&select=old&b=2', null)).toBe('?a=1&b=2');
        expect(withSelectParam('?select=old', null)).toBe('');
    });

    it('parses KIND:NAME for the three ladder kinds only', () => {
        expect(parseConstructSelectValue('switch:join')).toEqual({ kind: 'switch', name: 'join' });
        expect(parseConstructSelectValue('router:GR_a:b')).toEqual({ kind: 'router', name: 'GR_a:b' });
        expect(parseConstructSelectValue('physnet:physnet')).toEqual({ kind: 'physnet', name: 'physnet' });
        expect(parseConstructSelectValue('vrf:blue')).toBeNull();
        expect(parseConstructSelectValue('switch:')).toBeNull();
        expect(parseConstructSelectValue('join')).toBeNull();
    });

    it('takes the first construct when two share a kind and name', () => {
        const first = { uuid: 'a', kind: 'physnet', name: 'physnet' } as LadderConstruct;
        const second = { uuid: 'b', kind: 'physnet', name: 'physnet' } as LadderConstruct;
        const model = { constructs: [first, second] } as unknown as LadderModel;
        expect(findConstructBySelectValue(model, constructSelectValue(second))).toBe(first);
        expect(findConstructBySelectValue(model, 'switch:physnet')).toBeNull();
    });
});

/**
 * A page in miniature: a selection, a model that may not have loaded yet, and
 * the same select/close handlers the real pages have.
 */
interface HarnessHandle {
    select: (id: string | null) => void;
    setModel: (ids: string[]) => void;
    navigate: ReturnType<typeof useNavigate>;
    selected: () => string | null;
    applied: string[];
}

const Harness: React.FC<{ initialModel: string[]; handle: HarnessHandle }> = ({ initialModel, handle }) => {
    const [model, setModel] = React.useState<string[]>(initialModel);
    const [selected, setSelected] = React.useState<string | null>(null);
    const navigate = useNavigate();
    handle.select = setSelected;
    handle.setModel = setModel;
    handle.navigate = navigate;
    handle.selected = () => selected;
    useSelectionDeepLink<string>({
        selected,
        encode: (id) => id,
        resolve: (value) => (model.includes(value) ? value : null),
        apply: (id) => {
            handle.applied.push(id);
            setSelected(id);
        },
    });
    return null;
};

describe('useSelectionDeepLink', () => {
    let container: HTMLDivElement;
    let root: Root;
    let locations: LocationRecord[];
    let handle: HarnessHandle;
    const current = () => locations[locations.length - 1];

    const mount = (initialEntry: string, initialModel: string[]) => {
        act(() => {
            root.render(
                <TestRouter initialEntry={initialEntry} onLocation={(record) => locations.push(record)}>
                    <Harness initialModel={initialModel} handle={handle} />
                </TestRouter>,
            );
        });
    };

    beforeEach(() => {
        container = document.createElement('div');
        root = createRoot(container);
        locations = [];
        handle = { applied: [] } as unknown as HarnessHandle;
    });

    afterEach(() => {
        act(() => root.unmount());
    });

    it('applies a value present on mount once the model contains it', () => {
        mount('/page?select=vrf:blue', []);
        expect(handle.selected()).toBeNull();
        // Not yet in the model: still pending, and the URL is left alone.
        expect(current().search).toBe('?select=vrf:blue');

        act(() => handle.setModel(['vrf:blue']));
        expect(handle.applied).toEqual(['vrf:blue']);
        expect(handle.selected()).toBe('vrf:blue');

        // Later model updates do not re-apply it.
        act(() => handle.setModel(['vrf:blue', 'iface:eth0']));
        expect(handle.applied).toEqual(['vrf:blue']);
    });

    it('writes each selection change with replace and removes it on close', () => {
        mount('/page', ['vrf:blue', 'iface:eth0']);
        act(() => handle.select('vrf:blue'));
        expect(current().search).toBe('?select=vrf:blue');
        expect(current().navigationType).toBe('REPLACE');

        act(() => handle.select('iface:eth0'));
        expect(current().search).toBe('?select=iface:eth0');
        expect(current().navigationType).toBe('REPLACE');

        act(() => handle.select(null));
        expect(current().search).toBe('');
        expect(current().pathname).toBe('/page');
        expect(locations.every((record) => record.navigationType !== 'PUSH')).toBe(true);
    });

    it('keeps other query parameters and the hash', () => {
        mount('/page?host=n1&net=blue#top', ['vrf:blue']);
        act(() => handle.select('vrf:blue'));
        expect(current().search).toBe('?host=n1&net=blue&select=vrf:blue');
        expect(current().hash).toBe('#top');
        act(() => handle.select(null));
        expect(current().search).toBe('?host=n1&net=blue');
        expect(current().hash).toBe('#top');
    });

    it('ignores an unknown id without erroring, until the user selects something', () => {
        mount('/page?a=1&select=vrf:gone', ['vrf:blue']);
        act(() => handle.setModel(['vrf:blue', 'iface:eth0']));
        expect(handle.applied).toEqual([]);
        expect(handle.selected()).toBeNull();
        expect(current().search).toBe('?a=1&select=vrf:gone');

        act(() => handle.select('iface:eth0'));
        expect(current().search).toBe('?a=1&select=iface:eth0');
        // The stale link no longer competes with the user's choice.
        act(() => handle.setModel(['vrf:blue', 'iface:eth0', 'vrf:gone']));
        expect(handle.applied).toEqual([]);
        expect(handle.selected()).toBe('iface:eth0');
    });

    it('follows a select that arrives from a navigation it did not make', () => {
        mount('/page', ['vrf:blue', 'iface:eth0']);
        act(() => handle.select('vrf:blue'));
        act(() => { handle.navigate('/page?select=iface:eth0'); });
        expect(handle.applied).toEqual(['iface:eth0']);
        expect(handle.selected()).toBe('iface:eth0');
    });

    it('does not write the previous page\'s selection onto the page it navigates to', () => {
        // The node ladder resets its selection when the route moves to another
        // node, in an effect a render after the new location arrives; the URL
        // must not pick up the old node's selection in between.
        mount('/page/one', ['vrf:blue']);
        act(() => handle.select('vrf:blue'));
        act(() => { handle.navigate('/page/two'); });
        expect(current().pathname).toBe('/page/two');
        expect(current().search).toBe('');
        act(() => handle.select(null));
        const onPageTwo = locations.filter((record) => record.pathname === '/page/two');
        expect(onPageTwo.length).toBeGreaterThan(0);
        expect(onPageTwo.every((record) => record.search === '')).toBe(true);
    });
});
