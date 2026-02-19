# Operator Event Reason Catalog

This document defines the current `reason` values emitted by the `ovn-recon` operator and the compatibility policy for reason changes.

## Scope

- Applies to Kubernetes Events emitted by the operator controller.
- Applies to status condition `reason` fields set on `OvnRecon`.
- Covers behavior in the current `v1beta1` operator line.

## Current Reason Catalog

| Reason | Event Type | Typical Condition Type | Meaning |
|---|---|---|---|
| `NotPrimary` | `Warning` | `Available`, `PluginEnabled` | Reconcile skipped because another `OvnRecon` instance is primary. |
| `NamespaceNotFound` | `Warning` | `NamespaceReady` | Target namespace is missing or not readable. |
| `NamespaceFound` | `Normal` | `NamespaceReady` | Target namespace exists and is usable. |
| `DeploymentReconcileFailed` | `Warning` | `Available` | Plugin backend Deployment reconcile failed. |
| `ServiceReconcileFailed` | `Warning` | `ServiceReady` | Plugin Service reconcile failed. |
| `ServiceReady` | `Normal` | `ServiceReady` | Plugin Service reconcile succeeded. |
| `CollectorRBACReconcileFailed` | `Warning` | `CollectorReady` | Collector RBAC reconcile failed. |
| `CollectorDeploymentReconcileFailed` | `Warning` | `CollectorReady` | Collector Deployment reconcile failed. |
| `CollectorServiceReconcileFailed` | `Warning` | `CollectorReady` | Collector Service reconcile failed. |
| `CollectorReady` | `Normal` | `CollectorReady` | Collector resources are reconciled and ready. |
| `CollectorFeatureDisabled` | `Normal` | `CollectorReady` | Collector feature is disabled and collector resources are not active. |
| `ConsolePluginReconcileFailed` | `Warning` | `ConsolePluginReady` | ConsolePlugin reconcile failed. |
| `ConsolePluginReady` | `Normal` | `ConsolePluginReady` | ConsolePlugin reconcile succeeded. |
| `DeploymentReady` | `Normal` | `Available` | Plugin Deployment reports ready replicas. |
| `DeploymentNotReady` | `Normal` | `Available` | Plugin Deployment exists but is not ready yet. |
| `ConsoleOperatorUpdateFailed` | `Warning` | `PluginEnabled` | Console operator patch/update failed. |
| `PluginEnabled` | `Normal` | `PluginEnabled` | Plugin is enabled in console operator config/status. |
| `PluginEnabling` | `Normal` | `PluginEnabled` | Plugin enablement has been requested and is in progress. |
| `PluginDisabled` | `Normal` | `PluginEnabled` | Plugin enablement is disabled by spec. |

## Compatibility Policy

We attempt event reason stability within each minor release line.

- Allowed without compatibility warning:
  - adding new reasons
  - adding new call sites for existing reasons
- Requires explicit compatibility handling:
  - renaming an existing reason
  - removing an existing reason
  - changing semantics of an existing reason in a way that breaks automation

## Release Note Requirements For Reason Changes

Any non-additive reason change must include:

1. A release note entry listing old and new reason values.
2. A migration note describing any alert or automation updates needed.
3. A code/test update to the reason catalog regression check:
   - `/Users/dale/src/ovn-recon/operator/internal/controller/reason_catalog_test.go`

When practical, provide a short compatibility window by emitting the old and new reason in adjacent releases or by documenting an equivalent mapping.
