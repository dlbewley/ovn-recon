import { capabilitiesFrom } from './capabilities';

describe('console capabilities from extensions (ovn-recon-zdt.4)', () => {
    const extensions = [
        {
            type: 'console.navigation/href',
            pluginName: 'nmstate-console-plugin',
            properties: { id: 'topology', href: '/node-network-configuration' },
        },
        {
            // nmstate writes its route without a leading slash; a nav item may too.
            type: 'console.navigation/href',
            pluginName: 'nmstate-console-plugin',
            properties: { id: 'physical-networks', href: 'physical-networks' },
        },
        {
            type: 'console.navigation/resource-ns',
            pluginName: 'networking-console-plugin',
            properties: { id: 'udns', model: { group: 'k8s.ovn.org', version: 'v1', kind: 'UserDefinedNetwork' } },
        },
        {
            type: 'console.flag/model',
            pluginName: 'ovn-recon',
            properties: { flag: 'X', model: { group: 'a', version: 'v1', kind: 'B' } },
        },
        { type: 'console.navigation/href', properties: { href: '/orphan' } },
    ];

    it('names every plugin that contributed an extension in use', () => {
        const { plugins } = capabilitiesFrom(extensions, {});
        expect([...plugins].sort()).toEqual(['networking-console-plugin', 'nmstate-console-plugin', 'ovn-recon']);
    });

    it('collects navigation hrefs per plugin, with a leading slash', () => {
        const { navHrefs } = capabilitiesFrom(extensions, {});
        expect([...navHrefs.get('nmstate-console-plugin')!].sort())
            .toEqual(['/node-network-configuration', '/physical-networks']);
        expect(navHrefs.has('networking-console-plugin')).toBe(false);
    });

    it('ignores an extension that names no plugin', () => {
        const { navHrefs } = capabilitiesFrom(extensions, {});
        expect([...navHrefs.values()].some((hrefs) => hrefs.has('/orphan'))).toBe(false);
    });

    it('carries the CRD answers through unchanged', () => {
        const crds = { 'a~v1~B': true, 'c~v1~D': undefined };
        expect(capabilitiesFrom([], crds).crds).toBe(crds);
    });
});
