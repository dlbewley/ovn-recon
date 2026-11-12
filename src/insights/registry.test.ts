import * as fs from 'fs';
import * as path from 'path';
import { ALL_RULES, getRule, LOGICAL_RULES, PHYSICAL_RULES } from './registry';

/**
 * Guard rails on the rule list. The confirmed list and severities are on
 * ovn-recon-7i6.2; the README says why some candidates are not findings.
 */
describe('the rule registry', () => {
    it('ships the confirmed physical rules, all warnings', () => {
        expect(PHYSICAL_RULES.map((rule) => [rule.id, rule.severity])).toEqual([
            ['localnet-unmapped', 'warning'],
            ['mapping-bridge-missing', 'warning'],
            ['interface-down', 'warning'],
            ['bond-degraded', 'warning'],
            ['nnce-failing', 'warning'],
            ['mtu-exceeds-uplink', 'warning'],
            ['nad-config-unparsed', 'warning'],
            ['vrf-port-unmatched', 'warning']
        ]);
    });

    it('ships the confirmed logical rules, all warnings (ovn-recon-7i6.3)', () => {
        expect(LOGICAL_RULES.map((rule) => [rule.id, rule.severity, rule.domain])).toEqual([
            ['lsp-down', 'warning', 'logical'],
            ['mnp-missing-nad', 'warning', 'logical'],
            ['match-ref-unresolved', 'warning', 'logical'],
            ['mac-binding-orphan', 'warning', 'logical'],
            ['collector-degraded', 'warning', 'logical']
        ]);
    });

    it('has unique ids and looks them up', () => {
        const ids = ALL_RULES.map((rule) => rule.id);
        expect(new Set(ids).size).toBe(ids.length);
        expect(getRule('bond-degraded')?.scope).toBe('node');
        expect(getRule('nope')).toBeUndefined();
    });

    it('holds none of the candidates decided not to be findings', () => {
        // Partial Localnet coverage, a second default route, an unreferenced mapping:
        // see README.md before adding any of these.
        // Logical side: Service VIPs without endpoints, a router policy naming a port the
        // router no longer has.
        [
            'localnet-partial', 'multiple-default-routes', 'mapping-unreferenced',
            'vip-no-endpoints', 'router-policy-stale-port'
        ].forEach((id) =>
            expect(getRule(id)).toBeUndefined());
    });

    it('gives every rule its own file and test', () => {
        const dir = path.join(__dirname, 'rules');
        const files = fs.readdirSync(dir);
        ALL_RULES.forEach((rule) => {
            const base = rule.id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
            expect(files).toContain(`${base}.ts`);
            expect(files).toContain(`${base}.test.ts`);
        });
    });
});
