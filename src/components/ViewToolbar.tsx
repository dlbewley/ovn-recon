import * as React from 'react';
import {
    Badge,
    Button,
    Dropdown,
    DropdownItem,
    DropdownList,
    MenuToggle,
    Select,
    SelectList,
    SelectOption,
    Toolbar,
    ToolbarContent,
    ToolbarGroup,
    ToolbarItem,
    Tooltip,
} from '@patternfly/react-core';
import {
    EllipsisVIcon,
    ExpandIcon,
    SearchMinusIcon,
    SearchPlusIcon,
    SyncAltIcon,
} from '@patternfly/react-icons';

import { LegendButton } from './GraphLegend';
import { SnapshotJsonModal, SnapshotJsonProps } from './SnapshotJsonModal';

/**
 * One toolbar for the three graph views (ovn-recon-nt4.3): the physical graph
 * (`NodeVisualization`), a node's logical ladder and the cluster's. Each passes its own
 * items; the order is fixed, left to right, which is also the keyboard order:
 *
 *   filters (search, selects) · View options · zoom out, zoom in, reset · Legend ·
 *   and at the end, as one group: the freshness status line · refresh · more actions
 *   (View JSON).
 *
 * The end group wraps as a whole, so the freshness line stays beside the button that
 * refreshes it on a narrow view.
 *
 * Display toggles live in the "View options" menu as checkboxes, so the row stays one
 * line at the explorer's width. Zoom and refresh are icon buttons with tooltips and
 * accessible names.
 */

export interface ViewOption {
    /** Kept as the option's id, so a test or a label can find it. */
    id: string;
    label: string;
    checked: boolean;
    onChange: (checked: boolean) => void;
    description?: string;
}

export interface ViewToolbarProps {
    /** A name for the toolbar, read by screen readers ("Physical topology view"). */
    label: string;
    /** Search and filters, first in the row. */
    filters?: React.ReactNode;
    /** Display toggles; the menu is left out when there are none. */
    viewOptions?: ViewOption[];
    zoom: {
        onZoomOut: () => void;
        onZoomIn: () => void;
        onReset: () => void;
    };
    /** The legend's content, behind a "Legend" button. */
    legend: React.ReactNode;
    refresh?: {
        onRefresh: () => void;
        isLoading?: boolean;
    };
    /** The raw payload, offered as "View JSON" in the overflow menu. */
    json?: SnapshotJsonProps;
    /** The freshness status line, at the end of the row beside refresh. */
    status?: React.ReactNode;
}

const IconButton: React.FC<{ label: string; icon: React.ReactNode; onClick: () => void; isDisabled?: boolean }> = ({
    label,
    icon,
    onClick,
    isDisabled,
}) => (
    <Tooltip content={label}>
        <Button variant="plain" aria-label={label} icon={icon} onClick={onClick} isDisabled={isDisabled} />
    </Tooltip>
);

const ViewOptionsMenu: React.FC<{ options: ViewOption[] }> = ({ options }) => {
    const [open, setOpen] = React.useState(false);
    const byId = new Map(options.map((option) => [option.id, option]));
    const checkedCount = options.filter((option) => option.checked).length;
    return (
        <Select
            role="menu"
            isOpen={open}
            onOpenChange={setOpen}
            onSelect={(_event, value) => {
                const option = byId.get(String(value));
                if (option) option.onChange(!option.checked);
            }}
            toggle={(ref) => (
                <MenuToggle
                    ref={ref}
                    isExpanded={open}
                    onClick={() => setOpen((value) => !value)}
                    badge={checkedCount > 0 ? <Badge isRead screenReaderText="on">{checkedCount}</Badge> : undefined}
                    data-testid="view-options-toggle"
                >
                    View options
                </MenuToggle>
            )}
        >
            <SelectList aria-label="View options">
                {options.map((option) => (
                    <SelectOption
                        key={option.id}
                        id={option.id}
                        value={option.id}
                        hasCheckbox
                        isSelected={option.checked}
                        description={option.description}
                    >
                        {option.label}
                    </SelectOption>
                ))}
            </SelectList>
        </Select>
    );
};

