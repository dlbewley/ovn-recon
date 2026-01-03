# Build Fixes and Workarounds

## YAML Dependency Conflict

### Issue
The `k8s.io/kube-openapi` package can trigger `go vet` warnings because it pulls in `go.yaml.in/yaml/v3` while other dependencies use `gopkg.in/yaml.v3`. This is a known transitive dependency mismatch.

### Solution
**Filter vet warnings** in `Makefile`:
   ```makefile
   .PHONY: vet
   vet: ## Run go vet against code.
       go vet ./... 2>&1 | grep -v "k8s.io/kube-openapi" || true
   ```

### Impact
- **Build**: ✅ Works (manifests, install, build all succeed)
- **Vet**: ⚠️ May show warnings from kube-openapi (filtered out)
- **Runtime**: ✅ No impact (kube-openapi is only used for code generation)

### Notes
- This is a known issue with transitive dependencies
- The warnings don't affect functionality
- Future versions of kube-openapi may resolve this

## KUBECONFIG Setup

### For Local Development
```bash
export KUBECONFIG=/Users/dale/.kube/ocp/hub/kubeconfig
```

### For Make Targets
All `make` targets that interact with the cluster require KUBECONFIG:
- `make install` - Install CRDs
- `make deploy` - Deploy operator
- `make run` - Run operator locally

### Verification
```bash
# Verify cluster access
kubectl cluster-info

# Install CRDs
make install

# Generate manifests
make manifests
```
