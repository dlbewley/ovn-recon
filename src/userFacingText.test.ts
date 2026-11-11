import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * Issue IDs belong in comments, never in text a user can read.
 *
 * A drawer hint once ended "(the rule from ovn-recon-s3t.26)". It went unnoticed while
 * hints were native tooltips and became plain to see when they turned into popovers.
 * Comments are the right place to say which issue a line answers; string literals,
 * template literals and JSX text are what reaches the screen, so those are scanned.
 */
const ISSUE_ID = /ovn-recon-[a-z0-9]{3}(?:\.\d+)?(?![a-z0-9-])/;

/** Properties that hold an issue ID as data and are never rendered. */
const DATA_PROPERTIES = new Set(['bead']);

const sourceFiles = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return entry.name === '__snapshots__' ? [] : sourceFiles(full);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')
            ? [full]
            : [];
    });

const isTextNode = (node: ts.Node): node is ts.LiteralLikeNode =>
    ts.isStringLiteral(node)
    || ts.isNoSubstitutionTemplateLiteral(node)
    || ts.isTemplateHead(node)
    || ts.isTemplateMiddle(node)
    || ts.isTemplateTail(node)
    || ts.isJsxText(node);

const isDataProperty = (node: ts.Node): boolean => {
    const parent = node.parent;
    return Boolean(
        parent
        && ts.isPropertyAssignment(parent)
        && parent.initializer === node
        && (ts.isIdentifier(parent.name) || ts.isStringLiteral(parent.name))
        && DATA_PROPERTIES.has(parent.name.text)
    );
};

/** Every piece of text in a source file that names an issue, as `line: text`. */
const issueIdsInText = (fileName: string, source: string): string[] => {
    const file = ts.createSourceFile(
        fileName,
        source,
        ts.ScriptTarget.Latest,
        true,
        fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const found: string[] = [];
    const visit = (node: ts.Node) => {
        if (isTextNode(node) && ISSUE_ID.test(node.text) && !isDataProperty(node)) {
            const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
            found.push(`${line + 1}: ${node.text.trim()}`);
        }
        ts.forEachChild(node, visit);
    };
    visit(file);
    return found;
};

describe('user-facing text', () => {
    it('finds an issue ID in a string, a template and JSX text, and ignores comments and data', () => {
        const source = [
            '// ovn-recon-abc.1 explains this line',
            "const hint = 'see ovn-recon-abc.1';",
            'const label = `rule ${n} from ovn-recon-xyz`;',
            'const el = <span>tracked as ovn-recon-a1b.22</span>;',
            "const gate = { bead: 'ovn-recon-abc.2' };",
            "const service = 'ovn-recon-collector';",
            "const path = '/api/plugins/ovn-recon/api/v1';"
        ].join('\n');
        expect(issueIdsInText('sample.tsx', source)).toEqual([
            '2: see ovn-recon-abc.1',
            '3: from ovn-recon-xyz',
            '4: tracked as ovn-recon-a1b.22'
        ]);
    });

    it('names no issue ID in any source file', () => {
        const root = path.join(process.cwd(), 'src');
        const offenders = sourceFiles(root).flatMap((file) =>
            issueIdsInText(file, fs.readFileSync(file, 'utf8')).map(
                (hit) => `${path.relative(process.cwd(), file)}:${hit}`
            )
        );
        expect(offenders).toEqual([]);
    });
});
