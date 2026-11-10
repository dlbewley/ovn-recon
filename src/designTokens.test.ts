import fs from 'fs';
import path from 'path';

import { NETWORK_PALETTE, NETWORK_SLOTS } from './components/LogicalLadderView';
import { NETWORK_PALETTE_SIZE } from './components/logicalLadderLayout';
import { NODE_TYPES } from './topology/descriptors';
import { CATEGORICAL_COLORS, CategoricalColor, STATUS_STYLE, SURFACE } from './topology/palette';

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

// --- categorical colours (ovn-recon-nt4.1) -----------------------------------------

/**
 * The graph spends colour on two jobs: categorical (which kind, which network) and
 * status (up, down, a finding). The review that started ovn-recon-nt4 found them
 * mixed -- a healthy network drawn in PatternFly's danger red, a down NIC shown as a
 * red dot on a saturated purple block. These tests keep them apart, measured against
 * the PatternFly stylesheet the plugin builds with, in both console themes.
 */
describe('categorical colours', () => {
    type Color = CategoricalColor;

    // The token maps for each theme, read from the stylesheet's :root blocks.
    const css = fs.readFileSync(
        path.join(process.cwd(), 'node_modules', '@patternfly', 'react-core', 'dist', 'styles', 'base.css'),
        'utf-8'
    );
    const blocks = new Map<string, Record<string, string>>();
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selector = match[1].trim().replace(/\s+/g, ' ');
        const declarations = blocks.get(selector) ?? {};
        for (const decl of match[2].match(/--pf-t--[a-z0-9-]+\s*:[^;]+/g) ?? []) {
            const colon = decl.indexOf(':');
            declarations[decl.slice(0, colon).trim()] = decl.slice(colon + 1).trim();
        }
        blocks.set(selector, declarations);
    }
    const themes: Record<'light' | 'dark', Record<string, string>> = {
        light: blocks.get(':root') ?? {},
        dark: { ...blocks.get(':root'), ...blocks.get(':root:where(.pf-v6-theme-dark)') }
    };
    const resolve = (value: string, theme: 'light' | 'dark', depth = 0): string => {
        if (depth > 20) throw new Error(`token cycle at ${value}`);
        return value.replace(/var\((--pf-t--[a-z0-9-]+)(?:,[^)]*)?\)/g, (_all, token: string) => {
            const next = themes[theme][token];
            if (next === undefined) throw new Error(`${token} is not defined for the ${theme} theme`);
            return resolve(next, theme, depth + 1);
        }).toLowerCase();
    };
    const tokenValue = (token: string, theme: 'light' | 'dark') => resolve(`var(${token})`, theme);

    // Colour arithmetic: WCAG contrast, CIELAB and CIEDE2000.
    const rgb = (hex: string): number[] => {
        const h = hex.replace('#', '');
        const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
        return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    };
    const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminance = (hex: string) => {
        const [r, g, b] = rgb(hex).map(linear);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a: string, b: string) => {
        const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (hi + 0.05) / (lo + 0.05);
    };
    const lab = (hex: string): [number, number, number] => {
        const [r, g, b] = rgb(hex).map(linear);
        const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
        const x = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047);
        const y = f(0.2126 * r + 0.7152 * g + 0.0722 * b);
        const z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883);
        return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
    };
    const hueOf = (hex: string) => {
        const [, a, b] = lab(hex);
        const h = (Math.atan2(b, a) * 180) / Math.PI;
        return { hue: h < 0 ? h + 360 : h, chroma: Math.hypot(a, b) };
    };
    /** CIEDE2000 colour difference; about 2 is a just-noticeable difference. */
    const deltaE = (hex1: string, hex2: string): number => {
        const [L1, a1, b1] = lab(hex1);
        const [L2, a2, b2] = lab(hex2);
        const rad = Math.PI / 180;
        const Cbar = (Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2;
        const G = 0.5 * (1 - Math.sqrt(Cbar ** 7 / (Cbar ** 7 + 25 ** 7)));
        const ap1 = (1 + G) * a1;
        const ap2 = (1 + G) * a2;
        const C1 = Math.hypot(ap1, b1);
        const C2 = Math.hypot(ap2, b2);
        const hp = (a: number, b: number) => {
            if (a === 0 && b === 0) return 0;
            const h = Math.atan2(b, a) / rad;
            return h < 0 ? h + 360 : h;
        };
        const h1 = hp(ap1, b1);
        const h2 = hp(ap2, b2);
        let dh = 0;
        if (C1 * C2 !== 0) {
            dh = h2 - h1;
            if (dh > 180) dh -= 360;
            else if (dh < -180) dh += 360;
        }
        const dL = L2 - L1;
        const dC = C2 - C1;
        const dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
        const Lbar = (L1 + L2) / 2;
        const Cpbar = (C1 + C2) / 2;
        let hbar = h1 + h2;
        if (C1 * C2 !== 0) {
            hbar = Math.abs(h1 - h2) > 180 ? (h1 + h2 + (h1 + h2 < 360 ? 360 : -360)) / 2 : (h1 + h2) / 2;
        }
        const T = 1 - 0.17 * Math.cos((hbar - 30) * rad) + 0.24 * Math.cos(2 * hbar * rad)
            + 0.32 * Math.cos((3 * hbar + 6) * rad) - 0.2 * Math.cos((4 * hbar - 63) * rad);
        const dTheta = 30 * Math.exp(-(((hbar - 275) / 25) ** 2));
        const RC = 2 * Math.sqrt(Cpbar ** 7 / (Cpbar ** 7 + 25 ** 7));
        const SL = 1 + (0.015 * (Lbar - 50) ** 2) / Math.sqrt(20 + (Lbar - 50) ** 2);
        const SC = 1 + 0.045 * Cpbar;
        const SH = 1 + 0.015 * Cpbar * T;
        const RT = -Math.sin(2 * dTheta * rad) * RC;
        return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
    };

    const categorical: Color[] = CATEGORICAL_COLORS;
    const THEMES = ['light', 'dark'] as const;
    /** Every PatternFly status colour, as fill and as icon, in both themes. */
    const statusColors = THEMES.flatMap((theme) => [
        ...['success', 'warning', 'danger', 'info', 'custom'].flatMap((status) => [
            `--pf-t--global--color--status--${status}--default`,
            `--pf-t--global--icon--color--status--${status}--default`
        ]),
        // The severity icons sit on the same hues; important is PatternFly's orange.
        '--pf-t--global--icon--color--severity--critical--default',
        '--pf-t--global--icon--color--severity--important--default',
        '--pf-t--global--icon--color--severity--moderate--default'
    ].map((token) => ({ token, theme, hex: tokenValue(token, theme) })));
    const cardSurface = (theme: 'light' | 'dark') => resolve(SURFACE.card, theme);

    it('draws every node accent and band from the categorical palette', () => {
        const palette = categorical.map((color) => color.css);
        NODE_TYPES.forEach((descriptor) =>
            expect({ type: descriptor.type, color: palette.includes(descriptor.color) })
                .toEqual({ type: descriptor.type, color: true }));
        expect(NETWORK_PALETTE).toEqual(NETWORK_SLOTS.map((slot) => slot.css));
        NETWORK_SLOTS.forEach((slot) => expect(categorical).toContain(slot));
    });

    it('uses the PatternFly token wherever one exists, with its own value as the fallback', () => {
        const paletteTokens = Object.keys(themes.light).filter((token) => /^--pf-t--color--/.test(token));
        categorical.forEach((color) => {
            if (color.token) {
                expect(color.css).toBe(`var(${color.token}, ${color.hex})`);
                expect({ name: color.name, value: tokenValue(color.token, 'light') })
                    .toEqual({ name: color.name, value: color.hex.toLowerCase() });
            } else {
                expect(color.css).toBe(color.hex);
                const same = paletteTokens.filter((token) => tokenValue(token, 'light') === color.hex.toLowerCase());
                expect({ name: color.name, tokensWithThisValue: same }).toEqual({ name: color.name, tokensWithThisValue: [] });
            }
        });
    });

    it('keeps every categorical colour clear of every status colour', () => {
        // CIEDE2000 under 10 reads as "the same colour, a shade off" at a glance.
        const tooClose = categorical.flatMap((color) => statusColors
            .filter((status) => deltaE(color.hex, status.hex) < 10)
            .map((status) => `${color.name} ${color.hex} ~ ${status.token} (${status.theme}) ${status.hex}: `
                + `ΔE ${deltaE(color.hex, status.hex).toFixed(1)}`));
        expect(tooClose).toEqual([]);
    });

    it('uses no danger or warning hue at all, at any shade', () => {
        // Hue alone, so a paler or darker red is caught too: within 35 degrees of the
        // danger or warning colour in either theme, for anything saturated enough to
        // read as a hue.
        const alarm = statusColors
            .filter((status) => /danger|warning|critical|important|moderate/.test(status.token))
            .map((status) => hueOf(status.hex).hue);
        const offenders = categorical.filter((color) => {
            const { hue, chroma } = hueOf(color.hex);
            return chroma > 15 && alarm.some((h) => Math.min(Math.abs(hue - h), 360 - Math.abs(hue - h)) < 35);
        }).map((color) => `${color.name} ${color.hex}`);
        expect(offenders).toEqual([]);
    });

    it('shows every categorical colour against the card surface in both themes', () => {
        // Accents are graphics -- a stripe, an icon, a band outline -- so WCAG 1.4.11's
        // 3:1 applies. They are never used for text.
        const faint = THEMES.flatMap((theme) => categorical
            .filter((color) => contrast(color.hex, cardSurface(theme)) < 3)
            .map((color) => `${color.name} on ${theme} ${cardSurface(theme)}: ${contrast(color.hex, cardSurface(theme)).toFixed(2)}`));
        expect(faint).toEqual([]);
    });

    it('keeps text on the graph surfaces at 4.5:1 in both themes', () => {
        const surfaces = [SURFACE.card, SURFACE.canvas];
        const texts = [SURFACE.text, SURFACE.subtleText, ...Object.values(STATUS_STYLE).map((style) => style.text)];
        const failing = THEMES.flatMap((theme) => surfaces.flatMap((surface) => texts
            .filter((text) => contrast(resolve(text, theme), resolve(surface, theme)) < 4.5)
            .map((text) => `${text} on ${surface} (${theme})`)));
        expect(failing).toEqual([]);
    });

    it('draws state only in PatternFly status tokens', () => {
        expect(STATUS_STYLE.up.icon).toContain('--status--success--');
        expect(STATUS_STYLE.down.icon).toContain('--status--danger--');
        expect(STATUS_STYLE.down.text).toContain('--status--danger--');
        // Not reported up or down is not a fault, so it is not painted as one.
        expect(STATUS_STYLE.unknown.icon).not.toContain('--status--');
    });

    it('gives the ladder a neutral default band and six telling-apart network colours', () => {
        // The slot count is the layout's: changing it would move networks between colours.
        expect(NETWORK_SLOTS).toHaveLength(NETWORK_PALETTE_SIZE);
        expect(hueOf(NETWORK_SLOTS[0].hex).chroma).toBeLessThan(5);
        const others: Color[] = NETWORK_SLOTS.slice(1);
        others.forEach((slot) => expect(hueOf(slot.hex).chroma).toBeGreaterThan(15));
        const similar = others.flatMap((a, i) => others.slice(i + 1)
            .filter((b) => deltaE(a.hex, b.hex) < 10)
            .map((b) => `${a.name} ~ ${b.name}: ΔE ${deltaE(a.hex, b.hex).toFixed(1)}`));
        expect(similar).toEqual([]);
    });
});
