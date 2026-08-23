import * as React from 'react';
import {
    InfrastructureIcon, LinuxIcon, MigrationIcon, NetworkIcon, PficonVcenterIcon,
    PluggedIcon, ResourcePoolIcon, RouteIcon, TagIcon
} from '@patternfly/react-icons';

/**
 * Icon per node type. Keyed on the render type string rather than on NodeKind,
 * because interface kinds are distinguished here by their nmstate type.
 * ovn-recon-s3t.9 moves this onto the per-kind descriptor alongside the colour.
 */
export const getIcon = (type: string) => {
    switch (type) {
        case 'ethernet': return <ResourcePoolIcon />;
        case 'bond': return <PficonVcenterIcon />;
        case 'linux-bridge': return <LinuxIcon />;
        case 'ovs-bridge': return <InfrastructureIcon />;
        case 'ovs-interface': return <NetworkIcon />; // Logical
        case 'ovn-mapping': return <RouteIcon />;
        case 'vrf': return <InfrastructureIcon />;
        case 'cudn': return <NetworkIcon />;
        case 'udn': return <NetworkIcon />;
        case 'attachment': return <MigrationIcon />;
        case 'vlan': return <TagIcon />;
        case 'mac-vlan': return <TagIcon />;
        case 'nad': return <RouteIcon />;
        case 'lldp-neighbor': return <PluggedIcon />;
        default: return <NetworkIcon />;
    }
};
