/*
Copyright 2026.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

// crdplaceholder appends the retired v1alpha1 placeholder version to the
// controller-gen output for the OvnRecon CRD. make manifests runs it right
// after controller-gen so config/crd/bases (read by envtest, kustomize and the
// bundle alike) always carries the placeholder. Idempotent: an existing
// v1alpha1 entry is replaced.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"sigs.k8s.io/yaml"

	"github.com/dlbewley/ovn-recon-operator/internal/apiversions"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: crdplaceholder <path-to-crd.yaml>")
		os.Exit(2)
	}
	path := os.Args[1]
	if err := run(path); err != nil {
		fmt.Fprintf(os.Stderr, "crdplaceholder: %s: %v\n", path, err)
		os.Exit(1)
	}
}

// run works on a generic map rather than the typed CRD so the round trip does
// not introduce fields controller-gen omits (creationTimestamp, status) and the
// resulting diff is only the added version.
func run(path string) error {
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var crd map[string]interface{}
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		return fmt.Errorf("parse CRD: %w", err)
	}
	if name, _ := crd["metadata"].(map[string]interface{})["name"].(string); name != apiversions.CRDName {
		return fmt.Errorf("expected CRD %s, found %q", apiversions.CRDName, name)
	}
	spec, ok := crd["spec"].(map[string]interface{})
	if !ok {
		return fmt.Errorf("CRD has no spec")
	}
	versions, ok := spec["versions"].([]interface{})
	if !ok || len(versions) == 0 {
		return fmt.Errorf("CRD has no spec.versions")
	}

	placeholder, err := toMap(apiversions.RetiredV1alpha1Placeholder())
	if err != nil {
		return err
	}

	kept := make([]interface{}, 0, len(versions)+1)
	kept = append(kept, placeholder)
	for _, v := range versions {
		if m, ok := v.(map[string]interface{}); ok && m["name"] == apiversions.RetiredV1alpha1 {
			continue
		}
		kept = append(kept, v)
	}
	spec["versions"] = kept

	out, err := yaml.Marshal(crd)
	if err != nil {
		return fmt.Errorf("serialize CRD: %w", err)
	}
	return os.WriteFile(path, append([]byte("---\n"), out...), 0o644)
}

func toMap(v interface{}) (map[string]interface{}, error) {
	b, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	var m map[string]interface{}
	if err := json.Unmarshal(b, &m); err != nil {
		return nil, err
	}
	return m, nil
}
