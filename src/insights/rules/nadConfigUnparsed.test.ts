import type { NetworkAttachmentDefinition } from '../../types';
import { clone, clusterContext, fixtureNames, loadItems } from '../testing';
import { nadConfigUnparsed } from './nadConfigUnparsed';

const sriov = loadItems<NetworkAttachmentDefinition>('nad', 'sriov.json');

describe('nad-config-unparsed', () => {
    it('fires on a config that is not JSON, marking what the fallback recovered as inferred', () => {
        // The real SR-IOV NAD with the trailing comma a hand edit leaves behind.
        const nads = clone(sriov);
        nads[0].spec!.config = nads[0].spec!.config.replace('"ipam": {}', '"ipam": {},');

        const findings = nadConfigUnparsed.evaluate(clusterContext({ nads }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            subject: { kind: 'k8s', ref: expect.objectContaining({ kind: 'NetworkAttachmentDefinition', name: 'vm-igb', namespace: 'default' }) },
            summary: 'NetworkAttachmentDefinition default/vm-igb has a spec.config that is not valid JSON.'
        }));
        expect(findings[0].evidence[0].fact).toMatch(/^spec\.config does not parse as a JSON object: /);
        expect(findings[0].evidence[1]).toEqual(expect.objectContaining({
            fact: 'The view read type sriov from it by pattern.',
            inferred: 'Matched by regular expression in text that is not JSON.'
        }));
        expect(findings[0].remedy.path).toBe('spec.config');
    });

    it('fires on JSON that is not an object', () => {
        const nads = clone(sriov);
        nads[0].spec!.config = '[]';
        expect(nadConfigUnparsed.evaluate(clusterContext({ nads }))[0].evidence[0].fact)
            .toBe('spec.config does not parse as a JSON object: it is JSON, but not a JSON object.');
    });

    it.each(fixtureNames('nad'))('is quiet on the %s capture', (name) => {
        const nads = loadItems<NetworkAttachmentDefinition>('nad', name);
        expect(nadConfigUnparsed.evaluate(clusterContext({ nads }))).toEqual([]);
    });

    it('is quiet on an empty config and on one the API client already parsed', () => {
        const nads = clone(sriov);
        nads[0].spec!.config = '';
        const parsed = { ...clone(sriov[0]), spec: { config: { type: 'sriov' } as unknown as string } };
        expect(nadConfigUnparsed.evaluate(clusterContext({ nads: [...nads, parsed] }))).toEqual([]);
    });
});
