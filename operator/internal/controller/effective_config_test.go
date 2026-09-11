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

package controller

import (
	"reflect"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// explicitDefaultsCR spells out every documented default. If a default ever
// moves, this is the one place to update; the equivalence test below then
// proves the bare CR moved with it.
func explicitDefaultsCR(name string) *reconv1beta1.OvnRecon {
	return &reconv1beta1.OvnRecon{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: reconv1beta1.OvnReconSpec{
			TargetNamespace: "ovn-recon",
			Operator: reconv1beta1.OperatorSpec{Logging: reconv1beta1.OperatorLoggingSpec{
				Level:  "info",
				Events: reconv1beta1.OperatorEventsSpec{MinType: "Normal", DedupeWindow: "5m"},
			}},
			ConsolePlugin: reconv1beta1.ConsolePluginSpec{
				DisplayName: "OVN Recon",
				Enabled:     boolPtr(true),
				Image:       reconv1beta1.ImageSpec{Repository: "quay.io/dbewley/ovn-recon", PullPolicy: "IfNotPresent"},
				Logging: reconv1beta1.ConsolePluginLoggingSpec{
					Level:     "info",
					AccessLog: reconv1beta1.AccessLogSpec{Enabled: false},
				},
			},
			Collector: reconv1beta1.CollectorSpec{
				Enabled:         boolPtr(true),
				Image:           reconv1beta1.CollectorImageSpec{Repository: "quay.io/dbewley/ovn-collector"},
				ProbeNamespaces: []string{"openshift-ovn-kubernetes", "openshift-frr-k8s"},
				Logging:         reconv1beta1.CollectorLoggingSpec{Level: "info", IncludeProbeOutput: false},
				Cache: reconv1beta1.CollectorCacheSpec{
					Enabled:    boolPtr(true),
					TTLSeconds: 120,
					Storage: reconv1beta1.CollectorCacheStorageSpec{
						Mode:    "auto",
						Managed: boolPtr(true),
						Size:    "1Gi",
					},
				},
			},
		},
	}
}

func bareCR(name string) *reconv1beta1.OvnRecon {
	return &reconv1beta1.OvnRecon{ObjectMeta: metav1.ObjectMeta{Name: name}}
}

func defaultPolicies(cr *reconv1beta1.OvnRecon) (operatorLogLevel, operatorEventPolicy) {
	level, _, _ := resolveOperatorLogPolicy(cr, nil)
	return level, resolveOperatorEventPolicy(cr, nil)
}

// With the CRD no longer materializing defaults, the controller is the only
// place they live. An empty spec must render exactly what a spec that spells
// every default out renders.
func TestEmptySpecRendersSameAsExplicitDefaults(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "")
	t.Setenv("RELATED_IMAGE_COLLECTOR", "")

	bare := bareCR("ovn-recon")
	explicit := explicitDefaultsCR("ovn-recon")

	pvcStorage := &collectorCacheStorage{usePVC: true}
	checks := map[string][2]interface{}{
		"plugin Deployment":             {DesiredDeployment(bare), DesiredDeployment(explicit)},
		"plugin Service":                {DesiredService(bare), DesiredService(explicit)},
		"collector Service":             {DesiredCollectorService(bare), DesiredCollectorService(explicit)},
		"collector Deployment (spec)":   {DesiredCollectorDeployment(bare, nil), DesiredCollectorDeployment(explicit, nil)},
		"collector Deployment (PVC)":    {DesiredCollectorDeployment(bare, pvcStorage), DesiredCollectorDeployment(explicit, pvcStorage)},
		"collector cache PVC":           {DesiredCollectorCachePVC(bare), DesiredCollectorCachePVC(explicit)},
		"ConsolePlugin":                 {DesiredConsolePlugin(bare), DesiredConsolePlugin(explicit)},
		"collector enabled":             {collectorFeatureEnabled(bare), collectorFeatureEnabled(explicit)},
		"console plugin enabled":        {consolePluginEnabledFor(bare), consolePluginEnabledFor(explicit)},
		"cache wants PVC":               {collectorCacheWantsPVC(bare), collectorCacheWantsPVC(explicit)},
		"cache claim name":              {collectorCacheClaimNameFor(bare), collectorCacheClaimNameFor(explicit)},
		"operator log/event policy":     {policiesOf(bare), policiesOf(explicit)},
		"effective configuration (nil)": {effectiveOf(bare, nil), effectiveOf(explicit, nil)},
		"effective configuration (PVC)": {effectiveOf(bare, pvcStorage), effectiveOf(explicit, pvcStorage)},
	}
	for name, pair := range checks {
		if !reflect.DeepEqual(pair[0], pair[1]) {
			t.Errorf("%s differs between bare and explicit-default CR:\n bare:     %+v\n explicit: %+v", name, pair[0], pair[1])
		}
	}
}

type policyPair struct {
	level string
	event operatorEventPolicy
}

func policiesOf(cr *reconv1beta1.OvnRecon) policyPair {
	level, event := defaultPolicies(cr)
	return policyPair{level: level.String(), event: event}
}

func effectiveOf(cr *reconv1beta1.OvnRecon, storage *collectorCacheStorage) reconv1beta1.EffectiveConfig {
	level, event := defaultPolicies(cr)
	return effectiveConfigFor(cr, storage, level, event)
}

