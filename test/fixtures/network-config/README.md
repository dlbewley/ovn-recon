# Network configuration fixtures

Inputs of the Network config tab's model (`cnoConfigModel.ts`, `cnoAppliedModel.ts`).

- `default.json` is the cluster network configuration of a freshly installed OVN-Kubernetes
  cluster with nothing changed. It was written by hand from the API types (openshift/api
  `operator/v1` and `config/v1`), and the tests use it as the "nothing changed" baseline.
- `ocp-4.22-capture.json` is a sanitised capture of a real OpenShift 4.22 cluster
  (ovn-recon-n7r.5), taken read-only with `oc get ... -o json`: the operator and config
  `Network` named `cluster`, ClusterOperator `network`, FeatureGate and Infrastructure
  `cluster`, the ConfigMaps `applied-cluster` and `mtu` in `openshift-network-operator`
  (`ovn-kubernetes-config-overrides` and `gateway-mode-config` were absent), and the
  cluster's RouteAdvertisements. That cluster runs local gateway mode with FRR, route
  advertisements, IP forwarding Global and MultiNetworkPolicy on.

Sanitising removed `managedFields`, UIDs, resource versions, creation timestamps and
annotations; set every condition's `lastTransitionTime` to one fixed time; kept only the
two newest FeatureGate entries; replaced the Infrastructure's name, API URLs and
addresses with `example.com` and 192.0.2.0/24 (TEST-NET-1); and renamed the
RouteAdvertisements and their label selectors. The cluster and service networks, MTUs
and ports left in are the platform defaults. Re-sanitise any new capture the same way
before it is committed, and check it for host names, node names and real addresses.
