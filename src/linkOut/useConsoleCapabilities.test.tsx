import { renderHook } from '../components/testHookHarness';
import type { ConsoleCapabilities } from './registry';

const mockExtensions = jest.fn();
const mockFlags: Record<string, boolean | undefined> = {};
const mockGuards: Array<(extension: { type: string }) => boolean> = [];
const mockWatch = jest.fn();

jest.mock('@openshift-console/dynamic-plugin-sdk', () => {
    const is = (type: string) => (extension: { type: string }) => extension.type === type;
    return {
        isHrefNavItem: is('console.navigation/href'),
        isResourceNSNavItem: is('console.navigation/resource-ns'),
        isResourceClusterNavItem: is('console.navigation/resource-cluster'),
        isModelFeatureFlag: is('console.flag/model'),
        useFlag: (flag: string) => mockFlags[flag],
        useK8sWatchResource: (resource: unknown) => mockWatch(resource),
        useResolvedExtensions: (guard: (extension: { type: string }) => boolean) => {
            mockGuards.push(guard);
            return [mockExtensions().filter(guard), true, []];
        },
    };
});

// jest.setup.js replaces the hook for every suite; this one tests the real thing.
const { useConsoleCapabilities } = jest.requireActual('./useConsoleCapabilities') as {
    useConsoleCapabilities: () => ConsoleCapabilities;
};

describe('useConsoleCapabilities (ovn-recon-zdt.4)', () => {
    beforeEach(() => {
        mockGuards.length = 0;
        mockWatch.mockReset();
        mockWatch.mockReturnValue([undefined, false, undefined]);
        Object.keys(mockFlags).forEach((key) => delete mockFlags[key]);
        mockExtensions.mockReturnValue([
            {
                type: 'console.navigation/href',
                pluginName: 'nmstate-console-plugin',
                properties: { href: '/node-network-configuration' },
            },
            {
                type: 'console.page/route',
                pluginName: 'some-plugin-with-pages',
                properties: { path: '/somewhere', component: { $codeRef: 'Page' } },
            },
        ]);
    });

    it('detects a plugin from the pluginName of its extensions', () => {
        const capabilities = renderHook(() => useConsoleCapabilities());
        expect(capabilities.plugins.has('nmstate-console-plugin')).toBe(true);
        expect(capabilities.navHrefs.get('nmstate-console-plugin')?.has('/node-network-configuration')).toBe(true);
    });

    it('never asks for an extension type that carries a code reference', () => {
        const capabilities = renderHook(() => useConsoleCapabilities());
        // Resolving another plugin's page extension would download that page.
        expect(capabilities.plugins.has('some-plugin-with-pages')).toBe(false);
        for (const type of [
            'console.page/route', 'console.page/resource/list', 'console.page/resource/details',
            'console.tab/horizontalNav', 'console.flag', 'console.flag/hookProvider',
        ]) {
            expect(mockGuards.some((guard) => guard({ type }))).toBe(false);
        }
    });

    it('reads CRD presence from the model flags: true, false, and not yet known', () => {
        mockFlags.OVN_RECON_CRD_NNCP = true;
        mockFlags.OVN_RECON_CRD_MULTI_NETWORK_POLICY = false;
        const { crds } = renderHook(() => useConsoleCapabilities());
        expect(crds['nmstate.io~v1~NodeNetworkConfigurationPolicy']).toBe(true);
        expect(crds['k8s.cni.cncf.io~v1beta1~MultiNetworkPolicy']).toBe(false);
        expect(crds['k8s.ovn.org~v1~UserDefinedNetwork']).toBeUndefined();
    });

    describe('Network Observability (ovn-recon-vqd.1)', () => {
        const netobservNav = {
            type: 'console.navigation/href',
            pluginName: 'netobserv-plugin',
            properties: { href: '/netflow-traffic' },
        };
        const flowCollector = { spec: { agent: { ebpf: { features: ['UDNMapping'] } } } };

        it('watches nothing and reports nothing when the plugin is not loaded', () => {
            mockFlags.NETOBSERV_LOKI_ENABLED = true;
            const capabilities = renderHook(() => useConsoleCapabilities());
            expect(mockWatch).toHaveBeenCalledWith(null);
            expect(capabilities.netobserv).toBeUndefined();
        });

        it('watches the one FlowCollector by name once the plugin is loaded', () => {
            mockExtensions.mockReturnValue([netobservNav]);
            mockFlags.NETOBSERV_LOKI_ENABLED = true;
            mockWatch.mockReturnValue([flowCollector, true, undefined]);
            const { netobserv } = renderHook(() => useConsoleCapabilities());
            expect(mockWatch).toHaveBeenCalledWith({
                groupVersionKind: { group: 'flows.netobserv.io', version: 'v1beta2', kind: 'FlowCollector' },
                name: 'cluster',
                isList: false,
            });
            expect(netobserv?.loki).toBe(true);
            expect(netobserv?.nodeMetrics).toBe(true);
            expect([...netobserv!.features!]).toEqual(['UDNMapping']);
        });

        it('knows only the flag when the FlowCollector is forbidden or still loading', () => {
            mockExtensions.mockReturnValue([netobservNav]);
            mockFlags.NETOBSERV_LOKI_ENABLED = true;
            mockWatch.mockReturnValue([flowCollector, true, new Error('forbidden')]);
            expect(renderHook(() => useConsoleCapabilities()).netobserv).toEqual({ loki: true });
            mockWatch.mockReturnValue([undefined, false, undefined]);
            expect(renderHook(() => useConsoleCapabilities()).netobserv).toEqual({ loki: true });
        });
    });
});
