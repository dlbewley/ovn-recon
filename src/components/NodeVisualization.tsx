import * as React from 'react';
import { Card, CardBody, CardTitle, Popover, Button, DescriptionList, DescriptionListTerm, DescriptionListGroup, DescriptionListDescription } from '@patternfly/react-core';
import { NetworkIcon, ServerIcon, TopologyIcon, CubeIcon } from '@patternfly/react-icons';

interface NodeVisualizationProps {
    nns: any; // NodeNetworkState resource
}

const NodeVisualization: React.FC<NodeVisualizationProps> = ({ nns }) => {
    const interfaces = nns?.status?.currentState?.interfaces || [];

    // Simple layout logic
    const width = 800;
    const height = 600;
    const padding = 50;
    const itemHeight = 80; // Increased height for icon
    const itemWidth = 160;

    // Group interfaces by type for better visualization
    const ethInterfaces = interfaces.filter((iface: any) => iface.type === 'ethernet');
    const bondInterfaces = interfaces.filter((iface: any) => iface.type === 'bond');
    // Include ovs-interface with bridges for now as they are related to OVS
    const bridgeInterfaces = interfaces.filter((iface: any) => ['linux-bridge', 'ovs-bridge', 'ovs-interface'].includes(iface.type));
    const otherInterfaces = interfaces.filter((iface: any) => !['ethernet', 'bond', 'linux-bridge', 'ovs-bridge', 'ovs-interface'].includes(iface.type));

    // Dynamic height calculation
    const maxRows = Math.max(
        ethInterfaces.length,
        bondInterfaces.length,
        bridgeInterfaces.length,
        Math.ceil(otherInterfaces.length / 4) + 2 // +2 for spacing
    );
    const calculatedHeight = Math.max(600, padding + (maxRows * (itemHeight + 20)) + 200);

    const getIcon = (type: string) => {
        switch (type) {
            case 'ethernet': return <ServerIcon />;
            case 'bond': return <TopologyIcon />;
            case 'linux-bridge':
            case 'ovs-bridge':
            case 'ovs-interface': return <CubeIcon />;
            default: return <NetworkIcon />;
        }
    };

    const renderInterfaceNode = (iface: any, x: number, y: number, color: string) => {
        const Icon = getIcon(iface.type);

        const content = (
            <DescriptionList isHorizontal>
                <DescriptionListGroup>
                    <DescriptionListTerm>Type</DescriptionListTerm>
                    <DescriptionListDescription>{iface.type}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>State</DescriptionListTerm>
                    <DescriptionListDescription>{iface.state}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>MAC Address</DescriptionListTerm>
                    <DescriptionListDescription>{iface.mac_address || 'N/A'}</DescriptionListDescription>
                </DescriptionListGroup>
                <DescriptionListGroup>
                    <DescriptionListTerm>MTU</DescriptionListTerm>
                    <DescriptionListDescription>{iface.mtu || 'N/A'}</DescriptionListDescription>
                </DescriptionListGroup>
                {iface.ipv4?.address?.length > 0 && (
                    <DescriptionListGroup>
                        <DescriptionListTerm>IPv4</DescriptionListTerm>
                        <DescriptionListDescription>
                            {iface.ipv4.address.map((addr: any) => <div key={addr.ip}>{addr.ip}/{addr.prefix_length}</div>)}
                        </DescriptionListDescription>
                    </DescriptionListGroup>
                )}
            </DescriptionList>
        );

        return (
            <g transform={`translate(${x}, ${y})`} style={{ cursor: 'pointer' }}>
                <title>{iface.name} ({iface.type})</title>
                <rect width={itemWidth} height={itemHeight} rx={5} fill={color} stroke="#333" strokeWidth={1} />
                <foreignObject x={10} y={10} width={20} height={20}>
                    <div style={{ color: '#fff' }}>{Icon}</div>
                </foreignObject>
                <text x={35} y={25} fontSize="12" fontWeight="bold" fill="#fff">{iface.name}</text>
                <text x={10} y={45} fontSize="10" fill="#eee">{iface.type}</text>
                <text x={10} y={60} fontSize="10" fill="#eee">({iface.state})</text>
                <circle cx={itemWidth - 15} cy={15} r={5} fill={iface.state === 'up' ? '#4CAF50' : '#F44336'} />
            </g>
        );
    };

    if (interfaces.length === 0) {
        return (
            <Card isFullHeight>
                <CardTitle>Network Topology Visualization</CardTitle>
                <CardBody>
                    No interfaces found in NodeNetworkState status.
                </CardBody>
            </Card>
        );
    }

    return (
        <Card isFullHeight>
            <CardTitle>Network Topology Visualization</CardTitle>
            <CardBody>
                <svg width="100%" height={calculatedHeight} viewBox={`0 0 ${width} ${calculatedHeight}`} style={{ border: '1px solid #ccc', background: '#f5f5f5' }}>
                    <defs>
                        <marker id="arrowhead" markerWidth="10" markerHeight="7" refX="0" refY="3.5" orient="auto">
                            <polygon points="0 0, 10 3.5, 0 7" fill="#999" />
                        </marker>
                    </defs>

                    {/* Layer 1: Physical Interfaces (Ethernet) */}
                    <text x={padding} y={padding - 10} fontWeight="bold">Physical Interfaces</text>
                    {ethInterfaces.map((iface: any, index: number) =>
                        renderInterfaceNode(iface, padding, padding + (index * (itemHeight + 20)), '#0066CC')
                    )}

                    {/* Layer 2: Bonds */}
                    <text x={padding + 250} y={padding - 10} fontWeight="bold">Bonds</text>
                    {bondInterfaces.map((iface: any, index: number) =>
                        renderInterfaceNode(iface, padding + 250, padding + (index * (itemHeight + 20)), '#663399')
                    )}

                    {/* Layer 3: Bridges */}
                    <text x={padding + 500} y={padding - 10} fontWeight="bold">Bridges (Linux & OVS)</text>
                    {bridgeInterfaces.map((iface: any, index: number) =>
                        renderInterfaceNode(iface, padding + 500, padding + (index * (itemHeight + 20)), '#FF6600')
                    )}

                    {/* Layer 4: Others */}
                    <text x={padding} y={calculatedHeight - 150} fontWeight="bold">Other Interfaces</text>
                    <g transform={`translate(${padding}, ${calculatedHeight - 140})`}>
                        {otherInterfaces.map((iface: any, index: number) => {
                            const col = index % 4;
                            const row = Math.floor(index / 4);
                            return renderInterfaceNode(iface, col * (itemWidth + 20), row * (itemHeight + 20), '#666');
                        })}
                    </g>
                </svg>
            </CardBody>
        </Card>
    );
};

export default NodeVisualization;