// Objects created under pre-v1.0.4 CRDs carry the built-in repository as a
// materialized schema default. They must follow RELATED_IMAGE_* like a bare CR
// does, or mirrored installs keep pulling from quay.io forever.
func TestMaterializedDefaultRepositoryStillFollowsRelatedImage(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "registry.mirror.example/ovn-recon@sha256:abc")
	t.Setenv("RELATED_IMAGE_COLLECTOR", "registry.mirror.example/ovn-collector@sha256:def")

	cr := bareCR("legacy")
	cr.Spec.ConsolePlugin.Image.Repository = "quay.io/dbewley/ovn-recon"
	cr.Spec.Collector.Image.Repository = "quay.io/dbewley/ovn-collector"

	if got := pluginImageFor(cr); got != "registry.mirror.example/ovn-recon@sha256:abc" {
		t.Fatalf("materialized default plugin repository should not defeat RELATED_IMAGE_PLUGIN, got %s", got)
	}
	if got := collectorImageFor(cr); got != "registry.mirror.example/ovn-collector@sha256:def" {
		t.Fatalf("materialized default collector repository should not defeat RELATED_IMAGE_COLLECTOR, got %s", got)
	}

	// A genuinely different repository is user intent and still wins.
	cr.Spec.ConsolePlugin.Image.Repository = "registry.corp.example/ovn-recon"
	if got := pluginImageFor(cr); got != "registry.corp.example/ovn-recon:v1.2.3" {
		t.Fatalf("explicit repository should win over RELATED_IMAGE_PLUGIN, got %s", got)
	}
}

func TestEffectiveConfigReportsResolvedValuesForBareCR(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")
	t.Setenv("RELATED_IMAGE_PLUGIN", "")
	t.Setenv("RELATED_IMAGE_COLLECTOR", "")

	cr := bareCR("ovn-recon")
	cr.Generation = 7
	eff := effectiveOf(cr, &collectorCacheStorage{usePVC: true})

	want := reconv1beta1.EffectiveConfig{
		ObservedGeneration: 7,
		TargetNamespace:    "ovn-recon",
		Operator:           reconv1beta1.EffectiveOperator{LogLevel: "info", EventMinType: "Normal", EventDedupeWindow: "5m0s"},
		ConsolePlugin: reconv1beta1.EffectiveConsolePlugin{
			Enabled: true, DisplayName: "OVN Recon", Image: "quay.io/dbewley/ovn-recon:v1.2.3",
			PullPolicy: "IfNotPresent", LogLevel: "info", AccessLog: false,
		},
		Collector: reconv1beta1.EffectiveCollector{
			Enabled: true, Image: "quay.io/dbewley/ovn-collector:v1.2.3", PullPolicy: "IfNotPresent",
			ProbeNamespaces: []string{"openshift-ovn-kubernetes", "openshift-frr-k8s"},
			LogLevel:        "info", IncludeProbeOutput: false,
			Cache: reconv1beta1.EffectiveCollectorCache{
				Enabled: true, TTLSeconds: 120, Mode: cacheStorageModeAuto, Backing: cacheBackingPVC,
				ClaimName: "ovn-recon-collector-cache", Managed: true, Size: "1Gi",
			},
		},
	}
	if !reflect.DeepEqual(eff, want) {
		t.Fatalf("effective config mismatch:\n got:  %+v\n want: %+v", eff, want)
	}
}

func TestEffectiveConfigReflectsFallbackAndDisabledStates(t *testing.T) {
	t.Setenv("OPERATOR_VERSION", "v1.2.3")

	cr := bareCR("ovn-recon")
	eff := effectiveOf(cr, &collectorCacheStorage{fallbackReason: "no viable StorageClass"})
	if eff.Collector.Cache.Backing != cacheBackingEmptyDir || eff.Collector.Cache.FallbackReason != "no viable StorageClass" {
		t.Fatalf("fallback not reported: %+v", eff.Collector.Cache)
	}
	if eff.Collector.Cache.ClaimName == "" {
		t.Fatalf("auto mode still wants the claim; its name should be reported: %+v", eff.Collector.Cache)
	}

	cr.Spec.Collector.Cache.Storage.Mode = cacheBackingEmptyDir
	eff = effectiveOf(cr, &collectorCacheStorage{})
	if eff.Collector.Cache.Mode != cacheBackingEmptyDir || eff.Collector.Cache.Backing != cacheBackingEmptyDir || eff.Collector.Cache.ClaimName != "" || eff.Collector.Cache.Size != "" {
		t.Fatalf("explicit EmptyDir should report no claim: %+v", eff.Collector.Cache)
	}

	cr.Spec.Collector.Enabled = boolPtr(false)
	eff = effectiveOf(cr, nil)
	if eff.Collector.Enabled || eff.Collector.Cache.Backing != "" {
		t.Fatalf("disabled collector must report no backing: %+v", eff.Collector)
	}

	cr = bareCR("ovn-recon")
	cr.Spec.Collector.Cache.TTLSeconds = 5
	eff = effectiveOf(cr, nil)
	if eff.Collector.Cache.TTLSeconds != 30 {
		t.Fatalf("TTL floor should show in effective config, got %d", eff.Collector.Cache.TTLSeconds)
	}
}
