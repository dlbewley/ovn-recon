/**
 * Test-only geometry for the graph canvases (ovn-recon-dp7.7). jsdom lays
 * nothing out, so these helpers stand in for the browser: a controllable
 * ResizeObserver and canvas size, and the screen box of a drawn card worked
 * out from the transforms the page wrote.
 */

import { CONSTRUCT_HEIGHT, CONSTRUCT_WIDTH } from './logicalLadderLayout';
import { ViewportBox } from './canvasViewport';

type Size = { width: number; height: number };

const observers = new Set<{ callback: ResizeObserverCallback; targets: Set<Element> }>();

/**
 * Install a ResizeObserver that fires only when resizeCanvases() is called,
 * the way a browser fires after the drawer opening changes the layout.
 */
export const installFakeResizeObserver = (): (() => void) => {
    const original = (global as { ResizeObserver?: unknown }).ResizeObserver;
    class FakeResizeObserver {
        private readonly entry: { callback: ResizeObserverCallback; targets: Set<Element> };
        constructor(callback: ResizeObserverCallback) {
            this.entry = { callback, targets: new Set() };
            observers.add(this.entry);
        }
        observe(target: Element) { this.entry.targets.add(target); }
        unobserve(target: Element) { this.entry.targets.delete(target); }
        disconnect() { observers.delete(this.entry); }
    }
    (global as { ResizeObserver?: unknown }).ResizeObserver = FakeResizeObserver;
    return () => {
        observers.clear();
        (global as { ResizeObserver?: unknown }).ResizeObserver = original;
    };
};

/** Deliver a resize notification to every observer watching a live element. */
export const resizeCanvases = () => {
    for (const { callback, targets } of [...observers]) {
        if (targets.size === 0) continue;
        callback([...targets].map((target) => ({ target } as ResizeObserverEntry)), {} as ResizeObserver);
    }
};

/** Make element report size from getBoundingClientRect, read on each call. */
export const sizeElement = (element: Element, size: () => Size) => {
    element.getBoundingClientRect = () => {
        const { width, height } = size();
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON: () => ({}) } as DOMRect;
    };
};

const translateOf = (element: Element): { x: number; y: number } => {
    const match = /translate\(\s*(-?[\d.e+-]+)[ ,]+(-?[\d.e+-]+)\s*\)/.exec(element.getAttribute('transform') ?? '');
    return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
};

/** The selected ladder card: the one drawn with the heavy outline. */
export const selectedCard = (root: ParentNode): Element => {
    const card = [...root.querySelectorAll('[data-testid^="construct-"]')]
        .find((candidate) => candidate.querySelector('rect')?.getAttribute('stroke-width') === '3');
    if (!card) throw new Error('no selected card');
    return card;
};

/**
 * A ladder card's box in svg coordinates, summed from the transforms it is
 * drawn under. name is the construct name, or the card element itself where
 * names repeat across zones.
 */
export const drawnCardBoxIn = (root: ParentNode, name: string | Element): ViewportBox => {
    const card = typeof name === 'string' ? root.querySelector(`[data-testid="construct-${name}"]`) : name;
    if (!card) throw new Error(`no card for ${String(name)}`);
    let x = 0;
    let y = 0;
    for (let node: Element | null = card; node && node.tagName.toLowerCase() !== 'svg'; node = node.parentElement) {
        const offset = translateOf(node);
        x += offset.x;
        y += offset.y;
    }
    return { x, y, width: CONSTRUCT_WIDTH, height: CONSTRUCT_HEIGHT };
};

/**
 * Where a ladder card lands on screen, relative to the canvas's top-left:
 * its svg box through the page's translate(pan) scale(zoom) content transform.
 */
export const ladderScreenBox = (root: ParentNode, name: string | Element): ViewportBox => {
    const content = root.querySelector<HTMLElement>('[data-testid="ladder-content"]');
    if (!content) throw new Error('no ladder content');
    const match = /translate\((-?[\d.e+-]+)px,\s*(-?[\d.e+-]+)px\)\s*scale\((-?[\d.e+-]+)\)/.exec(content.style.transform);
    if (!match) throw new Error(`unparsed transform ${content.style.transform}`);
    const [panX, panY, zoom] = [Number(match[1]), Number(match[2]), Number(match[3])];
    const box = drawnCardBoxIn(root, name);
    return { x: panX + box.x * zoom, y: panY + box.y * zoom, width: box.width * zoom, height: box.height * zoom };
};

/** The pan and zoom currently written on the ladder content. */
export const ladderTransform = (root: ParentNode): string =>
    root.querySelector<HTMLElement>('[data-testid="ladder-content"]')?.style.transform ?? '';

/** True when inner lies wholly inside a canvas of the given size. */
export const fitsIn = (inner: ViewportBox, size: Size): boolean =>
    inner.x >= 0 && inner.y >= 0 && inner.x + inner.width <= size.width && inner.y + inner.height <= size.height;
