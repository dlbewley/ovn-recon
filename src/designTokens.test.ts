import fs from 'fs';
import path from 'path';

/**
 * The plugin is on PatternFly v6, which ships none of the v4/v5 `--pf-global--*`
 * custom properties. An unresolved var() fails silently: text loses its colour,
 * and an unresolved paint value renders an SVG fill as black. That is how the
 * attachment nodes came to be drawn black instead of gold.
 *
 * Guard the migration rather than relying on someone noticing.
 */
const LEGACY_TOKEN = /--pf-global--/;

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.(ts|tsx|css|scss)$/.test(entry.name) ? [full] : [];
    });

describe('design tokens', () => {
    it('uses no PatternFly v4/v5 tokens', () => {
        const offenders = sourceFiles(path.join(process.cwd(), 'src'))
            .filter((file) => !file.endsWith('designTokens.test.ts'))
            .flatMap((file) =>
                fs.readFileSync(file, 'utf-8')
                    .split('\n')
                    .map((line, index) => ({ file: path.relative(process.cwd(), file), line: index + 1, text: line }))
                    .filter((entry) => LEGACY_TOKEN.test(entry.text))
            )
            .map((entry) => `${entry.file}:${entry.line}`);

        expect(offenders).toEqual([]);
    });

    it('resolves every token it does use against the PatternFly stylesheet', () => {
        // A typo in a v6 token name fails just as silently as a v4 one.
        const baseCss = fs.readFileSync(
            path.join(process.cwd(), 'node_modules', '@patternfly', 'react-core', 'dist', 'styles', 'base.css'),
            'utf-8'
        );

        const used = new Set<string>();
        sourceFiles(path.join(process.cwd(), 'src'))
            .filter((file) => !file.endsWith('designTokens.test.ts'))
            .forEach((file) => {
                const matches = fs.readFileSync(file, 'utf-8').match(/--pf-t--[a-z0-9-]+/g) || [];
                matches.forEach((token) => used.add(token));
            });

        expect(used.size).toBeGreaterThan(0);
        const undefined_ = Array.from(used).filter((token) => !baseCss.includes(`${token}:`));
        expect(undefined_).toEqual([]);
    });
});
