# Troubleshooting Playbooks

## Baseline Variables

```bash
export APP_NAME='ovn-recon'
export APP_NAMESPACE='ovn-recon'
export APP_SELECTOR="app.kubernetes.io/name=$APP_NAME"
export OPERATOR_NAMESPACE='ovn-recon-operator-system'
```

## Quick Triage

```bash
oc get ovnrecon "$APP_NAME" -o yaml
oc get pods -n "$APP_NAMESPACE" -l "$APP_SELECTOR"
oc get pods -n "$APP_NAMESPACE" -l app.kubernetes.io/component=collector
oc get consoleplugin "$APP_NAME" -o yaml
```

## Event Queries

Operator Warning events are always emitted. Normal events are transition-driven and deduped.

```bash
oc get events -A \
  --field-selector involvedObject.kind=OvnRecon,involvedObject.name="$APP_NAME" \
  --sort-by='.lastTimestamp'
```

```bash
oc get events -A \
  --field-selector involvedObject.kind=OvnRecon,involvedObject.name="$APP_NAME",type=Warning \
  --sort-by='.lastTimestamp'
```

```bash
oc get events -A \
  --field-selector involvedObject.kind=OvnRecon,involvedObject.name="$APP_NAME",reason=CollectorRBACReconcileFailed
```

Reason meanings and compatibility policy are documented in `/Users/dale/src/ovn-recon/docs/EVENT_REASON_CATALOG.md`.

## Logging Profiles

### Normal (production-safe)

```bash
oc patch ovnrecon "$APP_NAME" --type=merge -p '{
  "spec": {
    "operator": {
      "logging": {
        "level": "info",
        "events": {
          "minType": "Normal",
          "dedupeWindow": "5m"
        }
      }
    },
    "consolePlugin": {
      "logging": {
        "level": "info",
        "accessLog": {
          "enabled": false
        }
      }
    },
    "collector": {
      "logging": {
        "level": "info",
        "includeProbeOutput": false
      }
    }
  }
}'
```

### High-verbosity debug

```bash
oc patch ovnrecon "$APP_NAME" --type=merge -p '{
  "spec": {
    "operator": {
      "logging": {
        "level": "debug",
        "events": {
          "minType": "Normal",
          "dedupeWindow": "30s"
        }
      }
    },
    "consolePlugin": {
      "logging": {
        "level": "debug",
        "accessLog": {
          "enabled": true
        }
      }
    },
    "collector": {
      "logging": {
        "level": "trace",
        "includeProbeOutput": true
      }
    }
  }
}'
```

`includeProbeOutput=true` logs raw command output and is not truncated. Treat as sensitive/high-volume and disable after debugging.

## Playbook: Operator Reconcile Failures

1. Check CR conditions:
```bash
oc get ovnrecon "$APP_NAME" -o jsonpath='{range .status.conditions[*]}{.type}{"\t"}{.status}{"\t"}{.reason}{"\t"}{.message}{"\n"}{end}'
```

2. Check operator logs:
```bash
oc logs -n "$OPERATOR_NAMESPACE" deployment/ovn-recon-operator-controller-manager --since=15m
```

3. Correlate by `reconcileID` and `phase` in logs to identify failing reconciliation steps.

## Playbook: Collector Problems

1. Verify collector deployment and env:
```bash
oc get deploy "${APP_NAME}-collector" -n "$APP_NAMESPACE" -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}'
```

2. Check collector logs:
```bash
oc logs -n "$APP_NAMESPACE" deployment/"${APP_NAME}-collector" --since=15m
```

3. If warnings indicate probe/parse issues, temporarily use high-verbosity mode and re-check logs/events.

## Playbook: Console Plugin (nginx) Problems

1. Verify plugin pod and logging env:
```bash
oc get deploy "$APP_NAME" -n "$APP_NAMESPACE" -o jsonpath='{range .spec.template.spec.containers[0].env[*]}{.name}={.value}{"\n"}{end}'
```

2. Verify health and readiness in pod:
```bash
oc exec -n "$APP_NAMESPACE" deployment/"$APP_NAME" -- curl -sk https://localhost:9443/healthz
oc exec -n "$APP_NAMESPACE" deployment/"$APP_NAME" -- curl -sk https://localhost:9443/readyz
```

3. Verify manifest serving:
```bash
oc exec -n "$APP_NAMESPACE" deployment/"$APP_NAME" -- \
  curl -sk https://localhost:9443/plugin-manifest.json | jq
```

4. If plugin is still missing in console, inspect `ConsolePlugin` and console operator rollout:
```bash
oc get consoleplugin "$APP_NAME" -o yaml
oc rollout status deployment/console -n openshift-console
```
