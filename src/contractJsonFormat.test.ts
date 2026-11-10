// The collector's JSON contract artifacts (schemas and fixture corpus) are
// kept in canonical serializer form so that scripted edits in Node or Python
// round-trip without formatting churn. The rule and the formatter live in
// scripts/format-contract-json.js; this test is what makes CI enforce it.
import { canonicalJson, contractJsonFiles, nonCanonicalFiles } from '../scripts/format-contract-json';

describe('contract JSON formatting', () => {
    it('covers the schemas and the fixture corpus', () => {
        const files: string[] = contractJsonFiles();
        expect(files).toEqual(
            expect.arrayContaining([
                'collector/api/logical-topology-snapshot.schema.json',
                'collector/api/cluster-logical-topology.schema.json',
                'collector/api/lookup-response.schema.json',
                'collector/fixtures/snapshots/cnv-1.json',
                'collector/fixtures/snapshots/default.json',
            ]),
        );
    });

    it('keeps every contract file in canonical form (run npm run format:contract to fix)', () => {
        expect(nonCanonicalFiles()).toEqual([]);
    });

    it('defines canonical as two-space JSON.stringify with a trailing newline, keys in file order', () => {
        expect(canonicalJson('{"b":1,"a":[1,2],"c":{}}')).toBe('{\n  "b": 1,\n  "a": [\n    1,\n    2\n  ],\n  "c": {}\n}\n');
    });
});
