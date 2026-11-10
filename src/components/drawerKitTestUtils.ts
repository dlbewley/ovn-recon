import { act } from 'react';

/**
 * Opens an InfoPopover from its button and returns the popover body's text
 * (test helper). PatternFly mounts the popover in document.body.
 */
export const openInfoPopover = async (button: HTMLElement): Promise<string> => {
    await act(async () => {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const bodies = [...document.querySelectorAll('.pf-v6-c-popover__body')];
    return bodies[bodies.length - 1]?.textContent ?? '';
};
