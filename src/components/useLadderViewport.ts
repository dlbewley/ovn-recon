import * as React from 'react';

import {
    shiftIfNeeded,
    translateScaleRegion,
    useKeepSelectionVisible,
    ViewportBox,
} from './canvasViewport';

/**
 * Pan, zoom and reveal for the two logical ladder pages, which drew the same
 * canvas with the same handlers twice. The canvas shows its content through
 * translate(pan) scale(zoom), origin top-left; reveal and the keep-visible
 * rule come from canvasViewport (ovn-recon-dp7.7).
 */

export interface LadderViewportOptions {
    /** The selected construct's uuid, or null. */
    selectedUuid: string | null;
    /** Smallest zoom the minus button and wheel reach. */
    minZoom: number;
}

const MAX_ZOOM = 2.5;
const step = (value: number, delta: number, minZoom: number) =>
    Math.min(MAX_ZOOM, Math.max(minZoom, Number((value + delta).toFixed(2))));

export const useLadderViewport = ({ selectedUuid, minZoom }: LadderViewportOptions) => {
    const [zoom, setZoom] = React.useState<number>(1);
    const [pan, setPan] = React.useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = React.useState<boolean>(false);
    const lastPointer = React.useRef<{ x: number; y: number } | null>(null);

    const canvas = React.useRef<Element | null>(null);
    const zoomRef = React.useRef(zoom);
    zoomRef.current = zoom;
    const selectedBox = React.useRef<ViewportBox | null>(null);

    const keep = useKeepSelectionVisible({
        selectionKey: selectedUuid,
        getSelectionBox: () => selectedBox.current,
        adjustView: (compute) => {
            const element = canvas.current;
            if (!element) return;
            const { width, height } = element.getBoundingClientRect();
            if (width <= 0 || height <= 0) return;
            setPan((previous) => {
                const scale = zoomRef.current;
                const shift = compute(translateScaleRegion(previous, scale, { width, height }), 1 / scale);
                return shiftIfNeeded(previous, shift, (state, { dx, dy }) => ({
                    x: state.x - dx * scale,
                    y: state.y - dy * scale,
                }));
            });
        },
    });

    const { setCanvas: observeCanvas, reveal, release } = keep;
    const canvasRef = React.useCallback((element: HTMLDivElement | null) => {
        canvas.current = element;
        observeCanvas(element);
    }, [observeCanvas]);

    /** LogicalLadderView answers a reveal request with the card's box. */
    const onRevealBox = React.useCallback((uuid: string, box: ViewportBox) => reveal(uuid, box), [reveal]);
    /** LogicalLadderView reports the selected card's box on every layout. */
    const onSelectedBox = React.useCallback((box: ViewportBox | null) => {
        selectedBox.current = box;
    }, []);

    const zoomIn = () => {
        release();
        setZoom((value) => step(value, 0.1, minZoom));
    };
    const zoomOut = () => {
        release();
        setZoom((value) => step(value, -0.1, minZoom));
    };
    const resetView = React.useCallback(() => {
        release();
        setZoom(1);
        setPan({ x: 0, y: 0 });
    }, [release]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        event.preventDefault();
        if (event.deltaY < 0) zoomIn(); else zoomOut();
    };

    const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
        setIsDragging(true);
        lastPointer.current = { x: event.clientX, y: event.clientY };
    };

    const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
        const from = lastPointer.current;
        if (!isDragging || !from) return;
        const dx = event.clientX - from.x;
        const dy = event.clientY - from.y;
        if (dx === 0 && dy === 0) return;
        release();
        setPan((current) => ({ x: current.x + dx, y: current.y + dy }));
        lastPointer.current = { x: event.clientX, y: event.clientY };
    };

    const handleMouseUp = () => {
        setIsDragging(false);
        lastPointer.current = null;
    };

    return {
        zoom,
        pan,
        zoomIn,
        zoomOut,
        resetView,
        onRevealBox,
        onSelectedBox,
        canvasProps: {
            ref: canvasRef,
            onWheel: handleWheel,
            onMouseDown: handleMouseDown,
            onMouseMove: handleMouseMove,
            onMouseUp: handleMouseUp,
            onMouseLeave: handleMouseUp,
        },
        isDragging,
        contentTransform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
    };
};
