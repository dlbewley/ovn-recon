#!/usr/bin/env node
/**
 * Canonical formatting for the collector's JSON contract artifacts: the JSON
 * schemas under collector/api and the fixture corpus under
 * collector/fixtures/snapshots.
 *
 * Canonical means exactly what JSON.stringify(value, null, 2) produces, plus a
 * trailing newline: two-space indent, one key per line, keys in file order
 * (never sorted, so the schemas keep their readable property order), no
 * trailing whitespace. Python's json.dumps(value, indent=2, ensure_ascii=False)
 * yields the identical bytes, so a script in either language can load, edit
 * and dump a contract file without a formatting diff.
 *
 *   node scripts/format-contract-json.js          # rewrite files in place
 *   node scripts/format-contract-json.js --check  # exit 1 if any file differs
 *
 * `npm run test` runs the same check (src/contractJsonFormat.test.ts), so CI
 * fails on a hand-formatted edit. ovn-recon-e2b.11.
 */
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

const CONTRACT_DIRS = ['collector/api', 'collector/fixtures/snapshots'];

/** Every JSON file under the contract directories, repo-relative, sorted. */
const contractJsonFiles = () =>
    CONTRACT_DIRS.flatMap((dir) =>
        fs
            .readdirSync(path.join(repoRoot, dir))
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => path.join(dir, name)),
    );

const canonicalJson = (raw) => JSON.stringify(JSON.parse(raw), null, 2) + '\n';

/** Repo-relative paths of files whose bytes differ from their canonical form. */
const nonCanonicalFiles = () =>
    contractJsonFiles().filter((file) => {
        const raw = fs.readFileSync(path.join(repoRoot, file), 'utf8');
        return raw !== canonicalJson(raw);
    });

const main = () => {
    const check = process.argv.includes('--check');
    const stale = nonCanonicalFiles();
    if (check) {
        if (stale.length > 0) {
            console.error('Contract JSON is not in canonical form:');
            for (const file of stale) console.error(`  ${file}`);
            console.error('Run: npm run format:contract');
            process.exit(1);
        }
        console.log(`Contract JSON is canonical (${contractJsonFiles().length} files).`);
        return;
    }
    for (const file of stale) {
        const absolute = path.join(repoRoot, file);
        fs.writeFileSync(absolute, canonicalJson(fs.readFileSync(absolute, 'utf8')));
        console.log(`Reformatted ${file}`);
    }
    if (stale.length === 0) console.log('Contract JSON already canonical.');
};

module.exports = { CONTRACT_DIRS, canonicalJson, contractJsonFiles, nonCanonicalFiles };

if (require.main === module) {
    main();
}
