import * as React from 'react';
import { useNavigate } from 'react-router';
import { Badge, Tab, Tabs, TabTitleText } from '@patternfly/react-core';

/**
 * A scope's tabs in the explorer (ovn-recon-gbr.4, gbr.5), each a link to its own
 * URL: the tab is in the address bar, Back returns to it, and a middle click or a
 * modified click opens it in a new browser tab. A plain click navigates in place.
 */

export interface ScopeTab {
    key: string;
    title: string;
    path: string;
    /** Drawn as a badge after the title once known. */
    count?: number;
}

/** A plain click: anything else (a new tab or window) is left to the browser. */
const isPlainClick = (event: React.MouseEvent | React.KeyboardEvent | MouseEvent): boolean => {
    const { button, metaKey, ctrlKey, shiftKey, altKey } = event as MouseEvent;
    return !(metaKey || ctrlKey || shiftKey || altKey) && (button === undefined || button === 0);
};

const ScopeTabs: React.FC<{
    tabs: ScopeTab[];
    /** The tab on screen; null for a view with no tab of its own. */
    active: string | null;
    'aria-label': string;
    /** Prefix of each tab's test id: `<prefix>-<key>`, and `<prefix>s` on the tab list. */
    testIdPrefix: string;
}> = ({ tabs, active, 'aria-label': ariaLabel, testIdPrefix }) => {
    const navigate = useNavigate();
    return (
        <Tabs
            activeKey={active ?? ''}
            aria-label={ariaLabel}
            component="nav"
            data-testid={`${testIdPrefix}s`}
            onSelect={(event, key) => {
                const target = tabs.find((candidate) => candidate.key === key);
                if (!target || !isPlainClick(event)) return;
                event.preventDefault();
                if (key !== active) navigate(target.path);
            }}
        >
            {tabs.map(({ key, title, path, count }) => (
                <Tab
                    key={key}
                    eventKey={key}
                    href={path}
                    data-testid={`${testIdPrefix}-${key}`}
                    title={(
                        <TabTitleText>
                            {title}
                            {count !== undefined && (
                                <Badge isRead style={{ marginInlineStart: 'var(--pf-t--global--spacer--sm)' }}>{count}</Badge>
                            )}
                        </TabTitleText>
                    )}
                />
            ))}
        </Tabs>
    );
};

export default ScopeTabs;
