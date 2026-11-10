import * as React from 'react';
import { CheckCircleIcon, ExclamationCircleIcon, UnknownIcon } from '@patternfly/react-icons';

import { NodeStatus, STATUS_STYLE } from './palette';

/**
 * PatternFly's status icons for a node's state: the shape says it as well as the
 * colour, so a down interface reads at a glance and without colour vision
 * (ovn-recon-nt4.1). Shared by the canvas and the legend, so the two cannot differ.
 */
const STATUS_ICONS: Record<NodeStatus, React.ReactNode> = {
    up: <CheckCircleIcon />,
    down: <ExclamationCircleIcon />,
    unknown: <UnknownIcon />
};

export const NodeStatusIcon: React.FC<{ status: NodeStatus }> = ({ status }) => (
    <span
        aria-hidden="true"
        data-status={status}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: STATUS_STYLE[status].icon, fontSize: 12, lineHeight: 1 }}
    >
        {STATUS_ICONS[status]}
    </span>
);