const MoreActions: React.FC<{ json: SnapshotJsonProps }> = ({ json }) => {
    const [open, setOpen] = React.useState(false);
    const [jsonOpen, setJsonOpen] = React.useState(false);
    const toggleRef = React.useRef<HTMLButtonElement>(null);
    // The menu item that opened the modal is gone by the time it closes; focus goes
    // back to the menu's toggle rather than to the page.
    const closeJson = () => {
        setJsonOpen(false);
        setTimeout(() => toggleRef.current?.focus(), 0);
    };
    return (
        <>
            <Dropdown
                isOpen={open}
                onOpenChange={setOpen}
                onSelect={() => setOpen(false)}
                popperProps={{ position: 'right' }}
                toggle={{
                    toggleRef,
                    toggleNode: (
                        <MenuToggle
                            ref={toggleRef}
                            variant="plain"
                            isExpanded={open}
                            onClick={() => setOpen((value) => !value)}
                            aria-label="More actions"
                            icon={<EllipsisVIcon />}
                            data-testid="view-more-actions"
                        />
                    ),
                }}
            >
                <DropdownList>
                    <DropdownItem key="json" onClick={() => setJsonOpen(true)}>
                        View JSON
                    </DropdownItem>
                </DropdownList>
            </Dropdown>
            <SnapshotJsonModal {...json} isOpen={jsonOpen} onClose={closeJson} />
        </>
    );
};

const ViewToolbar: React.FC<ViewToolbarProps> = ({
    label,
    filters,
    viewOptions,
    zoom,
    legend,
    refresh,
    json,
    status,
}) => (
    <Toolbar aria-label={label} data-testid="view-toolbar" inset={{ default: 'insetNone' }}>
        <ToolbarContent alignItems="center">
            {filters && <ToolbarGroup variant="filter-group">{filters}</ToolbarGroup>}
            {viewOptions && viewOptions.length > 0 && (
                <ToolbarItem>
                    <ViewOptionsMenu options={viewOptions} />
                </ToolbarItem>
            )}
            <ToolbarGroup variant="action-group-plain" gap={{ default: 'gapNone' }}>
                <ToolbarItem>
                    <IconButton label="Zoom out" icon={<SearchMinusIcon />} onClick={zoom.onZoomOut} />
                </ToolbarItem>
                <ToolbarItem>
                    <IconButton label="Zoom in" icon={<SearchPlusIcon />} onClick={zoom.onZoomIn} />
                </ToolbarItem>
                <ToolbarItem>
                    <IconButton label="Reset view" icon={<ExpandIcon />} onClick={zoom.onReset} />
                </ToolbarItem>
            </ToolbarGroup>
            <ToolbarItem>
                <LegendButton>{legend}</LegendButton>
            </ToolbarItem>
            {(status || refresh || json) && (
                // At the end, and wrapping as one: the freshness line beside the
                // button that refreshes it.
                <ToolbarGroup
                    variant="action-group-plain"
                    align={{ default: 'alignEnd' }}
                    gap={{ default: 'gapNone' }}
                    alignItems="center"
                >
                    {status && <ToolbarItem style={{ marginInlineEnd: 'var(--pf-t--global--spacer--sm)' }}>{status}</ToolbarItem>}
                    {refresh && (
                        <ToolbarItem>
                            <IconButton
                                label="Refresh now"
                                icon={<SyncAltIcon />}
                                onClick={refresh.onRefresh}
                                isDisabled={refresh.isLoading}
                            />
                        </ToolbarItem>
                    )}
                    {json && (
                        <ToolbarItem>
                            <MoreActions json={json} />
                        </ToolbarItem>
                    )}
                </ToolbarGroup>
            )}
        </ToolbarContent>
    </Toolbar>
);

export default ViewToolbar;
