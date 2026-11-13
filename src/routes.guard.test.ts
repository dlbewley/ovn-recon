import fs from 'fs';
import path from 'path';
import * as ts from 'typescript';

/**
 * Guard for ovn-recon-gbr.2: src/routes.ts is the only place an OVN Recon page path
 * is written. A `/ovn-recon` page path in a string, template or JSX text anywhere
 * else in src fails here; build it with a routes.ts builder instead.
 *
 * Comments are not checked, test files are exempt, and so are the collector API
 * prefixes in collectorApi.ts (`/api/proxy/plugin/ovn-recon/...`), which are not
 * page paths. console-extensions.json and package.json are not under src.
 */

const SRC = path.join(process.cwd(), 'src');
const ROUTES = path.join(SRC, 'routes.ts');

/** `/ovn-recon` as a path of its own: not `/ovn-recon-zdt`, not `.../plugin/ovn-recon`. */
const PAGE_PATH = /(?<![\w.-])\/ovn-recon(?![\w-])/;

const isTestFile = (file: string): boolean =>
    /\.test\.[jt]sx?$/.test(file) || file.split(path.sep).some((part) => part === '__tests__' || part === '__snapshots__');

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return sourceFiles(full);
        return /\.[jt]sx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [full] : [];
    });

/** The text of every string, template piece and JSX text in a file, with its line. */
const literals = (file: string, text: string): { line: number; text: string }[] => {
    const kind = /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const found: { line: number; text: string }[] = [];
    const visit = (node: ts.Node) => {
        if (
            ts.isStringLiteral(node) ||
            ts.isNoSubstitutionTemplateLiteral(node) ||
            ts.isTemplateHead(node) ||
            ts.isTemplateMiddle(node) ||
            ts.isTemplateTail(node) ||
            ts.isJsxText(node)
        ) {
            found.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
};

const pagePathLiterals = (file: string, text: string): string[] =>
    literals(file, text)
        .filter((literal) => PAGE_PATH.test(literal.text))
        .map((literal) => `${path.relative(process.cwd(), file)}:${literal.line}: ${JSON.stringify(literal.text)}`);

describe('page paths live in src/routes.ts (ovn-recon-gbr.2)', () => {
    it('has no /ovn-recon page-path literal outside routes.ts and tests', () => {
        const offenders = sourceFiles(SRC)
            .filter((file) => file !== ROUTES && !isTestFile(file))
            .flatMap((file) => pagePathLiterals(file, fs.readFileSync(file, 'utf-8')));
        expect(offenders).toEqual([]);
    });

    it('sees the literals in routes.ts itself, so the scan is not vacuous', () => {
        expect(pagePathLiterals(ROUTES, fs.readFileSync(ROUTES, 'utf-8')).length).toBeGreaterThan(0);
    });

    it('flags page paths in strings, templates and JSX, and nothing else', () => {
        const sample = [
            "const a = '/ovn-recon';",
            'const b = `/ovn-recon/ovn/${node}`;',
            'const c = `${x}/ovn-recon/networks`;',
            'const d = <p>Open /ovn-recon?q=1</p>;',
            "// a comment about /ovn-recon is fine",
            "const e = '/api/proxy/plugin/ovn-recon/backend/api/v1';",
            "const f = '/api/plugins/ovn-recon/api/v1';",
            "const g = 'ovn-recon-gbr.2';",
            "const h = '/ovn-reconx';",
        ].join('\n');
        expect(pagePathLiterals('sample.tsx', sample).map((hit) => hit.split(': ')[0])).toEqual([
            'sample.tsx:1',
            'sample.tsx:2',
            'sample.tsx:3',
            'sample.tsx:4',
        ]);
    });
});
