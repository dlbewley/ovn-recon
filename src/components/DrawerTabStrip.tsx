import * as React from 'react';
import { Tab, Tabs, TabTitleText } from '@patternfly/react-core';

export interface DrawerTabStripTab<K extends string = string> {
    id: K;
    title: string;
}

export interface DrawerTabStripProps<K extends string = string> {
    tabs: ReadonlyArray<DrawerTabStripTab<K>>;
    activeKey: K;
    onSelect: (key: K) => void;
    'aria-label'?: string;
}

/**
 * The tab bar of a details drawer, shared by the physical and logical views so
 * the two drawers cannot drift apart again (ovn-recon-mow).
 *
 * It sits directly under DrawerHead, flush with the panel edges: the strip is
 * filled edge to edge and casts a one-pixel shadow over the content below, and
 * only the content is padded. The tabs carry no children -- the caller renders
 * the active body itself, which keeps the strip a fixed header above a body
 * that scrolls.
 */
const DrawerTabStrip = <K extends string = string>({
    tabs,
    activeKey,
    onSelect,
    'aria-label': ariaLabel,
}: DrawerTabStripProps<K>): React.ReactElement => (
    <div
        className="ovn-drawer-tab-strip"
        style={{ flex: '0 0 auto', zIndex: 10, boxShadow: '0 1px 2px 0 rgba(0,0,0,0.1)' }}
    >
        <Tabs
            activeKey={activeKey}
            onSelect={(_event, key) => {
                if (typeof key === 'string') {
                    onSelect(key as K);
                }
            }}
            isFilled
            aria-label={ariaLabel}
        >
            {tabs.map((tab) => (
                <Tab key={tab.id} eventKey={tab.id} title={<TabTitleText>{tab.title}</TabTitleText>} />
            ))}
        </Tabs>
    </div>
);

export default DrawerTabStrip;
