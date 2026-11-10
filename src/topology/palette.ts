/**
 * The graph's colours, in one place (ovn-recon-nt4.1).
 *
 * TWO KINDS OF COLOUR, KEPT APART.
 *
 * - Categorical colours say WHICH: which kind of node, which network. They are drawn
 *   only on graphics -- a card's accent stripe and icon, a band's tint and outline --
 *   never as text, so each needs 3:1 against the card surface in both console themes
 *   (WCAG 1.4.11), not the 4.5:1 that text needs. Text on the graph uses the console's
 *   text tokens, which are built to pass on its own surfaces.
 * - Status colours say HOW IT IS: up, down, a finding. They are PatternFly's status
 *   tokens and nothing else may look like them. The review that started this found a
 *   healthy network drawn in danger red and a NIC whose "down" was a red dot on a
 *   saturated purple block (docs/tasks/PLUGIN_REVIEW_2026-11.md).
 *
 * So the categorical palette avoids the danger, warning, orange and red hues entirely,
 * and keeps a measured distance (CIEDE2000) from every PatternFly status colour,
 * including the purple of `info` and the teal of `custom`. src/designTokens.test.ts
 * enforces all of this against the PatternFly stylesheet, so a colour added here that
 * breaks a rule fails the build rather than a review.
 *
 * Where PatternFly has a palette token for a colour it is used, with its value as the
 * fallback; the test checks the fallback matches the token. PatternFly has no jade,
 * cyan, violet or magenta at a usable lightness, so those four are written as hex.
 */

export interface CategoricalColor {
    /** Short name, for the legend and the PR's colour table. */
    name: string;
    /** What the page writes: a var() with fallback, or a bare hex. */
    css: string;
    /** The PatternFly palette token behind it, when there is one. */
    token?: string;
    /** The resolved value, light and dark alike: categorical colours do not switch theme. */
    hex: string;
}

const fromToken = (name: string, token: string, hex: string): CategoricalColor =>
    ({ name, css: `var(${token}, ${hex})`, token, hex });
const fromHex = (name: string, hex: string): CategoricalColor => ({ name, css: hex, hex });

/**
 * Mid-tones: light enough to show on the dark theme's #292929 card, dark enough to show
 * on the light theme's white one. Measured, not eyeballed -- see designTokens.test.ts.
 */
export const CATEGORICAL = {
    blue: fromToken('blue', '--pf-t--color--blue--40', '#4394e5'),
    cyan: fromHex('cyan', '#1f86a8'),
    jade: fromHex('jade', '#2a9d8f'),
    purple: fromToken('purple', '--pf-t--color--purple--40', '#876fd4'),
    violet: fromHex('violet', '#a64bc4'),
    magenta: fromHex('magenta', '#d1449d'),
    gray: fromToken('gray', '--pf-t--color--gray--45', '#8c8c8c'),
} as const;

export type CategoricalName = keyof typeof CATEGORICAL;

/** Every categorical colour, for the tests and the legend. */
export const CATEGORICAL_COLORS: CategoricalColor[] = Object.values(CATEGORICAL);

/**
 * The surfaces and text the graph draws with. Tokens only, so the console's theme
 * switch reaches the canvas without the page re-rendering.
 */
export const SURFACE = {
    /** A node card or construct card. */
    card: 'var(--pf-t--global--background--color--primary--default)',
    /** The canvas behind the physical graph. */
    canvas: 'var(--pf-t--global--background--color--secondary--default)',
    border: 'var(--pf-t--global--border--color--default)',
    text: 'var(--pf-t--global--text--color--regular)',
    subtleText: 'var(--pf-t--global--text--color--subtle)',
    /** Selection, keyboard focus and the lit flow path: the console's "clicked" blue. */
    selected: 'var(--pf-t--global--border--color--clicked)',
    /** The highlighted flow path. Brand blue, which the dark theme lightens. */
    flow: 'var(--pf-t--global--color--brand--default)',
} as const;

export type NodeStatus = 'up' | 'down' | 'unknown';

/**
 * A node's state, as PatternFly draws status: an icon in a status colour, with the
 * state word beside it in the matching text colour. `unknown` (nmstate's ignore,
 * absent, unknown) is deliberately quiet: it is not a fault, and painting it red is
 * how the old dot turned every ignored tunnel device into an alarm.
 */
export const STATUS_STYLE: Record<NodeStatus, { label: string; icon: string; text: string }> = {
    up: {
        label: 'Up',
        icon: 'var(--pf-t--global--icon--color--status--success--default)',
        text: 'var(--pf-t--global--text--color--subtle)'
    },
    down: {
        label: 'Down',
        icon: 'var(--pf-t--global--icon--color--status--danger--default)',
        text: 'var(--pf-t--global--text--color--status--danger--default)'
    },
    unknown: {
        label: 'Not reported up or down',
        icon: 'var(--pf-t--global--icon--color--subtle)',
        text: 'var(--pf-t--global--text--color--subtle)'
    }
};
