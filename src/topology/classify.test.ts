import fs from 'fs';
import path from 'path';

import { classify, interfacesWithRole, isDrawn, roleOf, InterfaceRole } from './classify';
import { buildGraphContext, GraphContext } from './context';
import { Interface, NodeNetworkState } from '../types';

const fixtureCtx = (name: string): GraphContext => buildGraphContext({
    nns: JSON.parse(fs.readFileSync(
        path.join(process.cwd(), 'test', 'fixtures', 'nns', `${name}.json`), 'utf-8')) as NodeNetworkState
});

const ctxOf = (interfaces: Partial<Interface>[]): GraphContext => buildGraphContext({
    nns: { status: { currentState: { interfaces: interfaces as Interface[] } } } as NodeNetworkState
});

const roleIn = (interfaces: Partial<Interface>[], name: string): InterfaceRole => {
    const ctx = ctxOf(interfaces);
    return roleOf(ctx.interfaces.find((i) => i.name === name)!, ctx);
};

describe('classify: the bridge-shadowing knot', () => {
    // The case the old isBridge()/logicalInterfaces pair contradicted each other over.
    const shadowed: Partial<Interface>[] = [
        { name: 'br-ex', type: 'ovs-bridge', state: 'up' },
        { name: 'br-ex', type: 'ovs-interface', state: 'up', controller: 'br-ex' },
        { name: 'ens192', type: 'ethernet', state: 'up', controller: 'br-ex' }
    ];

    it('calls the declared bridge a bridge', () => {
        const ctx = ctxOf(shadowed);
        const bridge = ctx.interfaces.find((i) => i.type === 'ovs-bridge')!;
        expect(roleOf(bridge, ctx)).toBe('bridge');
    });

    it('calls the port sharing its name a bridge port, not a bridge', () => {
        const ctx = ctxOf(shadowed);
        const port = ctx.interfaces.find((i) => i.type === 'ovs-interface')!;
        expect(classify(port, ctx)).toEqual({
            role: 'bridge-port',
            reason: 'an OVS internal port sharing its name with the bridge it belongs to'
        });
    });

    it('still lets an OVS interface act as a bridge when nothing shadows it', () => {
        // No declared bridge named ovs-br, but interfaces are enslaved to it.
        expect(roleIn([
            { name: 'ovs-br', type: 'ovs-interface', state: 'up' },
            { name: 'eth0', type: 'ethernet', state: 'up', controller: 'ovs-br' }
        ], 'ovs-br')).toBe('bridge');
    });

    it('does not promote an OVS interface that nothing is enslaved to', () => {
        expect(roleIn([{ name: 'ovs-vlan-1920', type: 'ovs-interface', state: 'up' }], 'ovs-vlan-1920'))
            .toBe('bridge-port');
    });
});

describe('classify: roles that are present but not drawn', () => {
    it('treats a patch port as a patch port, by property or by name', () => {
        expect(roleIn([{ name: 'patch-a-to-b', type: 'ovs-interface', state: 'ignore' }], 'patch-a-to-b'))
            .toBe('patch');
        expect(roleIn([{ name: 'somename', type: 'ovs-interface', state: 'up', patch: { peer: 'patch-peer-port' } }], 'somename'))
            .toBe('patch');
    });

    it('treats an ignored OVS interface as unmanaged', () => {
        expect(roleIn([{ name: 'br-int', type: 'ovs-interface', state: 'ignore', controller: 'br-int' }], 'br-int'))
            .toBe('unmanaged');
    });

    it('treats an ignored NIC as unmanaged', () => {
        expect(roleIn([{ name: 'genev_sys_6081', type: 'ethernet', state: 'ignore' }], 'genev_sys_6081'))
            .toBe('unmanaged');
    });

    it('names the two undrawn roles explicitly', () => {
        expect(isDrawn('unmanaged')).toBe(false);
        expect(isDrawn('patch')).toBe(false);
        (['physical', 'bond', 'vlan', 'bridge', 'bridge-port', 'vrf', 'host-local', 'unclassified'] as const)
            .forEach((role) => expect(isDrawn(role)).toBe(true));
    });
});

