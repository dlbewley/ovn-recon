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
	"context"
	"reflect"
	"strings"

	"sigs.k8s.io/controller-runtime/pkg/log"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

// Canonical spellings for status.effective.collector.cache. The spec enum is
// auto|EmptyDir|PVC; the internal helpers lower-case it, so map back here.
const (
	cacheBackingPVC      = "PVC"
	cacheBackingEmptyDir = "EmptyDir"
)

func canonicalCacheStorageMode(ovnRecon *reconv1beta1.OvnRecon) string {
	switch collectorCacheStorageModeFor(ovnRecon) {
	case cacheStorageModeEmptyDir:
		return cacheBackingEmptyDir
	case cacheStorageModePVC:
		return cacheBackingPVC
	default:
		return cacheStorageModeAuto
	}
}

// effectiveConfigFor resolves what the operator is acting on for this
// generation of the spec. It is the single place that turns "omitted" into a
// concrete value for the user to read, so it must go through the same helpers
// the renderers use; a value shown here that the Deployment does not actually
// carry is a bug.
//
// cacheStorage is the storage decision made while reconciling the collector
// Deployment (nil when the collector is disabled and nothing was mounted).
func effectiveConfigFor(
	ovnRecon *reconv1beta1.OvnRecon,
	cacheStorage *collectorCacheStorage,
	logLevel operatorLogLevel,
	eventPolicy operatorEventPolicy,
) reconv1beta1.EffectiveConfig {
	collectorEnabled := collectorFeatureEnabled(ovnRecon)
	cacheEnabled := collectorCacheEnabledFor(ovnRecon)
	storageSpec := ovnRecon.Spec.Collector.Cache.Storage

	cache := reconv1beta1.EffectiveCollectorCache{
		Enabled:          cacheEnabled,
		TTLSeconds:       collectorCacheTTLSecondsFor(ovnRecon),
		Mode:             canonicalCacheStorageMode(ovnRecon),
		Managed:          collectorCacheManagedFor(ovnRecon),
		StorageClassName: strings.TrimSpace(storageSpec.StorageClassName),
	}
	if cacheEnabled && collectorCacheWantsPVC(ovnRecon) {
		cache.ClaimName = collectorCacheClaimNameFor(ovnRecon)
		if cache.Managed {
			cache.Size = DesiredCollectorCachePVC(ovnRecon).Spec.Resources.Requests.Storage().String()
		}
	}
	if collectorEnabled && cacheEnabled {
		cache.Backing = cacheBackingEmptyDir
		if cacheStorage != nil {
			if cacheStorage.usePVC {
				cache.Backing = cacheBackingPVC
			}
			cache.FallbackReason = cacheStorage.fallbackReason
		}
	}

	return reconv1beta1.EffectiveConfig{
		ObservedGeneration: ovnRecon.Generation,
		TargetNamespace:    targetNamespace(ovnRecon),
		Operator: reconv1beta1.EffectiveOperator{
			LogLevel:          logLevel.String(),
			EventMinType:      eventPolicy.minType,
			EventDedupeWindow: eventPolicy.dedupeWindow.String(),
		},
		ConsolePlugin: reconv1beta1.EffectiveConsolePlugin{
			Enabled:     consolePluginEnabledFor(ovnRecon),
			DisplayName: consolePluginDisplayNameFor(ovnRecon),
			Image:       pluginImageFor(ovnRecon),
			PullPolicy:  string(imagePullPolicyFor(ovnRecon)),
			LogLevel:    consolePluginErrorLogLevelFor(ovnRecon),
			AccessLog:   ovnRecon.Spec.ConsolePlugin.Logging.AccessLog.Enabled,
		},
		Collector: reconv1beta1.EffectiveCollector{
			Enabled:            collectorEnabled,
			Image:              collectorImageFor(ovnRecon),
			PullPolicy:         string(collectorImagePullPolicyFor(ovnRecon)),
			ProbeNamespaces:    collectorProbeNamespacesFor(ovnRecon),
			LogLevel:           collectorLogLevelFor(ovnRecon),
			IncludeProbeOutput: collectorIncludeProbeOutputFor(ovnRecon),
			Cache:              cache,
		},
	}
}

// updateEffectiveConfig publishes the resolved configuration in status when it
// changed. Like updateCondition it writes the whole status, so callers must
// have the current object.
func (r *OvnReconReconciler) updateEffectiveConfig(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon, effective reconv1beta1.EffectiveConfig) bool {
	if ovnRecon.Status.Effective != nil && reflect.DeepEqual(*ovnRecon.Status.Effective, effective) {
		return false
	}
	ovnRecon.Status.Effective = &effective
	if err := r.Status().Update(ctx, ovnRecon); err != nil {
		log.FromContext(ctx).Error(err, "Failed to update status.effective")
		return false
	}
	return true
}
