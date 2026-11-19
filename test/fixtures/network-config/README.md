# Network configuration fixtures

`default.json` is the cluster network configuration of a freshly installed OVN-Kubernetes
cluster with nothing changed, as the Network config tab reads it (`cnoConfigModel.ts`).
It was written by hand from the API types (openshift/api `operator/v1` and `config/v1`),
not captured from a cluster; replace it with a sanitised capture when one is taken.
