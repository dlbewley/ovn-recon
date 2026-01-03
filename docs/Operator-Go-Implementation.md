# OVN Recon Go-based Operator Implementation Plan

Create an OpenShift Operator using the Go-based Operator SDK to enable declarative, lifecycle-managed deployment of the OVN Recon console plugin.

## Design Decisions

### Operator Type: Go-based (Kubebuilder)
- **Pros**: Full control over reconciliation logic, future-proof, actively maintained, can evolve to higher Operator maturity levels
- **Cons**: Requires Go development, more initial setup
- **Why Go**: Helm-based Operator SDK CLI is deprecated; Go provides full flexibility and is the standard approach

### Custom Resource Definition
```yaml
apiVersion: recon.bewley.net/v1alpha1
kind: OvnRecon
metadata:
  name: ovn-recon
spec:
  image:
    repository: quay.io/dbewley/ovn-recon
    tag: v0.0.2
    pullPolicy: IfNotPresent
  consolePlugin:
    displayName: "OVN Recon"
    enabled: true  # Auto-enables plugin in console.operator.openshift.io
status:
  conditions:
    - type: Available
      status: "True"
    - type: PluginEnabled
      status: "True"
```

### Directory Structure
```
operator/
├── Dockerfile
├── Makefile
├── PROJECT
├── api/
│   └── v1alpha1/
│       ├── ovnrecon_types.go      # CRD spec/status definitions
│       └── zz_generated.deepcopy.go
├── cmd/
│   └── main.go
├── config/
│   ├── crd/bases/
│   ├── default/
│   ├── manager/
│   ├── rbac/
│   └── samples/
├── internal/
│   └── controller/
│       └── ovnrecon_controller.go  # Reconciliation logic
└── go.mod
```

---

## Proposed Changes

### Phase 1: Scaffold Operator Project

#### Commands to initialize:
```bash
mkdir operator && cd operator
operator-sdk init \
  --domain bewley.net \
  --repo github.com/dlbewley/ovn-recon-operator

operator-sdk create api \
  --group recon \
  --version v1alpha1 \
  --kind OvnRecon \
  --resource --controller
```

---

### Phase 2: Define Custom Resource API

#### [MODIFY] `operator/api/v1alpha1/ovnrecon_types.go`

```go
type OvnReconSpec struct {
    // Image configuration for the plugin container
    Image ImageSpec `json:"image,omitempty"`

    // ConsolePlugin configuration
    ConsolePlugin ConsolePluginSpec `json:"consolePlugin,omitempty"`
}

type ImageSpec struct {
    Repository string `json:"repository,omitempty"`
    Tag        string `json:"tag,omitempty"`
    PullPolicy string `json:"pullPolicy,omitempty"`
}

type ConsolePluginSpec struct {
    DisplayName string `json:"displayName,omitempty"`
    Enabled     bool   `json:"enabled,omitempty"`
}

type OvnReconStatus struct {
    Conditions []metav1.Condition `json:"conditions,omitempty"`
}
```

---

### Phase 3: Implement Controller

#### [MODIFY] `operator/internal/controller/ovnrecon_controller.go`

The controller will:
1. **Create/Update Deployment** - Deploy the plugin container
2. **Create/Update Service** - Expose the plugin
3. **Create/Update ConsolePlugin** - Register with OpenShift Console
4. **Optionally enable plugin** - Patch `console.operator.openshift.io` if `enabled: true`

Key reconciliation logic:
- Set owner references for garbage collection
- Use `controllerutil.CreateOrUpdate` for idempotent operations
- Update status conditions to reflect deployment state

---

### Phase 4: RBAC Configuration

#### [MODIFY] `operator/config/rbac/role.yaml`
Grant permissions for:
- Deployments, Services, Secrets (in target namespace)
- ConsolePlugin (cluster-scoped)
- Console Operator (if auto-enabling)

---

### Phase 5: Build and CI/CD

#### [NEW] `.github/workflows/operator-build.yaml`
- Build operator container image
- Run tests (`make test`)
- Push to `quay.io/dbewley/ovn-recon-operator`

---

### Phase 6: OLM Integration (Optional)

Generate OLM bundle for OperatorHub:
```bash
make bundle IMG=quay.io/dbewley/ovn-recon-operator:v0.0.1
```

---

## Verification Plan

### Unit Tests
```bash
make test
```

### Local Testing
```bash
# Install CRDs
make install

# Run controller locally
make run

# Apply sample CR
kubectl apply -f config/samples/recon_v1alpha1_ovnrecon.yaml
```

### Cluster Testing
```bash
make deploy IMG=quay.io/dbewley/ovn-recon-operator:latest
kubectl apply -f config/samples/recon_v1alpha1_ovnrecon.yaml
```

---

## Decisions Made

| Question | Decision |
|----------|----------|
| API Group | `recon.bewley.net` |
| Auto-enable plugin | Yes - operator will patch `console.operator.openshift.io` |
| OLM/OperatorHub | Optional (Phase 6) |
| Image Registry | `quay.io/dbewley/ovn-recon-operator` |

# Next Steps:
- Local Test: Run `make install` and `make run` in the operator/ directory to test locally against your cluster.
- Deploy: Use `kubectl apply -f config/samples/recon_v1alpha1_ovnrecon.yaml` to trigger deployment.
- Verify: Check the OpenShift Console to see if the OVN Recon plugin is correctly registered and enabled.

## Bugs

This resulted in a ton of AI looping and trying to downgrade dependencies. Nothing worked.

```
$ make run
/Users/dale/src/ovn-recon/operator/bin/controller-gen rbac:roleName=manager-role crd webhook paths="./..." output:crd:artifacts:config=config/crd/bases
/Users/dale/src/ovn-recon/operator/bin/controller-gen object:headerFile="hack/boilerplate.go.txt" paths="./..."
go fmt ./...
go vet ./...
# k8s.io/apimachinery/pkg/util/managedfields/internal
../../../go/pkg/mod/k8s.io/apimachinery@v0.33.0/pkg/util/managedfields/internal/typeconverter.go:51:61: cannot use typeSchema.Types (variable of type []"sigs.k8s.io/structured-merge-diff/v6/schema".TypeDef) as []"sigs.k8s.io/structured-merge-diff/v4/schema".TypeDef value in struct literal
make: *** [vet] Error 1
```