describe('classify: the ignore rule is deliberately not top-level', () => {
    it('keeps an ignored interface of an unrecognised type visible', () => {
        // The Geneve tunnel in primary-cudn-vrf.json is type 'unknown', state 'ignore',
        // and has always been drawn in the catch-all. Hoisting the ignore rule above
        // the type rules would silently remove it.
        expect(roleIn([{ name: 'genev_sys_6081', type: 'unknown', state: 'ignore' }], 'genev_sys_6081'))
            .toBe('unclassified');
    });
});

describe('classify is total', () => {
    it('gives an unrecognised type a role and says why', () => {
        const ctx = ctxOf([{ name: 'vxlan0', type: 'dummy', state: 'up' }]);
        expect(classify(ctx.interfaces[0], ctx)).toEqual({
            role: 'unclassified',
            reason: 'no rule matched type "dummy"'
        });
    });

    it('resolves every interface in every fixture to some role', () => {
        ['basic-host', 'primary-cudn-vrf', 'bonded-lldp', 'vrf-mixed-routes', 'partial-missing-fields']
            .forEach((name) => {
                const ctx = fixtureCtx(name);
                ctx.interfaces.forEach((iface) => {
                    expect(typeof roleOf(iface, ctx)).toBe('string');
                });
            });
    });

    it('always explains itself', () => {
        const ctx = fixtureCtx('primary-cudn-vrf');
        ctx.interfaces.forEach((iface) => {
            expect(classify(iface, ctx).reason.length).toBeGreaterThan(10);
        });
    });
});

describe('classify against real captures', () => {
    it('splits the CNV worker the way the lanes expect', () => {
        const ctx = fixtureCtx('primary-cudn-vrf');
        const names = (role: InterfaceRole) => interfacesWithRole(ctx, role).map((i) => i.name).sort();

        expect(names('physical')).toEqual(['ens161', 'ens192', 'ens224', 'ens256']);
        expect(names('vlan')).toEqual(['ens224.456']);
        expect(names('vrf')).toEqual(['example-p-cudn']);
        expect(names('bridge')).toEqual(['br-ex', 'br-vmdata']);
        expect(names('bridge-port')).toEqual(['br-ex', 'ovs-vlan-1920']);
        expect(names('patch')).toHaveLength(4);
        expect(names('host-local')).toEqual(['0cb0de1976d0c71', 'lo']);
        // The Geneve tunnel: no rule covers it yet. See ovn-recon-s3t.29.
        expect(names('unclassified')).toEqual(['genev_sys_6081']);
    });

    it('splits the bonded worker, including three bonds with different fates', () => {
        const ctx = fixtureCtx('bonded-lldp');
        const names = (role: InterfaceRole) => interfacesWithRole(ctx, role).map((i) => i.name).sort();

        expect(names('bond')).toEqual(['bond0', 'bond1', 'bond2']);
        expect(names('bridge')).toEqual(['br-ex', 'ovs-vm']);
        // Nine interfaces report type 'ethernet', but only eight are NICs: on this
        // cluster the Geneve tunnel reports as an ignored ethernet, so the ignore rule
        // keeps it out of the physical lane. In primary-cudn-vrf.json the same tunnel
        // reports as 'unknown' instead -- the type varies by cluster, the outcome does
        // not, since both are undrawn.
        expect(names('physical')).toHaveLength(8);
        expect(names('physical')).not.toContain('genev_sys_6081');
        expect(roleIn([{ name: 'genev_sys_6081', type: 'ethernet', state: 'ignore' }], 'genev_sys_6081'))
            .toBe('unmanaged');
    });

    it('leaves nothing in a lane it does not belong in', () => {
        // Every drawn interface belongs to exactly one lane.
        const ctx = fixtureCtx('bonded-lldp');
        const drawn = ctx.interfaces.filter((i) => isDrawn(roleOf(i, ctx)));
        const counted = (['physical', 'bond', 'vlan', 'bridge', 'bridge-port', 'vrf', 'host-local', 'unclassified'] as const)
            .reduce((total, role) => total + interfacesWithRole(ctx, role).length, 0);

        expect(counted).toBe(drawn.length);
    });
});
