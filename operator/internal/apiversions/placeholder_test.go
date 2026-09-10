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

package apiversions

import (
	"os"
	"path/filepath"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"
)

// The placeholder is appended by hack/crdplaceholder during make manifests.
// Running controller-gen by hand drops it silently; this test catches that
// before a CRD without v1alpha1 reaches a bundle and stalls upgrades again.
func TestGeneratedCRDCarriesRetiredPlaceholder(t *testing.T) {
	path := filepath.Join("..", "..", "config", "crd", "bases", "recon.bewley.net_ovnrecons.yaml")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	crd := &apiextensionsv1.CustomResourceDefinition{}
	if err := yaml.Unmarshal(raw, crd); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	if crd.Name != CRDName {
		t.Fatalf("CRD name = %q, want %q", crd.Name, CRDName)
	}

	var alpha *apiextensionsv1.CustomResourceDefinitionVersion
	storage := ""
	for i := range crd.Spec.Versions {
		v := &crd.Spec.Versions[i]
		if v.Storage {
			storage = v.Name
		}
		if v.Name == RetiredV1alpha1 {
			alpha = v
		}
	}
	if storage != "v1beta1" {
		t.Fatalf("storage version = %q, want v1beta1", storage)
	}
	if alpha == nil {
		t.Fatalf("%s is missing the %s placeholder; run make manifests", path, RetiredV1alpha1)
	}
	if alpha.Served || alpha.Storage {
		t.Fatalf("%s placeholder must be unserved and non-storage, got served=%v storage=%v",
			RetiredV1alpha1, alpha.Served, alpha.Storage)
	}
	if alpha.Schema == nil || alpha.Schema.OpenAPIV3Schema == nil ||
		alpha.Schema.OpenAPIV3Schema.XPreserveUnknownFields == nil ||
		!*alpha.Schema.OpenAPIV3Schema.XPreserveUnknownFields {
		t.Fatalf("%s placeholder must preserve unknown fields so any historical object validates", RetiredV1alpha1)
	}
}

func TestPlaceholderShape(t *testing.T) {
	p := RetiredV1alpha1Placeholder()
	if p.Name != RetiredV1alpha1 || p.Served || p.Storage {
		t.Fatalf("unexpected placeholder: %+v", p)
	}
	if p.Schema.OpenAPIV3Schema.Type != "object" {
		t.Fatalf("placeholder schema type = %q, want object (structural)", p.Schema.OpenAPIV3Schema.Type)
	}
}
