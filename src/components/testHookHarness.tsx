import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';

/** Render a hook once and return its result, for hook-only unit tests. */
export const renderHook = <T,>(useHook: () => T): T => {
    let result!: T;
    const Probe: React.FC = () => {
        result = useHook();
        return null;
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    act(() => {
        root.render(<Probe />);
    });
    act(() => root.unmount());
    container.remove();
    return result;
};
