[![CI Status](https://github.com/dlbewley/ovn-recon/actions/workflows/build-test.yaml/badge.svg)](https://github.com/dlbewley/ovn-recon/actions/workflows/build-test.yaml)
![Built with AI](https://img.shields.io/badge/Built%20with-AI-blueviolet?style=plastic)
[![Image Repository on Quay](https://img.shields.io/badge/Image%20on-Quay.io-blue?style=plastic "Image Repository on Quay")](https://quay.io/repository/dbewley/ovn-recon)
[![Helm Chart on GHCR](https://img.shields.io/badge/Chart%20on-ghcr.io-green?style=plastic "Chart on GHCR")](https://github.com/dlbewley/ovn-recon/pkgs/container/charts%2Fovn-recon)

# Open Virtual Network Reconnaissance (OVN Recon)

<div align="left">
<a href="img/logo-full.png"><img src="img/logo-800.png" width="50%" align="left"/></a>
</div>
<div align="right">
<p align="center"><b>Screenshots</b></p>
<a href="img/nns-visualization.png"><img src="img/nns-visualization.png" width="25%" /></a>
<a href="img/nns-visualization-2.png"><img src="img/nns-visualization-2.png" width="25%" /></a>
<a href="img/nns-visualization-3.png"><img src="img/nns-visualization-3.png" width="25%" /></a>
</div>

<br clear="all"/>

**Open Virtual Network Reconnaissance (OVN Recon) is an OpenShift Console Plugin that provides a visualization of the Virtual and Node Network State in an OpenShift cluster.**

## Kubernetes Resource Dependencies

OVN Recon visualizes the following Kubernetes Custom Resources:

- **NodeNetworkState (NNS)** - Represents the current network configuration of a node, including interfaces, bridges, and OVN bridge mappings. Provided by the [nmstate operator](https://nmstate.io/).
- **NodeNetworkConfigurationPolicy (NNCP)** - Defines desired network configuration for nodes. Used to configure OVN bridge mappings and physical network interfaces.
- **ClusterUserDefinedNetwork (CUDN)** - Defines overlay networks that can be attached to pods. Part of OpenShift's [OVN-Kubernetes secondary networks](https://docs.openshift.com/container-platform/latest/networking/ovn_kubernetes_network_provider/about-ovn-kubernetes.html).
- **NetworkAttachmentDefinition (NAD)** - Multus CNI resource that references a CUDN and allows pods to attach to secondary networks.

The plugin watches these resources in real-time and renders an interactive topology showing how physical interfaces, bridges, and virtual networks are connected.

## Architecture & Concepts

TODO

## How to Build

For detailed build and developer deployment instructions, please see [docs/BUILDING.md](docs/BUILDING.md).

## Installation

### Helm Deployment

Deploy using Helm from the OCI registry:

```bash
helm install ovn-recon oci://ghcr.io/dlbewley/charts/ovn-recon \
  --version 0.1.1 \
  --namespace ovn-recon \
  --create-namespace
```

Or from the local chart:

```bash
helm install ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon \
  --create-namespace
```

To customize the deployment, create a `values.yaml` file:

```yaml
image:
  repository: quay.io/dbewley/ovn-recon
  tag: "v0.0.2"

consolePlugin:
  displayName: "OVN Recon"
```

Then install with your custom values:

```bash
helm install ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon \
  --create-namespace \
  --values values.yaml
```

To upgrade an existing deployment:

```bash
helm upgrade ovn-recon ./charts/ovn-recon \
  --namespace ovn-recon
```

### Enable the Plugin

Patch the Console Operator config to enable the plugin. Use a JSON patch to append to the list of plugins instead of replacing it:

```bash
oc patch console.operator.openshift.io cluster --type=json \
    --patch '[{"op": "add", "path": "/spec/plugins/-", "value": "ovn-recon"}]'
```

The OpenShift console will reload to apply the changes. You should see a notification that the console has been updated.

## Troubleshooting

For troubleshooting steps, please see [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

## References

-   [OpenShift Console Dynamic Plugin SDK](https://github.com/openshift/console/tree/master/frontend/packages/console-dynamic-plugin-sdk)
-   [Dynamic Plugin SDK README](https://www.npmjs.com/package/@openshift-console/dynamic-plugin-sdk)
-   [PatternFly React Documentation](https://www.patternfly.org/v4/components)
-   [OpenShift Console GitHub Repository](https://github.com/openshift/console)
- [Example ocp-console-plugin](https://github.com/dlbewley/ocp-console-plugin)
