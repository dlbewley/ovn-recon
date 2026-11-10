import * as React from 'react';
import { createRoot, Root } from 'react-dom/client';
import { act } from 'react';

import {
    CopyValue,
    DrawerIdentity,
    FactRow,
    FactRows,
    IdentifiersSection,
    InfoPopover,
    isCopyableAddress,
    ValueList,
    WideFactRow,
} from './drawerKit';
import { openInfoPopover } from './drawerKitTestUtils';

jest.mock('react-router', () => ({
    Link: ({ to, children, className }: { to: string; children: React.ReactNode; className?: string }) => (
        <a href={String(to)} className={className}>{children}</a>
    ),
}));

describe('drawer layout kit (ovn-recon-dp7.1)', () => {
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

    const render = (element: React.ReactElement) => act(() => root.render(element));

    describe('ValueList', () => {
        it('renders one item as a plain value, not a bullet', () => {
            render(<ValueList items={['only']} />);
            expect(container.querySelector('ul')).toBeNull();
            expect(container.querySelector('li')).toBeNull();
            expect(container.textContent).toBe('only');
        });

        it('renders several items one per line without bullets', () => {
            render(<ValueList items={['a', 'b']} />);
            const list = container.querySelector('ul');
            expect(list).not.toBeNull();
            expect(list!.style.listStyle).toBe('none');
            expect([...container.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a', 'b']);
        });
    });

    describe('FactRows', () => {
        it('is a horizontal, compact description list with a fixed term width', () => {
            render(
                <FactRows>
                    <FactRow term="Role">Gateway router</FactRow>
                </FactRows>,
            );
            const list = container.querySelector('dl')!;
            expect(list.classList.contains('pf-m-horizontal')).toBe(true);
            expect(list.classList.contains('pf-m-compact')).toBe(true);
            expect(list.getAttribute('style')).toContain('--pf-v6-c-description-list--m-horizontal__term--width: 9rem');
            // The value column may shrink, so one long token cannot widen the drawer.
            expect(list.getAttribute('style')).toContain('minmax(0, 1fr)');
        });

        it('stacks a table-valued row across the full width', () => {
            render(
                <FactRows>
                    <WideFactRow term="Routes"><table /></WideFactRow>
                </FactRows>,
            );
            const group = container.querySelector('[data-wide="true"]') as HTMLElement;
            expect(group.getAttribute('style')).toContain('--pf-v6-c-description-list__group--GridTemplateColumns: minmax(0, 1fr)');
        });

        it('puts the hint behind an info button, never in a title attribute', async () => {
            render(
                <FactRows>
                    <FactRow term="Patch Ports" hint="Read out of the patch port names." inferred>x</FactRow>
                </FactRows>,
            );
            expect(container.querySelector('[title]')).toBeNull();
            const button = container.querySelector<HTMLButtonElement>('button[aria-label="More about Patch Ports"]');
            expect(button).not.toBeNull();
            expect(container.querySelector('[data-testid="inferred-label"]')?.textContent).toBe('inferred');
            expect(await openInfoPopover(button!)).toContain('Read out of the patch port names.');
        });
    });

    describe('InfoPopover', () => {
        it('is a focusable button that opens the text as given', async () => {
            render(<InfoPopover subject="ECMP" hint="2 next hops at one metric" />);
            const button = container.querySelector<HTMLButtonElement>('button')!;
            expect(button.tagName).toBe('BUTTON');
            expect(button.getAttribute('aria-label')).toBe('More about ECMP');
            expect(await openInfoPopover(button)).toBe('2 next hops at one metric');
        });
    });

    describe('CopyValue and IdentifiersSection', () => {
        it('gives a single value a copy button', () => {
            render(<CopyValue value="10.131.0.0/23" />);
            expect(container.textContent).toContain('10.131.0.0/23');
            expect(container.querySelector('button[aria-label="Copy 10.131.0.0/23"]')).not.toBeNull();
        });

        it('recognises the addresses that earn a copy button', () => {
            ['10.131.0.0/23', '192.0.2.1', '0a:58:0a:83:00:01', 'fd02::/112', 'fe80::1'].forEach((value) =>
                expect(isCopyableAddress(value)).toBe(true));
            ['br-ex', 'up', '1400', 'ovs-bridge', 'Table 254 (main)', ''].forEach((value) =>
                expect(isCopyableAddress(value)).toBe(false));
        });

        it('collapses the identifiers by default, each with a copy button', () => {
            render(
                <IdentifiersSection
                    identifiers={[
                        { label: 'OVN name', value: 'cluster_udn_example.p.cudn_transit_router' },
                        { label: 'UUID', value: 'c5baca13-a4d4-4eab-b0d2-2931d70628f6' },
                    ]}
                />,
            );
            const toggle = container.querySelector<HTMLButtonElement>('[data-testid="identifiers"] button')!;
            expect(toggle.textContent).toContain('Identifiers');
            expect(toggle.getAttribute('aria-expanded')).toBe('false');
            act(() => toggle.click());
            expect(toggle.getAttribute('aria-expanded')).toBe('true');
            expect(container.querySelector('button[aria-label="Copy UUID"]')).not.toBeNull();
            expect(container.querySelector('button[aria-label="Copy OVN name"]')).not.toBeNull();
        });

        it('renders nothing without identifiers', () => {
            render(<IdentifiersSection identifiers={[]} />);
            expect(container.innerHTML).toBe('');
        });
    });

    describe('DrawerIdentity', () => {
        it('shows the name, kind, a status label and linked context chips', () => {
            render(
                <DrawerIdentity
                    name="GR_cnv-1"
                    kind="Gateway router"
                    state={{ text: 'Enabled', status: 'success' }}
                    chips={[
                        { kind: 'Node', value: 'cnv-1', to: '/ovn-recon/ovn/cnv-1' },
                        { kind: 'Network', value: 'Default cluster network' },
                    ]}
                />,
            );
            expect(container.querySelector('h2')?.textContent).toBe('GR_cnv-1');
            expect(container.querySelector('[data-testid="drawer-identity-kind"]')?.textContent).toBe('Gateway router');
            const state = container.querySelector('[data-testid="drawer-identity-state"]')!;
            expect(state.textContent).toContain('Enabled');
            expect(state.classList.contains('pf-m-success')).toBe(true);
            const link = container.querySelector('a[href="/ovn-recon/ovn/cnv-1"]');
            expect(link?.textContent).toBe('Node cnv-1');
            expect(container.textContent).toContain('Network Default cluster network');
        });
    });
});
