import * as React from 'react';

/**
 * Keeping the selection visible on a pannable canvas (ovn-recon-dp7.7).
 *
 * The three graph pages render their detail drawer inline, so opening it
 * shrinks the canvas instead of covering half of it. That moves the problem
 * rather than removing it: the canvas is narrower AFTER the selection that
 * opened the drawer, so a reveal computed against the pre-open width centres
 * the target in a region that no longer exists. This module owns the rule
 * all three pages share:
 *
 * - reveal (drawer navigation, a deep link, Enter in the ladder search)
 *   centres the target in the visible canvas and keeps it centred while the
 *   canvas resizes (the drawer opening, the user dragging the splitter),
 *   until the user pans or zooms, or selects something else;
 * - any other selection (a click on the canvas) pans only if the target is
 *   not fully visible, and then only as far as needed, and the same check
 *   runs on every later resize while it stays selected;
 * - closing the drawer leaves the pan and zoom alone.
 *
 * Geometry is in the canvas's own content coordinates. Each page supplies
 * how its view maps to them (a CSS translate/scale on the ladders, an SVG
 * viewBox on the physical page); nothing here scrolls an element.
 */

/** An axis-aligned box: top-left corner and size. */
export interface ViewportBox {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** How far to move the visible region, in content coordinates. */
export interface ViewportShift {
    dx: number;
    dy: number;
}

/** Room kept between a revealed box and the canvas edge, in screen pixels. */
export const REVEAL_MARGIN_PX = 16;

/** The shift that puts the centre of box at the centre of view. */
export const centreShift = (box: ViewportBox, view: ViewportBox): ViewportShift => ({
    dx: box.x + box.width / 2 - (view.x + view.width / 2),
    dy: box.y + box.height / 2 - (view.y + view.height / 2),
});

const containAxis = (start: number, size: number, viewStart: number, viewSize: number, margin: number): number => {
    const low = viewStart + margin;
    const high = viewStart + viewSize - margin;
    // Too big to fit with its margins: centre it, the most of it that can show.
    if (size > high - low) return start + size / 2 - (viewStart + viewSize / 2);
    if (start < low) return start - low;
    if (start + size > high) return start + size - high;
    return 0;
};

/**
 * The smallest shift that brings box fully inside view, inset by margin;
 * zero on an axis where it already is.
 */
export const containShift = (box: ViewportBox, view: ViewportBox, margin = 0): ViewportShift => ({
    dx: containAxis(box.x, box.width, view.x, view.width, margin),
    dy: containAxis(box.y, box.height, view.y, view.height, margin),
});

/** True when box lies wholly inside view. */
export const isBoxVisible = (box: ViewportBox, view: ViewportBox): boolean => {
    const { dx, dy } = containShift(box, view);
    return dx === 0 && dy === 0;
};

/**
 * The region of content a translate(pan) scale(zoom) transform, origin 0 0,
 * shows through a canvas of the given screen size: the ladders' mapping.
 */
export const translateScaleRegion = (
    pan: { x: number; y: number },
    zoom: number,
    size: { width: number; height: number },
): ViewportBox => ({
    x: -pan.x / zoom,
    y: -pan.y / zoom,
    width: size.width / zoom,
    height: size.height / zoom,
});

/**
 * The region of content an <svg preserveAspectRatio="xMinYMin meet"> shows:
 * the viewBox scaled uniformly to fit, anchored top-left, so the axis with
 * spare room shows MORE than the viewBox, not less: the physical page's
 * mapping.
 */
export const svgMeetRegion = (viewBox: ViewportBox, size: { width: number; height: number }): ViewportBox => {
    if (size.width <= 0 || size.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return viewBox;
    const scale = Math.min(size.width / viewBox.width, size.height / viewBox.height);
    return { x: viewBox.x, y: viewBox.y, width: size.width / scale, height: size.height / scale };
};

/** Screen pixels per content unit for that same svg mapping. */
export const svgMeetScale = (viewBox: ViewportBox, size: { width: number; height: number }): number => {
    if (size.width <= 0 || size.height <= 0 || viewBox.width <= 0 || viewBox.height <= 0) return 1;
    return Math.min(size.width / viewBox.width, size.height / viewBox.height);
};

export interface KeepSelectionVisibleOptions {
    /** Identity of the current selection; null when nothing is selected. */
    selectionKey: string | null;
    /** The selection's box in content coordinates, or null when it is not drawn. */
    getSelectionBox: () => ViewportBox | null;
    /**
     * Move the view. compute receives the region visible right now (built
     * from the page's latest view state, inside a state updater, so two
     * adjustments in one tick compose) and the content units per screen
     * pixel, and returns the shift; a zero shift must leave the state as it
     * is so an already-visible selection never moves.
     */
    adjustView: (compute: (region: ViewportBox, unitsPerPixel: number) => ViewportShift) => void;
}

export interface KeepSelectionVisible {
    /** Callback ref for the canvas element whose size bounds the view. */
    setCanvas: (element: Element | null) => void;
    /** Centre box (the selection keyed key) now, and on each resize until released. */
    reveal: (key: string, box: ViewportBox) => void;
    /** The user panned or zoomed: stop re-centring, keep only the visibility check. */
    release: () => void;
}

const isZero = (shift: ViewportShift) => shift.dx === 0 && shift.dy === 0;

/**
 * Shared reveal behaviour for the three graph pages; see the module comment.
 * Resizes are observed with ResizeObserver; where it is missing (jsdom) the
 * immediate reveal and click checks still run.
 */
export const useKeepSelectionVisible = ({
    selectionKey,
    getSelectionBox,
    adjustView,
}: KeepSelectionVisibleOptions): KeepSelectionVisible => {
    const [canvas, setCanvas] = React.useState<Element | null>(null);
    // The selection a reveal centred; re-centred on resize while it stays selected.
    const pinned = React.useRef<string | null>(null);
    const latest = React.useRef({ selectionKey, getSelectionBox, adjustView });
    latest.current = { selectionKey, getSelectionBox, adjustView };

    const centre = (box: ViewportBox) =>
        latest.current.adjustView((region) => centreShift(box, region));
    const contain = (box: ViewportBox) =>
        latest.current.adjustView((region, unitsPerPixel) =>
            containShift(box, region, REVEAL_MARGIN_PX * unitsPerPixel));

    const reveal = React.useCallback((key: string, box: ViewportBox) => {
        pinned.current = key;
        centre(box);
    }, []);

    const release = React.useCallback(() => {
        pinned.current = null;
    }, []);

    // A new selection that no reveal claimed (a canvas click): show it whole.
    // Child effects run first, so a reveal for this same selection has
    // already pinned it by the time this runs.
    React.useEffect(() => {
        if (pinned.current !== selectionKey) pinned.current = null;
        if (selectionKey === null || pinned.current === selectionKey) return;
        const box = latest.current.getSelectionBox();
        if (box) contain(box);
    }, [selectionKey]);

    React.useEffect(() => {
        if (!canvas || typeof ResizeObserver === 'undefined') return undefined;
        let last: { width: number; height: number } | null = null;
        const observer = new ResizeObserver(() => {
            const { width, height } = canvas.getBoundingClientRect();
            if (last && last.width === width && last.height === height) return;
            last = { width, height };
            const key = latest.current.selectionKey;
            if (key === null) {
                pinned.current = null;
                return;
            }
            const box = latest.current.getSelectionBox();
            if (!box) return;
            if (pinned.current === key) centre(box); else contain(box);
        });
        observer.observe(canvas);
        return () => observer.disconnect();
    }, [canvas]);

    return { setCanvas, reveal, release };
};

/** Helper for adjustView implementations: apply a shift only when it is non-zero. */
export const shiftIfNeeded = <T,>(state: T, shift: ViewportShift, apply: (state: T, shift: ViewportShift) => T): T =>
    (isZero(shift) ? state : apply(state, shift));
