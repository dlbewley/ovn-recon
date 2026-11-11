import {
    centreShift,
    containShift,
    isBoxVisible,
    narrowedViewBox,
    pannedViewBox,
    svgMeetRegion,
    svgMeetScale,
    translateScaleRegion,
    ViewportBox,
} from './canvasViewport';

/** Pure geometry behind the keep-visible rule (ovn-recon-dp7.7). */
describe('canvasViewport geometry', () => {
    const view = { x: 0, y: 0, width: 655, height: 700 };

    it('centres a box in the view', () => {
        expect(centreShift({ x: 900, y: 100, width: 180, height: 64 }, view)).toEqual({ dx: 662.5, dy: -218 });
    });

    it('does not move a box that is already wholly visible', () => {
        const box = { x: 100, y: 100, width: 180, height: 64 };
        expect(containShift(box, view, 16)).toEqual({ dx: 0, dy: 0 });
        expect(isBoxVisible(box, view)).toBe(true);
    });

    it('moves a box past an edge only as far as the margin', () => {
        // Right edge 1050 must come back to 655 - 16.
        expect(containShift({ x: 870, y: 100, width: 180, height: 64 }, view, 16)).toEqual({ dx: 411, dy: 0 });
        // Left of the view: its left edge comes to the margin.
        expect(containShift({ x: -50, y: 100, width: 180, height: 64 }, view, 16)).toEqual({ dx: -66, dy: 0 });
        expect(isBoxVisible({ x: -50, y: 100, width: 180, height: 64 }, view)).toBe(false);
    });

    it('centres a box too big to fit with its margins', () => {
        expect(containShift({ x: 0, y: 0, width: 700, height: 64 }, view, 16).dx).toBeCloseTo(22.5);
    });

    it('maps a translate/scale transform back to the content it shows', () => {
        expect(translateScaleRegion({ x: -200, y: 40 }, 2, { width: 600, height: 400 }))
            .toEqual({ x: 100, y: -20, width: 300, height: 200 });
    });

    it('shows more than the viewBox along the roomier axis of a meet-fitted svg', () => {
        const viewBox = { x: 10, y: 20, width: 1600, height: 800 };
        // Narrow svg: width-limited, the extra room is below.
        expect(svgMeetRegion(viewBox, { width: 800, height: 800 })).toEqual({ x: 10, y: 20, width: 1600, height: 1600 });
        expect(svgMeetScale(viewBox, { width: 800, height: 800 })).toBe(0.5);
        // Wide svg: height-limited, the extra room is to the right.
        expect(svgMeetRegion(viewBox, { width: 2000, height: 400 })).toEqual({ x: 10, y: 20, width: 4000, height: 800 });
        // Not laid out: the viewBox itself.
        expect(svgMeetRegion(viewBox, { width: 0, height: 0 })).toEqual(viewBox);
    });

    it('keeps the scale of a meet-fitted svg the inline drawer narrows (ovn-recon-dp7.10)', () => {
        const viewBox = { x: 40, y: 30, width: 1600, height: 800 };
        const full = { width: 1300, height: 800 };
        const narrowed = { width: 860, height: 800 };
        const drawn = narrowedViewBox(viewBox, narrowed.width, full.width);
        // Same corner and height, cut to the width that is left ...
        expect(drawn).toEqual({ x: 40, y: 30, width: 1600 * 860 / 1300, height: 800 });
        // ... so the screen scale is what the full-width canvas had.
        expect(svgMeetScale(drawn, narrowed)).toBeCloseTo(svgMeetScale(viewBox, full), 10);
        // Drawer closed, or nothing measured yet: unchanged.
        expect(narrowedViewBox(viewBox, 1300, 1300)).toBe(viewBox);
        expect(narrowedViewBox(viewBox, 0, 0)).toBe(viewBox);
    });
});

/**
 * ovn-recon-d0q: a drag of N px moves the content N px on screen, on both axes.
 * Screen position follows the svg "meet" mapping: one scale for both axes, and an
 * alignment offset that depends only on the box size, which a pan does not change.
 */
describe('pannedViewBox', () => {
    const screenOf = (point: { x: number; y: number }, displayed: ViewportBox, size: { width: number; height: number }) => {
        const scale = svgMeetScale(displayed, size);
        const offsetX = (size.width - displayed.width * scale) / 2;
        const offsetY = (size.height - displayed.height * scale) / 2;
        return { x: offsetX + (point.x - displayed.x) * scale, y: offsetY + (point.y - displayed.y) * scale };
    };

    const node = { x: 700, y: 400 };

    it.each([
        // A 1400 px canvas showing about 1650 units of content: width-limited, the case that drifted.
        ['width-limited', { x: 0, y: 0, width: 1650, height: 1000 }, { width: 1400, height: 900 }, 1400],
        // A short, wide canvas: height-limited.
        ['height-limited', { x: 0, y: 0, width: 1650, height: 1000 }, { width: 1600, height: 500 }, 1600],
        // The inline drawer open: the displayed box is narrowed to the canvas that is left.
        ['drawer open', { x: 100, y: 50, width: 1650, height: 1000 }, { width: 1000, height: 900 }, 1400],
    ])('moves a node by the drag on both axes (%s)', (_case, viewBox: ViewportBox, size, fullWidth: number) => {
        const displayedOf = (box: ViewportBox) => narrowedViewBox(box, size.width, fullWidth);
        const before = screenOf(node, displayedOf(viewBox), size);
        const after = screenOf(node, displayedOf(pannedViewBox(viewBox, displayedOf(viewBox), size, 37, -53)), size);
        expect(after.x - before.x).toBeCloseTo(37, 6);
        expect(after.y - before.y).toBeCloseTo(-53, 6);
    });

    it('keeps the size and any other fields of the state it pans', () => {
        const state = { x: 10, y: 20, width: 1650, height: 1000, extra: 'kept' };
        const panned = pannedViewBox(state, state, { width: 1650, height: 1000 }, 5, 5);
        expect(panned).toEqual({ x: 5, y: 15, width: 1650, height: 1000, extra: 'kept' });
    });
});
