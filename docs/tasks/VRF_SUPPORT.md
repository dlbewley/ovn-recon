# Task: Support VRF Interfaces and CUDN Linkages

## Status
Implemented

## Context
We need to enhance the Node Network State visualization to support Virtual Routing and Forwarding (VRF) interfaces. These interfaces are created to advertise ClusterUserDefinedNetwork (CUDN) subnets for topologies of Layer2 and Layer3, not Localnet topology.

## Objectives
1.  **Visualize VRF Interfaces**: Display interfaces of type `vrf` as distinct nodes in the graph.
2.  **Represent Topology**: Show the relationship between VRF interfaces and their member interfaces (bonds, vlans, etc.).
3.  **Link to CUDNs**: Connect VRF interfaces to the ClusterUserDefinedNetworks (CUDNs) that utilize them.

## Requirements

### 1. Visualization Components
-   **New Column**: Add a "VRFs" column to the `NodeVisualization` component.
    -   Suggested placement: Below "Bridge Mappings".
-   **Node Appearance**:
    -   Use a distinct icon for VRF nodes (e.g., `RouteIcon` or `InfrastructureIcon`).
    -   Label with the interface name.
    -   Include the name of the ovn port and the route table ID on the node.

### 2. Data Processing
-   **Identification**: Filter interfaces where `type === 'vrf'`.
-   **Membership Logic**:
    -   The VRF interface is created on the node that has the RouteAdvertisement CRD that selects the CUDNs that use the VRF.
    -   The VRF interface name is derived from the RouteAdvertisement CRD name unless it is longer than 15 characters.
-   **CUDN Linkage**:
    -   VRFs are created by virtue of a RouteAdvertisements CRD, and RouteAdvertisements use .spec.networkSelectors[].clusterUserDefinedNetworkSelector to select the CUDNs that use the VRF.
    -   Identify CUDNs that are associated with the VRF and add an edge from the VRF node to the CUDN node.

### 3. User Interface
-   **Details Panel**:
    -   When a VRF node is clicked, show specific details:
        -   Type: VRF
        -   State: Up/Down
        -   Routing Table ID (if available in `raw` data)
        -   Member Interfaces: List of interfaces enslaved to this VRF.
        -   Associated CUDNs: List of CUDNs using this VRF.

## Implementation Details

### Verification Findings (2026-02-04)
The feature has been implemented in `src/components/NodeVisualization.tsx` with the following details:

1.  **Column Layout**:
    -   VRF interfaces are displayed in a **"Layer 3"** column, grouped with OVN Bridge Mappings. This column is positioned between "Logical Interfaces" and "Networks" (CUDNs).
    -   This placement effectively meets the requirement to display them logically "below" or alongside bridge mappings.

2.  **Node Appearance**:
    -   **Icon**: Uses `InfrastructureIcon` (Matches requirements).
    -   **Label**: Uses the VRF interface name.
    -   **Sub-label**: Displays "VRF".

3.  **Logic & Linkages**:
    -   **VRF Identification**: Interfaces with `type === 'vrf'` are correctly filtered.
    -   **CUDN Linkage**: The code correctly identifies the associated `RouteAdvertisements` (RA) by matching the VRF name (handling truncation). It then finds CUDNs selected by that RA (checking topology and label/expression selectors) and draws edges from VRF nodes to CUDN nodes.
    -   **Member Interfaces**: The graph visualizes relationships (edges) from member interfaces (like bonds/ethernets) to the VRF node if `master` is set.

4.  **Details Panel**:
    -   Displays **OVN Port**, **Route Table ID**, and **State**.
    -   Provides a link to the associated **Route Advertisement** resource.
    -   Lists **Matched CUDNs** with links to those resources.
    -   *Note*: The text list of "Member Interfaces" is not explicitly rendered in the details panel, but the relationships are visible in the graph view.

## Implementation Steps
(Completed)

1.  **Update Types**:
    -   Ensure `Interface` type in `src/types.ts` is sufficient (it allows dynamic keys, so likely yes).

2.  **Modify `NodeVisualization.tsx`**:
    -   **Add VRF Type Definition**:
        type NodeKind = ... | 'vrf';
    -   **Add Layout Column**:
        { name: 'Layer 3', data: [...bridgeMappings, ...vrfInterfaces], key: 'l3' }
    -   **Filter Data**:
        const vrfInterfaces = interfaces.filter(iface => iface.type === 'vrf');
    -   **Update Graph Logic**:
        -   Connect `vrf` -> `cudn` (where `cudn...topology in ['Layer2', 'Layer3']`).
    -   **Update Registry**:
        -   Add `'vrf'` to `nodeKindRegistry` with `renderDetails`.

3.  **Verify**:
    -   Test with sample data containing a VRF interface and a CUDN referencing it.
