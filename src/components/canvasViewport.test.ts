import {
    centreShift,
    containShift,
    isBoxVisible,
    svgMeetRegion,
    svgMeetScale,
    translateScaleRegion,
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
});
