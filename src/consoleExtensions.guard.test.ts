import fs from 'fs';
import path from 'path';

import { FLAG_RESOURCE_ACTIONS, FLAG_RESOURCE_TABS, TAB_HREF } from './components/consoleIntegration';

/**
 * Guard for ovn-recon-zdt.7: nothing OVN Recon adds to a console page it does not own
 * may be unconditional. Every tab and every action must require the feature flag that
 * the OvnRecon resource drives, so that both stay off until an administrator turns them
 * on. Adding one without its flag fails here, not in a customer's console.
 */

interface Extension {
    type: string;
    properties: Record<string, unknown>;
    flags?: { required?: string[]; disallowed?: string[] };
}

const root = process.cwd();
const extensions: Extension[] = JSON.parse(fs.readFileSync(path.join(root, 'console-extensions.json'), 'utf-8'));
const exposedModules: Record<string, string> =
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')).consolePlugin.exposedModules;

const describeExtension = (extension: Extension): string => JSON.stringify(extension.properties);
const required = (extension: Extension): string[] => extension.flags?.required ?? [];

/** Extension types that put something on a page the plugin does not own, and their flag. */
const GATED: Record<string, string> = {
    'console.tab/horizontalNav': FLAG_RESOURCE_TABS,
    'console.tab': FLAG_RESOURCE_TABS,
    'console.action/resource-provider': FLAG_RESOURCE_ACTIONS,
    'console.action/provider': FLAG_RESOURCE_ACTIONS,
};

describe('console-extensions.json integration guard (ovn-recon-zdt.7)', () => {
    it.each(Object.entries(GATED))('every %s extension requires %s', (type, flag) => {
        const missing = extensions
            .filter((extension) => extension.type === type)
            .filter((extension) => !required(extension).includes(flag))
            .map(describeExtension);
        expect(missing).toEqual([]);
    });

    it('never gates a contributed tab or action on anything that could turn it on by default', () => {
        // A disallowed flag reads as "on unless the flag is set": the opposite of opt-in.
        const disallowed = extensions
            .filter((extension) => extension.type in GATED)
            .filter((extension) => (extension.flags?.disallowed ?? []).length > 0)
            .map(describeExtension);
        expect(disallowed).toEqual([]);
    });

    it('registers the hook that drives both flags', () => {
        const providers = extensions.filter((extension) => extension.type === 'console.flag/hookProvider');
        expect(providers).toHaveLength(1);
        const codeRef = (providers[0].properties.handler as { $codeRef: string }).$codeRef;
        expect(codeRef).toBe('ConsoleIntegrationFlags.useConsoleIntegrationFlags');
    });

    it('adds the OVN Recon tab and action to Node, CUDN, UDN and NAD, and nowhere else', () => {
        const kinds = (type: string) => extensions
            .filter((extension) => extension.type === type)
            .map((extension) => (extension.properties.model as { kind: string }).kind)
            .sort();
        const expected = ['ClusterUserDefinedNetwork', 'NetworkAttachmentDefinition', 'Node', 'UserDefinedNetwork'];
        expect(kinds('console.tab/horizontalNav')).toEqual(expected);
        expect(kinds('console.action/resource-provider')).toEqual(expected);
        extensions
            .filter((extension) => extension.type === 'console.tab/horizontalNav')
            .forEach((extension) => expect(extension.properties.page).toEqual({ name: 'OVN Recon', href: TAB_HREF }));
    });

    it('points every code reference at an exposed module', () => {
        const modules = new Set<string>();
        const collect = (value: unknown) => {
            if (value && typeof value === 'object') {
                const ref = (value as { $codeRef?: unknown }).$codeRef;
                if (typeof ref === 'string') modules.add(ref.split('.')[0]);
                Object.values(value).forEach(collect);
            }
        };
        extensions.forEach((extension) => collect(extension.properties));
        const unexposed = [...modules].filter((module) => !(module in exposedModules));
        expect(unexposed).toEqual([]);
    });
});
