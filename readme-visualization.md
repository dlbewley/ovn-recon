# Node Visualization Summary

> [!WARNING]
> **This document predates the v1.0.2 visualization rework and is stale.**
> The implementation it describes — seven hand-built columns, per-type render
> branches, an unused `nads` prop — no longer exists. The current architecture
> is a descriptor table (`src/topology/descriptors.tsx`) feeding a lane layout
> (`src/topology/lanes.ts`), typed relationship edges
> (`src/components/nodeVisualizationModel.ts`), and a drawer built from facts
> with provenance (`src/topology/registry.ts`). Trust the code and its module
> comments over this page. A rewrite is tracked as ovn-recon-s3t.22 and lands
> with the container-layout rework (ovn-recon-s3t.21).

This document outlines the items represented in the `NodeVisualization` component, including their data sources and the relationships between them.

## Data Sources

The visualization is driven by three main props passed to the component:

1.  **`nns` (NodeNetworkState)**: The primary source for network interface status and OVN configuration on the node.
2.  **`cudns` (ClusterUserDefinedNetwork)**: A list of cluster-wide network definitions.
3.  **`nads` (NetworkAttachmentDefinition)**: *Note: Passed as a prop but currently unused in the visualization logic.*

## Visualized Items (Columns)

The visualization is organized into 7 distinct layers (columns), processed from left to right:

| Layer | Item Type | Source Field | Description |
| :--- | :--- | :--- | :--- |
| **1** | **Physical Interfaces** | `nns.status.currentState.interfaces` | Interfaces with `type: 'ethernet'`. |
| **2** | **Bonds** | `nns.status.currentState.interfaces` | Interfaces with `type: 'bond'`. |
| **3** | **Bridges** | `nns.status.currentState.interfaces` | Interfaces with `type: 'linux-bridge'`, `ovs-bridge`, or `ovs-interface` (if acting as a controller). |
| **4** | **Logical Interfaces** | `nns.status.currentState.interfaces` | `ovs-interface` types that are not bridges. |
| **5** | **OVN Bridge Mappings** | `nns.status.currentState.ovn['bridge-mappings']` | Maps OVN local networks to physical bridges. |
| **6** | **Networks (CUDNs)** | `cudns` prop | Represents the `ClusterUserDefinedNetwork` resources. |
| **7** | **Attachments** | `cudn.status.conditions` | Represents Namespaces attached to a network. Parsed from the `NetworkCreated` condition message in the CUDN status. |

## Relationships (Connectors)

The lines drawn between nodes represent the following relationships:

### 1. Interface Hierarchy (Layer 1-4)
*   **Source**: `interface.controller` or `interface.master`
*   **Target**: The name of another interface.
*   **Meaning**: Represents physical ports belonging to a bond, or interfaces attached to a bridge.

### 2. Bridge to OVN Mapping (Layer 3 -> 5)
*   **Source**: `mapping.bridge` (from OVN bridge mappings)
*   **Target**: The Bridge interface name.
*   **Meaning**: Connects the OVN logical network configuration to the actual OVS/Linux bridge on the node.

### 3. CUDN to OVN Mapping (Layer 6 -> 5)
*   **Source**: `cudn.spec.network.localNet.physicalNetworkName`
*   **Target**: `mapping.localnet` (from OVN bridge mappings)
*   **Meaning**: Links the Cluster User Defined Network to the specific OVN physical network name it uses.

### 4. Attachment to CUDN (Layer 7 -> 6)
*   **Source**: Derived from CUDN status (Namespace name).
*   **Target**: `cudn.metadata.name`
*   **Meaning**: Shows which Namespaces are currently attached to or using a specific Cluster User Defined Network.
