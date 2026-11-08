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
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"
)

const generatedCRD = "recon.bewley.net_ovnrecons.yaml"

func generatedCRDPath() string {
	return filepath.Join("..", "..", "config", "crd", "bases", generatedCRD)
}

// The CRD declares exactly one version. A retired version must not come back
// (ovn-recon-5uj removed the last placeholder), and a new version must be
// introduced deliberately, with conversion and a storedVersions plan.
func TestGeneratedCRDDeclaresOnlyStorageVersion(t *testing.T) {
	path := generatedCRDPath()
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
	if n := len(crd.Spec.Versions); n != 1 {
		names := make([]string, 0, n)
		for _, v := range crd.Spec.Versions {
			names = append(names, v.Name)
		}
		t.Fatalf("CRD declares %d versions %v, want only %s", n, names, StorageVersion)
	}
	v := crd.Spec.Versions[0]
	if v.Name != StorageVersion || !v.Served || !v.Storage {
		t.Fatalf("version = %s served=%v storage=%v, want %s served and storage",
			v.Name, v.Served, v.Storage, StorageVersion)
	}
}

// Defaults live in the controller (ovn-recon-n7t). A schema default would be
// written into every object at creation and freeze there, so none may exist.
func TestGeneratedCRDHasNoSchemaDefaults(t *testing.T) {
	path := generatedCRDPath()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	var doc map[string]interface{}
	if err := yaml.Unmarshal(raw, &doc); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
	var found []string
	walkDefaults(doc, "", &found)
	if len(found) > 0 {
		t.Fatalf("CRD schema declares defaults; move them into the controller:\n%s", strings.Join(found, "\n"))
	}
}

func walkDefaults(node interface{}, path string, found *[]string) {
	switch v := node.(type) {
	case map[string]interface{}:
		if _, ok := v["default"]; ok {
			if _, isSchema := v["type"]; isSchema {
				*found = append(*found, path)
			}
		}
		for k, child := range v {
			walkDefaults(child, path+"/"+k, found)
		}
	case []interface{}:
		for i, child := range v {
			walkDefaults(child, fmt.Sprintf("%s[%d]", path, i), found)
		}
	}
}
