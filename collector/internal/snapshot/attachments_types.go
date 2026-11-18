package snapshot

import (
	"sort"
	"strings"
)

// AttachmentsSchemaVersion is metadata.schemaVersion on GET /api/v1/attachments
// (collector/api/network-attachments.schema.json), versioned apart from the
// snapshot payloads.
const AttachmentsSchemaVersion = "1"

const (
	portExternalIDPod       = "pod"
	portExternalIDNamespace = "namespace"
	portExternalIDNAD       = "k8s.ovn.org/nad"
	virtLauncherPodPrefix   = "virt-launcher-"
)

// NetworkAttachments counts the pods on each user-defined OVN network, per node
// (ovn-recon-nfs.4). It comes from the Logical_Switch_Port rows the collector
// already holds, so the plugin's network page needs no pod watch for these
// networks. It carries counts and no pod names.
type NetworkAttachments struct {
	Metadata ClusterMetadata `json:"metadata"`
	// Zones names the nodes whose live data was counted, sorted. A node missing
	// here is unknown, not zero: its zone failed or served fixture data.
	Zones []string `json:"zones"`
	// Networks has one entry per NAD with an attached pod, sorted by NAD.
	Networks []AttachedNetwork `json:"networks"`
	// Warnings are the aggregate's own (ZONE_COLLECTION_FAILED).
	Warnings []Warning `json:"warnings"`
}

// AttachedNetwork is one NetworkAttachmentDefinition's attachments.
type AttachedNetwork struct {
	// NAD is namespace/name, from the port's k8s.ovn.org/nad external ID.
	NAD string `json:"nad"`
	// Nodes has one entry per node with an attachment, sorted by node.
	Nodes []AttachedNode `json:"nodes"`
}

// AttachedNode is what one node has attached to a network. A pod with several
// ports on the network counts once.
type AttachedNode struct {
	NodeName string `json:"nodeName"`
	// Pods excludes the pods counted in VirtLaunchers.
	Pods int `json:"pods"`
	// VirtLaunchers counts pods named as KubeVirt names its launcher pods.
	VirtLaunchers int `json:"virtLaunchers"`
}

// attachedPod is the pod a Logical_Switch_Port belongs to, and the NAD it is on.
// It reports false for any port that is not a local pod's port on a
// user-defined network: the default network's ports carry no NAD, and a remote
// port is counted in the zone of the node that hosts the pod.
func attachedPod(port LogicalSwitchPortRow) (nad, pod string, ok bool) {
	if port.Type != "" || port.ExternalIDs[portExternalIDPod] != "true" {
		return "", "", false
	}
	nad = port.ExternalIDs[portExternalIDNAD]
	namespace := port.ExternalIDs[portExternalIDNamespace]
	if nad == "" || namespace == "" {
		return "", "", false
	}
	// Ports are named [<network>_]<namespace>_<pod>. Kubernetes names hold no
	// underscore, so the pod is what follows the last one.
	name := port.Name[strings.LastIndex(port.Name, "_")+1:]
	if name == "" {
		return "", "", false
	}
	return nad, namespace + "/" + name, true
}

// CountAttachments counts the attached pods of the zones that hold live data,
// and names those zones. A degraded zone is left out, because what it serves is
// sample data that says nothing about this cluster.
func CountAttachments(zones []LogicalTopologySnapshot) (counted []string, networks []AttachedNetwork) {
	counted = []string{}
	networks = []AttachedNetwork{}
	pods := map[string]map[string]map[string]bool{}
	for _, zone := range zones {
		health := zone.Metadata.SourceHealth
		if zone.Database == nil || (health != "" && health != SourceHealthy) {
			continue
		}
		node := zone.Metadata.NodeName
		counted = append(counted, node)
		for _, port := range zone.Database.LogicalSwitchPorts {
			nad, pod, ok := attachedPod(port)
			if !ok {
				continue
			}
			if pods[nad] == nil {
				pods[nad] = map[string]map[string]bool{}
			}
			if pods[nad][node] == nil {
				pods[nad][node] = map[string]bool{}
			}
			pods[nad][node][pod] = true
		}
	}
	sort.Strings(counted)

	for nad, byNode := range pods {
		network := AttachedNetwork{NAD: nad, Nodes: make([]AttachedNode, 0, len(byNode))}
		for node, names := range byNode {
			entry := AttachedNode{NodeName: node}
			for pod := range names {
				if strings.HasPrefix(pod[strings.Index(pod, "/")+1:], virtLauncherPodPrefix) {
					entry.VirtLaunchers++
				} else {
					entry.Pods++
				}
			}
			network.Nodes = append(network.Nodes, entry)
		}
		sort.Slice(network.Nodes, func(a, b int) bool { return network.Nodes[a].NodeName < network.Nodes[b].NodeName })
		networks = append(networks, network)
	}
	sort.Slice(networks, func(a, b int) bool { return networks[a].NAD < networks[b].NAD })
	return counted, networks
}
