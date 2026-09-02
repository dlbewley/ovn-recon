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
	"fmt"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/builder"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/event"
	"sigs.k8s.io/controller-runtime/pkg/handler"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1beta1 "github.com/dlbewley/ovn-recon-operator/api/v1beta1"
)

const (
	finalizerName           = "ovnrecon.bewley.net/finalizer"
	defaultNamespace        = "ovn-recon"
	defaultImageRepository  = "quay.io/dbewley/ovn-recon"
	defaultImageTag         = "latest"
	defaultOperatorLogLevel = "info"
	defaultEventMinType     = corev1.EventTypeNormal
	defaultEventDedupe      = 5 * time.Minute
)

// OvnReconReconciler reconciles a OvnRecon object
type OvnReconReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder

	eventDedupeMu sync.Mutex
	eventDedupe   map[string]time.Time
}

type operatorLogLevel int

const (
	operatorLogLevelError operatorLogLevel = iota
	operatorLogLevelWarn
	operatorLogLevelInfo
	operatorLogLevelDebug
	operatorLogLevelTrace
)

type operatorEventPolicy struct {
	minType      string
	dedupeWindow time.Duration
}

func (l operatorLogLevel) String() string {
	switch l {
	case operatorLogLevelError:
		return "error"
	case operatorLogLevelWarn:
		return "warn"
	case operatorLogLevelInfo:
		return "info"
	case operatorLogLevelDebug:
		return "debug"
	case operatorLogLevelTrace:
		return "trace"
	default:
		return defaultOperatorLogLevel
	}
}

func (l operatorLogLevel) allows(messageLevel operatorLogLevel) bool {
	return messageLevel <= l
}

func parseOperatorLogLevel(raw string) operatorLogLevel {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "error":
		return operatorLogLevelError
	case "warn":
		return operatorLogLevelWarn
	case "debug":
		return operatorLogLevelDebug
	case "trace":
		return operatorLogLevelTrace
	case "info":
		fallthrough
	default:
		return operatorLogLevelInfo
	}
}

func operatorLogLevelFor(ovnRecon *reconv1beta1.OvnRecon) operatorLogLevel {
	if ovnRecon == nil {
		return parseOperatorLogLevel(defaultOperatorLogLevel)
	}
	return parseOperatorLogLevel(ovnRecon.Spec.Operator.Logging.Level)
}

func withReconcilePhase(ctx context.Context, phase string) context.Context {
	logger := log.FromContext(ctx).WithValues("phase", phase)
	return log.IntoContext(ctx, logger)
}

func ovnReconRef(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon == nil {
		return ""
	}
	if ovnRecon.Namespace == "" {
		return ovnRecon.Name
	}
	return ovnRecon.Namespace + "/" + ovnRecon.Name
}

func requestRef(req ctrl.Request) string {
	if req.Namespace == "" {
		return req.Name
	}
	return req.Namespace + "/" + req.Name
}

func resolveOperatorLogPolicy(current, primary *reconv1beta1.OvnRecon) (operatorLogLevel, string, string) {
	source := current
	if primary != nil {
		source = primary
	}

	level := operatorLogLevelFor(source)
	configuredLevel := defaultOperatorLogLevel
	if source != nil {
		if raw := strings.TrimSpace(source.Spec.Operator.Logging.Level); raw != "" {
			configuredLevel = raw
		}
	}

	return level, configuredLevel, ovnReconRef(source)
}

func resolveOperatorEventPolicy(current, primary *reconv1beta1.OvnRecon) operatorEventPolicy {
	source := current
	if primary != nil {
		source = primary
	}

	policy := operatorEventPolicy{
		minType:      defaultEventMinType,
		dedupeWindow: defaultEventDedupe,
	}
	if source == nil {
		return policy
	}

	if strings.EqualFold(strings.TrimSpace(source.Spec.Operator.Logging.Events.MinType), corev1.EventTypeWarning) {
		policy.minType = corev1.EventTypeWarning
	}
	if raw := strings.TrimSpace(source.Spec.Operator.Logging.Events.DedupeWindow); raw != "" {
		if parsed, err := time.ParseDuration(raw); err == nil && parsed > 0 {
			policy.dedupeWindow = parsed
		}
	}

	return policy
}

func (r *OvnReconReconciler) logMessage(ctx context.Context, policy operatorLogLevel, level operatorLogLevel, message string, keysAndValues ...interface{}) {
	if !policy.allows(level) {
		return
	}
	args := append([]interface{}{"logLevel", level.String()}, keysAndValues...)
	log.FromContext(ctx).Info(message, args...)
}

func (r *OvnReconReconciler) recordEvent(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon, policy operatorEventPolicy, eventType, reason, message string) {
	if r.Recorder == nil {
		// Recorder can be nil in unit tests that don't wire manager event recording.
		return
	}
	if eventType == corev1.EventTypeWarning {
		// Warning events are always emitted to avoid hiding failures.
		r.Recorder.Event(ovnRecon, eventType, reason, message)
		return
	}
	if policy.minType == corev1.EventTypeWarning {
		return
	}
	if !r.shouldEmitNormalEvent(ovnRecon, policy, reason, message) {
		return
	}

	r.Recorder.Event(ovnRecon, eventType, reason, message)
}

func (r *OvnReconReconciler) shouldEmitNormalEvent(ovnRecon *reconv1beta1.OvnRecon, policy operatorEventPolicy, reason, message string) bool {
	now := time.Now()
	key := fmt.Sprintf("%s|%s|%s", ovnReconRef(ovnRecon), reason, message)

	r.eventDedupeMu.Lock()
	defer r.eventDedupeMu.Unlock()

	if r.eventDedupe == nil {
		r.eventDedupe = make(map[string]time.Time)
	}

	if last, ok := r.eventDedupe[key]; ok && now.Sub(last) < policy.dedupeWindow {
		return false
	}

	r.eventDedupe[key] = now
	// Keep cache bounded by dropping stale entries opportunistically.
	for candidate, ts := range r.eventDedupe {
		if now.Sub(ts) > (policy.dedupeWindow * 2) {
			delete(r.eventDedupe, candidate)
		}
	}

	return true
}

// +kubebuilder:rbac:groups=recon.bewley.net,resources=ovnrecons,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=recon.bewley.net,resources=ovnrecons/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=recon.bewley.net,resources=ovnrecons/finalizers,verbs=update
// Deployments, Services and Namespaces keep list+watch: their informers still
// LIST+WATCH, label-filtered (Deployment, Service) or metadata-only (Namespace).
// Everything below that lost list+watch is read live, never cached; see
// internal/controller/cache_policy.go. Pods keep list+watch because the
// operator can only grant the collector ClusterRole verbs it holds itself.
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=namespaces,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=persistentvolumeclaims,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=storage.k8s.io,resources=storageclasses,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods/exec,verbs=create
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=rolebindings,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups=console.openshift.io,resources=consoleplugins,verbs=get;create;update;patch;delete
// +kubebuilder:rbac:groups=operator.openshift.io,resources=consoles,verbs=get;update;patch

// Reconcile is part of the main kubernetes reconciliation loop which aims to
// move the current state of the cluster closer to the desired state.
func (r *OvnReconReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	reconcileID := fmt.Sprintf("%d", time.Now().UnixNano())
	logger := log.FromContext(ctx).WithValues(
		"component", "operator",
		"ovnrecon", requestRef(req),
		"reconcileID", reconcileID,
	)
	ctx = log.IntoContext(ctx, logger)

	// Fetch the OvnRecon instance
	fetchCtx := withReconcilePhase(ctx, "fetch")
	ovnRecon := &reconv1beta1.OvnRecon{}
	err := r.Get(fetchCtx, req.NamespacedName, ovnRecon)
	if err != nil {
		if errors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		log.FromContext(fetchCtx).Error(err, "Failed to fetch OvnRecon")
		return reconcile.Result{}, err
	}

	primaryCtx := withReconcilePhase(ctx, "primary-detection")
	primary, err := r.primaryInstance(primaryCtx)
	if err != nil {
		log.FromContext(primaryCtx).Error(err, "Failed to determine primary OvnRecon instance")
		return reconcile.Result{}, err
	}
	policy, configuredLevel, policySource := resolveOperatorLogPolicy(ovnRecon, primary)
	eventPolicy := resolveOperatorEventPolicy(ovnRecon, primary)

	policyCtx := withReconcilePhase(ctx, "policy")
	r.logMessage(policyCtx, policy, operatorLogLevelDebug, "Resolved operator logging policy",
		"configuredLevel", configuredLevel,
		"effectiveLevel", policy.String(),
		"source", policySource,
	)
	r.logMessage(policyCtx, policy, operatorLogLevelDebug, "Resolved operator event policy",
		"minType", eventPolicy.minType,
		"dedupeWindow", eventPolicy.dedupeWindow.String(),
	)

	// Handle deletion
	if !ovnRecon.DeletionTimestamp.IsZero() {
		deletionCtx := withReconcilePhase(ctx, "deletion")
		r.logMessage(deletionCtx, policy, operatorLogLevelDebug, "Processing deletion")
		return r.handleDeletion(deletionCtx, ovnRecon)
	}

	isPrimary := primary == nil || (ovnRecon.Namespace == primary.Namespace && ovnRecon.Name == primary.Name)
	if !isPrimary {
		nonPrimaryCtx := withReconcilePhase(ctx, "primary-check")
		r.recordEvent(nonPrimaryCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "NotPrimary", "Another OvnRecon instance is already active")
		r.updateCondition(nonPrimaryCtx, ovnRecon, "Available", metav1.ConditionFalse, "NotPrimary", "Another OvnRecon instance is already active")
		r.updateCondition(nonPrimaryCtx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "NotPrimary", "Another OvnRecon instance is already active")
		r.logMessage(nonPrimaryCtx, policy, operatorLogLevelInfo, "Skipping reconcile for non-primary OvnRecon", "primary", ovnReconRef(primary))
		return reconcile.Result{RequeueAfter: time.Minute * 2}, nil
	}
	r.logMessage(withReconcilePhase(ctx, "start"), policy, operatorLogLevelDebug, "Starting reconcile")

	// Add finalizer if not present
	if !controllerutil.ContainsFinalizer(ovnRecon, finalizerName) {
		finalizerCtx := withReconcilePhase(ctx, "finalizer")
		controllerutil.AddFinalizer(ovnRecon, finalizerName)
		if err := r.Update(finalizerCtx, ovnRecon); err != nil {
			log.FromContext(finalizerCtx).Error(err, "Failed to add finalizer")
			return reconcile.Result{}, err
		}
		r.logMessage(finalizerCtx, policy, operatorLogLevelTrace, "Added finalizer")
	}

	// Initialize status conditions if needed
	if ovnRecon.Status.Conditions == nil {
		ovnRecon.Status.Conditions = []metav1.Condition{}
	}

	// Require target namespace to exist for namespaced resources.
	namespaceCtx := withReconcilePhase(ctx, "namespace-check")
	if err := r.ensureTargetNamespaceExists(namespaceCtx, ovnRecon); err != nil {
		log.FromContext(namespaceCtx).Error(err, "Target namespace does not exist")
		r.recordEvent(namespaceCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "NamespaceNotFound", err.Error())
		r.updateCondition(namespaceCtx, ovnRecon, "NamespaceReady", metav1.ConditionFalse, "NamespaceNotFound", err.Error())
		return reconcile.Result{RequeueAfter: time.Minute}, nil
	}
	if r.updateCondition(namespaceCtx, ovnRecon, "NamespaceReady", metav1.ConditionTrue, "NamespaceFound", "Target namespace exists") {
		r.recordEvent(namespaceCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "NamespaceFound", "Target namespace exists")
	}

	// 1. Reconcile Deployment
	deploymentCtx := withReconcilePhase(ctx, "reconcile-deployment")
	if err := r.reconcileDeployment(deploymentCtx, ovnRecon); err != nil {
		return r.reconcileStepFailed(deploymentCtx, ovnRecon, policy, eventPolicy, err,
			"Failed to reconcile Deployment", "DeploymentReconcileFailed", "Available")
	}
	r.logMessage(deploymentCtx, policy, operatorLogLevelTrace, "Deployment reconciled")

	// 2. Reconcile Service
	serviceCtx := withReconcilePhase(ctx, "reconcile-service")
	if err := r.reconcileService(serviceCtx, ovnRecon); err != nil {
		return r.reconcileStepFailed(serviceCtx, ovnRecon, policy, eventPolicy, err,
			"Failed to reconcile Service", "ServiceReconcileFailed", "ServiceReady")
	}
	if r.updateCondition(serviceCtx, ovnRecon, "ServiceReady", metav1.ConditionTrue, "ServiceReady", "Service is ready") {
		r.recordEvent(serviceCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "ServiceReady", "Service is ready")
	}
	r.logMessage(serviceCtx, policy, operatorLogLevelTrace, "Service reconciled")

	// 2.5 Reconcile collector service and collector resources behind feature gate.
	// Keep the collector Service present even when collector is disabled so plugin nginx
	// can resolve the backend DNS name at startup.
	collectorServiceCtx := withReconcilePhase(ctx, "reconcile-collector-service")
	if err := r.reconcileCollectorService(collectorServiceCtx, ovnRecon); err != nil {
		return r.reconcileStepFailed(collectorServiceCtx, ovnRecon, policy, eventPolicy, err,
			"Failed to reconcile collector Service", "CollectorServiceReconcileFailed", "CollectorReady")
	}

	if collectorFeatureEnabled(ovnRecon) {
		collectorRBACCtx := withReconcilePhase(ctx, "reconcile-collector-rbac")
		if err := r.reconcileCollectorAccessControls(collectorRBACCtx, ovnRecon); err != nil {
			return r.reconcileStepFailed(collectorRBACCtx, ovnRecon, policy, eventPolicy, err,
				"Failed to reconcile collector access controls", "CollectorRBACReconcileFailed", "CollectorReady")
		}
		collectorDeploymentCtx := withReconcilePhase(ctx, "reconcile-collector-deployment")
		if err := r.reconcileCollectorDeployment(collectorDeploymentCtx, ovnRecon, eventPolicy); err != nil {
			return r.reconcileStepFailed(collectorDeploymentCtx, ovnRecon, policy, eventPolicy, err,
				"Failed to reconcile collector Deployment", "CollectorDeploymentReconcileFailed", "CollectorReady")
		}

		if r.updateCondition(collectorServiceCtx, ovnRecon, "CollectorReady", metav1.ConditionTrue, "CollectorReady", "Collector resources are reconciled") {
			r.recordEvent(collectorServiceCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "CollectorReady", "Collector resources are reconciled")
		}
	} else {
		collectorDeleteCtx := withReconcilePhase(ctx, "delete-collector-deployment")
		if err := r.deleteCollectorDeployment(collectorDeleteCtx, ovnRecon); err != nil {
			log.FromContext(collectorDeleteCtx).Error(err, "Failed to delete collector deployment while feature gate is disabled")
			return reconcile.Result{}, err
		}
		collectorRBACDeleteCtx := withReconcilePhase(ctx, "delete-collector-rbac")
		if err := r.deleteCollectorAccessControls(collectorRBACDeleteCtx, ovnRecon); err != nil {
			log.FromContext(collectorRBACDeleteCtx).Error(err, "Failed to delete collector RBAC while feature gate is disabled")
			return reconcile.Result{}, err
		}
		if r.updateCondition(collectorRBACDeleteCtx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorFeatureDisabled", "Collector feature gate is disabled") {
			r.recordEvent(collectorRBACDeleteCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "CollectorFeatureDisabled", "Collector feature gate is disabled")
		}
	}

	// 3. Reconcile ConsolePlugin
	consolePluginCtx := withReconcilePhase(ctx, "reconcile-consoleplugin")
	if err := r.reconcileConsolePlugin(consolePluginCtx, ovnRecon); err != nil {
		return r.reconcileStepFailed(consolePluginCtx, ovnRecon, policy, eventPolicy, err,
			"Failed to reconcile ConsolePlugin", "ConsolePluginReconcileFailed", "ConsolePluginReady")
	}
	if r.updateCondition(consolePluginCtx, ovnRecon, "ConsolePluginReady", metav1.ConditionTrue, "ConsolePluginReady", "ConsolePlugin is ready") {
		r.recordEvent(consolePluginCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "ConsolePluginReady", "ConsolePlugin is ready")
	}

	// Check deployment status after the service is in place.
	deploymentStatusCtx := withReconcilePhase(ctx, "deployment-status")
	deploymentReady, err := r.checkDeploymentReady(deploymentStatusCtx, ovnRecon)
	if err != nil {
		log.FromContext(deploymentStatusCtx).Error(err, "Failed to check Deployment status")
		return reconcile.Result{}, err
	}

	if deploymentReady {
		if r.updateCondition(deploymentStatusCtx, ovnRecon, "Available", metav1.ConditionTrue, "DeploymentReady", "Deployment is ready") {
			r.recordEvent(deploymentStatusCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "DeploymentReady", "Deployment is ready")
		}
	} else {
		r.updateCondition(deploymentStatusCtx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentNotReady", "Deployment is not ready")
		// The Deployment watch delivers readiness, so this is only a backstop
		// against a missed event rather than the mechanism that finds it.
		return reconcile.Result{RequeueAfter: deploymentReadinessBackstop}, nil
	}

	// 4. Auto-enable plugin in Console operator configuration
	if consolePluginEnabledFor(ovnRecon) {
		consoleOperatorCtx := withReconcilePhase(ctx, "reconcile-console-operator")
		enabled, err := r.reconcileConsoleOperator(consoleOperatorCtx, ovnRecon)
		if err != nil {
			log.FromContext(consoleOperatorCtx).Error(err, "Failed to auto-enable plugin in Console operator")
			r.recordEvent(consoleOperatorCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "ConsoleOperatorUpdateFailed", err.Error())
			// Retry on conflict
			if errors.IsConflict(err) {
				return reconcile.Result{Requeue: true}, nil
			}
			return reconcile.Result{}, err
		}
		if enabled {
			if r.updateCondition(consoleOperatorCtx, ovnRecon, "PluginEnabled", metav1.ConditionTrue, "PluginEnabled", "Plugin is enabled in Console operator") {
				r.recordEvent(consoleOperatorCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "PluginEnabled", "Plugin is enabled in Console operator")
			}
		} else {
			if r.updateCondition(consoleOperatorCtx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "PluginEnabling", "Plugin is being enabled in Console operator") {
				r.recordEvent(consoleOperatorCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "PluginEnabling", "Plugin is being enabled in Console operator")
			}
		}
	} else {
		pluginDisabledCtx := withReconcilePhase(ctx, "plugin-disabled")
		if r.updateCondition(pluginDisabledCtx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "PluginDisabled", "Plugin is disabled") {
			r.recordEvent(pluginDisabledCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "PluginDisabled", "Plugin is disabled")
		}
	}
	r.logMessage(withReconcilePhase(ctx, "complete"), policy, operatorLogLevelDebug, "Reconcile completed successfully")

	return reconcile.Result{}, nil
}

func (r *OvnReconReconciler) primaryInstance(ctx context.Context) (*reconv1beta1.OvnRecon, error) {
	list := &reconv1beta1.OvnReconList{}
	if err := r.List(ctx, list); err != nil {
		return nil, err
	}

	return selectPrimaryInstance(list.Items), nil
}

func selectPrimaryInstance(items []reconv1beta1.OvnRecon) *reconv1beta1.OvnRecon {
	if len(items) == 0 {
		return nil
	}

	sort.Slice(items, func(i, j int) bool {
		ti := items[i].CreationTimestamp
		tj := items[j].CreationTimestamp
		if !ti.Equal(&tj) {
			return ti.Before(&tj)
		}
		if items[i].Namespace != items[j].Namespace {
			return items[i].Namespace < items[j].Namespace
		}
		return items[i].Name < items[j].Name
	})

	return &items[0]
}

func (r *OvnReconReconciler) reconcileDeployment(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, deployment, func() error {
		desired := DesiredDeployment(ovnRecon)
		ensureManagedLabels(deployment, desired.Labels)
		if err := setManagedOwner(ovnRecon, deployment, r.Scheme); err != nil {
			return err
		}
		deployment.Annotations = mergeStringMap(deployment.Annotations, desired.Annotations)
		deployment.Spec = desired.Spec

		return nil
	})
	return err
}

func (r *OvnReconReconciler) reconcileService(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)

	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
		desired := DesiredService(ovnRecon)
		ensureManagedLabels(service, desired.Labels)
		if err := setManagedOwner(ovnRecon, service, r.Scheme); err != nil {
			return err
		}
		service.Annotations = mergeStringMap(service.Annotations, desired.Annotations)
		service.Spec = desired.Spec
		return nil
	})
	return err
}

func (r *OvnReconReconciler) reconcileCollectorDeployment(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon, eventPolicy operatorEventPolicy) error {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}

	if err := r.reconcileManagedCachePVC(ctx, ovnRecon); err != nil {
		return err
	}

	// Resolve the effective cache storage: the claim's bound state and the
	// viability of its StorageClass decide auto-mode fallback, and the
	// claim's access modes decide the rollout strategy.
	var cachePVC *corev1.PersistentVolumeClaim
	if collectorCacheWantsPVC(ovnRecon) {
		pvc := &corev1.PersistentVolumeClaim{}
		key := client.ObjectKey{Namespace: namespace, Name: collectorCacheClaimNameFor(ovnRecon)}
		if err := r.Get(ctx, key, pvc); err == nil {
			cachePVC = pvc
		} else if !errors.IsNotFound(err) {
			return err
		}
	}
	scViable, err := r.cacheStorageClassViable(ctx, ovnRecon)
	if err != nil {
		return err
	}
	cacheStorage := ResolveCollectorCacheStorage(ovnRecon, cachePVC, scViable, time.Now())
	if cacheStorage.fallbackReason != "" {
		log.FromContext(ctx).Info("collector cache falling back to EmptyDir", "reason", cacheStorage.fallbackReason)
		r.recordEvent(ctx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "CollectorCacheFallback", cacheStorage.fallbackReason)
	}

	_, err = controllerutil.CreateOrUpdate(ctx, r.Client, deployment, func() error {
		desired := DesiredCollectorDeployment(ovnRecon, &cacheStorage)
		ensureManagedLabels(deployment, desired.Labels)
		if err := setManagedOwner(ovnRecon, deployment, r.Scheme); err != nil {
			return err
		}
		deployment.Annotations = mergeStringMap(deployment.Annotations, desired.Annotations)
		deployment.Spec = desired.Spec
		return nil
	})
	return err
}

// reconcileManagedCachePVC creates and owns the cache claim in managed mode,
// and removes a previously managed claim when management is explicitly
// turned off. PVC spec is immutable after creation, so updates only maintain
// labels; the claim also survives a collector disable and an explicit
// EmptyDir mode (like the Service) so the cache stays warm across toggles,
// and CR deletion GCs it via owner ref.
func (r *OvnReconReconciler) reconcileManagedCachePVC(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)

	if !collectorCacheManagedFor(ovnRecon) {
		// Clean up a claim we managed earlier, identified by our labels;
		// never touch user-provided claims.
		pvc := &corev1.PersistentVolumeClaim{}
		key := client.ObjectKey{Namespace: namespace, Name: collectorCacheClaimNameFor(ovnRecon)}
		if err := r.Get(ctx, key, pvc); err != nil {
			if errors.IsNotFound(err) {
				return nil
			}
			return err
		}
		if pvc.Labels["app.kubernetes.io/component"] != "collector-cache" ||
			pvc.Labels["app.kubernetes.io/instance"] != ovnRecon.Name {
			return nil
		}
		if err := r.Delete(ctx, pvc); err != nil && !errors.IsNotFound(err) {
			return err
		}
		return nil
	}

	// Explicit EmptyDir mode: no PVC is created or mounted, but an existing
	// managed claim stays (dormant) so its cache survives a mode toggle.
	if collectorCacheStorageModeFor(ovnRecon) == cacheStorageModeEmptyDir {
		return nil
	}
	// Managed but the cache is off entirely: nothing to create (an existing
	// claim stays, same as the collector-disable case).
	if !collectorCacheWantsPVC(ovnRecon) {
		return nil
	}

	desired := DesiredCollectorCachePVC(ovnRecon)
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      desired.Name,
			Namespace: desired.Namespace,
		},
	}
	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, pvc, func() error {
		ensureManagedLabels(pvc, desired.Labels)
		if err := setManagedOwner(ovnRecon, pvc, r.Scheme); err != nil {
			return err
		}
		if pvc.CreationTimestamp.IsZero() {
			pvc.Spec = desired.Spec
		}
		return nil
	})
	return err
}

// cacheStorageClassViable reports whether the managed cache claim has a
// StorageClass that could provision it: the named class when set, else any
// class annotated as the cluster default. Only auto-mode managed claims
// consult this (explicit PVC mode is honored regardless), so everything else
// short-circuits to true. Live reads by design — see ManagerClientOptions.
func (r *OvnReconReconciler) cacheStorageClassViable(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) (bool, error) {
	if collectorCacheStorageModeFor(ovnRecon) != cacheStorageModeAuto || !collectorCacheManagedFor(ovnRecon) {
		return true, nil
	}
	if className := strings.TrimSpace(ovnRecon.Spec.Collector.Cache.Storage.StorageClassName); className != "" {
		sc := &storagev1.StorageClass{}
		if err := r.Get(ctx, client.ObjectKey{Name: className}, sc); err != nil {
			if errors.IsNotFound(err) || meta.IsNoMatchError(err) {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}
	classes := &storagev1.StorageClassList{}
	if err := r.List(ctx, classes); err != nil {
		if meta.IsNoMatchError(err) {
			// No storage.k8s.io API at all (bare envtest): nothing can provision.
			return false, nil
		}
		return false, err
	}
	for _, sc := range classes.Items {
		if sc.Annotations["storageclass.kubernetes.io/is-default-class"] == "true" {
			return true, nil
		}
	}
	return false, nil
}

func (r *OvnReconReconciler) reconcileCollectorAccessControls(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	saName := collectorServiceAccountName(ovnRecon)

	serviceAccount := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      saName,
			Namespace: namespace,
		},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, serviceAccount, func() error {
		ensureManagedLabels(serviceAccount, labelsForOvnRecon(ovnRecon.Name))
		if err := setManagedOwner(ovnRecon, serviceAccount, r.Scheme); err != nil {
			return err
		}
		return nil
	}); err != nil {
		return err
	}

	clusterRole := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{
			Name: collectorClusterRoleName(ovnRecon),
		},
	}
	if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, clusterRole, func() error {
		ensureManagedLabels(clusterRole, labelsForOvnRecon(ovnRecon.Name))
		if err := setManagedOwner(ovnRecon, clusterRole, r.Scheme); err != nil {
			return err
		}
		clusterRole.Rules = []rbacv1.PolicyRule{
			{
				APIGroups: []string{""},
				Resources: []string{"pods"},
				Verbs:     []string{"get", "list", "watch"},
			},
			{
				APIGroups: []string{""},
				Resources: []string{"pods/exec"},
				Verbs:     []string{"create"},
			},
		}
		return nil
	}); err != nil {
		return err
	}

	probeNamespaces := collectorProbeNamespacesFor(ovnRecon)
	for _, probeNamespace := range probeNamespaces {
		probeNamespace = strings.TrimSpace(probeNamespace)
		if probeNamespace == "" {
			continue
		}
		probeNamespaceObject := &corev1.Namespace{}
		if err := r.Get(ctx, client.ObjectKey{Name: probeNamespace}, probeNamespaceObject); err != nil {
			if errors.IsNotFound(err) {
				log.FromContext(ctx).Info("Collector probe namespace does not exist; skipping RoleBinding", "namespace", probeNamespace)
				continue
			}
			return err
		}

		roleBinding := &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{
				Name:      collectorRoleBindingName(ovnRecon),
				Namespace: probeNamespace,
			},
		}
		if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, roleBinding, func() error {
			ensureManagedLabels(roleBinding, labelsForOvnRecon(ovnRecon.Name))
			if err := setManagedOwner(ovnRecon, roleBinding, r.Scheme); err != nil {
				return err
			}
			roleBinding.Subjects = []rbacv1.Subject{
				{
					Kind:      rbacv1.ServiceAccountKind,
					Name:      saName,
					Namespace: namespace,
				},
			}
			roleBinding.RoleRef = rbacv1.RoleRef{
				APIGroup: rbacv1.GroupName,
				Kind:     "ClusterRole",
				Name:     collectorClusterRoleName(ovnRecon),
			}
			return nil
		}); err != nil {
			return err
		}
	}

	return nil
}

func (r *OvnReconReconciler) reconcileCollectorService(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)

	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
		desired := DesiredCollectorService(ovnRecon)
		ensureManagedLabels(service, desired.Labels)
		if err := setManagedOwner(ovnRecon, service, r.Scheme); err != nil {
			return err
		}
		service.Annotations = mergeStringMap(service.Annotations, desired.Annotations)
		service.Spec = desired.Spec
		return nil
	})
	return err
}

func (r *OvnReconReconciler) deleteCollectorAccessControls(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)

	serviceAccount := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{
			Name:      collectorServiceAccountName(ovnRecon),
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, serviceAccount); err != nil && !errors.IsNotFound(err) {
		return err
	}

	clusterRole := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{
			Name: collectorClusterRoleName(ovnRecon),
		},
	}
	if err := r.Delete(ctx, clusterRole); err != nil && !errors.IsNotFound(err) {
		return err
	}

	for _, probeNamespace := range collectorProbeNamespacesFor(ovnRecon) {
		roleBinding := &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{
				Name:      collectorRoleBindingName(ovnRecon),
				Namespace: probeNamespace,
			},
		}
		if err := r.Delete(ctx, roleBinding); err != nil && !errors.IsNotFound(err) {
			return err
		}
	}

	return nil
}

// SetupWithManager sets up the controller with the Manager.
func (r *OvnReconReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		// The generation predicate belongs on the OvnRecon watch alone. As a
		// WithEventFilter it also applied to the Namespace watch, where
		// generation is always 0 and the filter is meaningless.
		For(&reconv1beta1.OvnRecon{}, builder.WithPredicates(predicate.GenerationChangedPredicate{})).
		// Metadata-only: reconcileRequestsForProbeNamespace reads nothing but
		// the name, and probe namespaces are cluster resources this operator
		// does not label, so the informer cannot be selector-scoped. Caching
		// names instead of whole Namespace objects is what keeps it cheap.
		WatchesMetadata(
			&corev1.Namespace{},
			handler.EnqueueRequestsFromMapFunc(r.reconcileRequestsForProbeNamespace),
			builder.WithPredicates(probeNamespaceExistencePredicate()),
		).
		// Readiness used to be discovered only by requeueing every 10s. This
		// watch makes it event-driven. It maps by label rather than using
		// Owns() because the operator sets no owner references on managed
		// resources, so Owns() would never fire; the informer is already
		// scoped to this operator's objects by ManagerCacheOptions.
		Watches(
			&appsv1.Deployment{},
			handler.EnqueueRequestsFromMapFunc(r.reconcileRequestsForManagedDeployment),
		).
		Named("ovnrecon").
		Complete(r)
}

// reconcileRequestsForManagedDeployment maps a managed Deployment back to the
// OvnRecon that owns it, via the instance label every managed resource carries.
//
// No owner reference is involved: the operator deliberately sets none, because
// OvnRecon is cluster-scoped and cleanup runs through the finalizer instead.
// That is why this is a label-mapped Watches() rather than Owns().
func (r *OvnReconReconciler) reconcileRequestsForManagedDeployment(_ context.Context, object client.Object) []reconcile.Request {
	if object == nil {
		return nil
	}
	labels := object.GetLabels()
	if labels[ManagedByLabelKey] != ManagedByLabelValue {
		return nil
	}
	instance := strings.TrimSpace(labels["app.kubernetes.io/instance"])
	if instance == "" {
		return nil
	}
	// OvnRecon is cluster-scoped, so the request carries no namespace. Both the
	// plugin and collector Deployments map back to the same CR.
	return []reconcile.Request{{NamespacedName: types.NamespacedName{Name: instance}}}
}

// probeNamespaceExistencePredicate drops Namespace updates. The collector's
// RoleBinding reconciliation only depends on whether a probe namespace exists,
// so create and delete are the only events worth a reconcile; without this,
// every namespace update in the cluster would wake the map function.
func probeNamespaceExistencePredicate() predicate.Predicate {
	return predicate.Funcs{
		UpdateFunc: func(event.UpdateEvent) bool { return false },
	}
}

func (r *OvnReconReconciler) reconcileRequestsForProbeNamespace(ctx context.Context, object client.Object) []reconcile.Request {
	if object == nil {
		return nil
	}
	probeNamespace := strings.TrimSpace(object.GetName())
	if probeNamespace == "" {
		return nil
	}

	ovnReconList := &reconv1beta1.OvnReconList{}
	if err := r.List(ctx, ovnReconList); err != nil {
		log.FromContext(ctx).Error(err, "Failed to list OvnRecon resources for probe namespace event", "namespace", probeNamespace)
		return nil
	}

	requests := make([]reconcile.Request, 0, len(ovnReconList.Items))
	matches := make([]string, 0, len(ovnReconList.Items))
	for i := range ovnReconList.Items {
		ovnRecon := &ovnReconList.Items[i]
		if !collectorFeatureEnabled(ovnRecon) || ovnRecon.DeletionTimestamp != nil {
			continue
		}
		for _, candidate := range collectorProbeNamespacesFor(ovnRecon) {
			if strings.TrimSpace(candidate) != probeNamespace {
				continue
			}
			requests = append(requests, reconcile.Request{
				NamespacedName: types.NamespacedName{
					Namespace: ovnRecon.Namespace,
					Name:      ovnRecon.Name,
				},
			})
			matches = append(matches, ovnReconRef(ovnRecon))
			break
		}
	}

	if len(requests) > 0 {
		log.FromContext(ctx).Info(
			"Collector probe namespace event matched OvnRecon resources; enqueueing reconcile",
			"namespace", probeNamespace,
			"count", len(requests),
			"ovnrecons", strings.Join(matches, ","),
		)
	}

	return requests
}

func labelsForOvnRecon(name string) map[string]string {
	return map[string]string{
		// Must stay in sync with ManagedResourceSelector: this pair is the
		// cache filter for managed Deployments and Services.
		ManagedByLabelKey:              ManagedByLabelValue,
		"app.kubernetes.io/instance":   name,
		"app.kubernetes.io/managed-by": "ovn-recon-operator",
	}
}

func labelsForOvnReconWithVersion(name, version string) map[string]string {
	labels := labelsForOvnRecon(name)
	if version != "" {
		// Ensure version is a valid label value (alphanumeric, -, _, .)
		// If explicit version has invalid chars, we sanitize or drop it.
		// Detailed regex: (([A-Za-z0-9][-A-Za-z0-9_.]*)?[A-Za-z0-9])?
		// For simplicity, we'll replace invalid characters with '-'
		validVersion := sanitizeLabelValue(version)
		if validVersion != "" {
			labels["app.kubernetes.io/version"] = validVersion
		}
	}
	labels["app.kubernetes.io/component"] = "plugin"
	labels["app.kubernetes.io/part-of"] = "openshift-console-plugin"
	return labels
}

func sanitizeLabelValue(value string) string {
	// A simple sanitizer that keeps alphanumeric, '-', '_', '.'
	// and ensures start/end are alphanumeric.
	if value == "" {
		return ""
	}

	// Filter invalid chars
	var clean []rune
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			clean = append(clean, r)
		} else {
			clean = append(clean, '-')
		}
	}

	val := string(clean)

	// Trim non-alphanumeric from start
	for len(val) > 0 {
		first := val[0]
		if !((first >= 'a' && first <= 'z') || (first >= 'A' && first <= 'Z') || (first >= '0' && first <= '9')) {
			val = val[1:]
		} else {
			break
		}
	}

	// Trim non-alphanumeric from end
	for len(val) > 0 {
		last := val[len(val)-1]
		if !((last >= 'a' && last <= 'z') || (last >= 'A' && last <= 'Z') || (last >= '0' && last <= '9')) {
			val = val[:len(val)-1]
		} else {
			break
		}
	}

	return val
}

func targetNamespace(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.TargetNamespace != "" {
		return ovnRecon.Spec.TargetNamespace
	}
	return defaultNamespace
}

func collectorName(ovnRecon *reconv1beta1.OvnRecon) string {
	return ovnRecon.Name + "-collector"
}

func collectorServiceAccountName(ovnRecon *reconv1beta1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorClusterRoleName(ovnRecon *reconv1beta1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorRoleBindingName(ovnRecon *reconv1beta1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorFeatureEnabled(ovnRecon *reconv1beta1.OvnRecon) bool {
	if ovnRecon.Spec.Collector.Enabled != nil {
		return *ovnRecon.Spec.Collector.Enabled
	}
	// Default ON when unset — only spec.collector.enabled is an explicit
	// signal. (The removed legacy featureGates.ovn-collector bool could not
	// express "unset" and is pruned from stored objects by the CRD schema.)
	return true
}

func imageTagFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.ConsolePlugin.Image.Tag != "" {
		return ovnRecon.Spec.ConsolePlugin.Image.Tag
	}
	// Use operator version as default tag if available.
	if version := normalizedOperatorVersion(os.Getenv("OPERATOR_VERSION")); version != "" {
		return version
	}
	return defaultImageTag
}

func normalizedOperatorVersion(raw string) string {
	version := strings.TrimSpace(raw)
	if version == "" || version == "dev" {
		return ""
	}
	if !strings.Contains(version, ":") {
		return version
	}

	// Defensively recover the leading version when OPERATOR_VERSION is
	// accidentally rendered as "<version>:<image-ref>".
	leading, _, found := strings.Cut(version, ":")
	if !found {
		return ""
	}
	leading = strings.TrimSpace(leading)
	if leading == "" || leading == "dev" {
		return ""
	}
	return leading
}

func operatorVersionAnnotations() map[string]string {
	version := normalizedOperatorVersion(os.Getenv("OPERATOR_VERSION"))
	if version == "" {
		version = "dev"
	}
	return map[string]string{
		"ovnrecon.bewley.net/operator-version": version,
	}
}

func (r *OvnReconReconciler) reconcileConsolePlugin(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	operatorAnnotations := operatorVersionAnnotations()
	plugin := &unstructured.Unstructured{}
	plugin.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "console.openshift.io",
		Version: "v1",
		Kind:    "ConsolePlugin",
	})
	plugin.SetName(ovnRecon.Name)

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, plugin, func() error {
		desired := DesiredConsolePlugin(ovnRecon)
		if spec, ok := desired.Object["spec"]; ok {
			plugin.Object["spec"] = spec
		}
		if len(operatorAnnotations) > 0 {
			if err := unstructured.SetNestedStringMap(plugin.Object, operatorAnnotations, "metadata", "annotations"); err != nil {
				return err
			}
		}
		// ConsolePlugin is cluster-scoped, and so is OvnRecon, which is exactly
		// what makes an owner reference valid here. The finalizer still drives
		// cleanup because it must de-register the plugin from the Console
		// operator before this object goes away, and garbage collection gives
		// no such ordering.
		return setManagedOwner(ovnRecon, plugin, r.Scheme)
	})
	return err
}

func (r *OvnReconReconciler) reconcileConsoleOperator(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) (bool, error) {
	console := &unstructured.Unstructured{}
	console.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "operator.openshift.io",
		Version: "v1",
		Kind:    "Console",
	})
	console.SetName("cluster") // The singleton console operator instance

	err := r.Get(ctx, client.ObjectKey{Name: "cluster"}, console)
	if err != nil {
		if errors.IsNotFound(err) {
			return false, fmt.Errorf("Console operator resource not found")
		}
		return false, err
	}

	spec, ok := console.Object["spec"].(map[string]interface{})
	if !ok {
		spec = make(map[string]interface{})
		console.Object["spec"] = spec
	}

	plugins, ok := spec["plugins"].([]interface{})
	if !ok {
		plugins = []interface{}{}
	}

	found := false
	for _, p := range plugins {
		if p == ovnRecon.Name {
			found = true
			break
		}
	}

	if !found {
		plugins = append(plugins, ovnRecon.Name)
		spec["plugins"] = plugins
		err = r.Update(ctx, console)
		if err != nil {
			return false, err
		}
		return false, nil // Not yet enabled, but update in progress
	}

	// Check status to see if plugin is actually enabled
	status, ok := console.Object["status"].(map[string]interface{})
	if ok {
		conditions, ok := status["conditions"].([]interface{})
		if ok {
			for _, cond := range conditions {
				condMap, ok := cond.(map[string]interface{})
				if ok {
					if condMap["type"] == "Available" && condMap["status"] == "True" {
						return true, nil
					}
				}
			}
		}
	}

	return true, nil // Plugin is in the list, assume enabled
}

func (r *OvnReconReconciler) checkDeploymentReady(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) (bool, error) {
	deployment := &appsv1.Deployment{}
	err := r.Get(ctx, types.NamespacedName{
		Name:      ovnRecon.Name,
		Namespace: targetNamespace(ovnRecon),
	}, deployment)
	if err != nil {
		if errors.IsNotFound(err) {
			return false, nil
		}
		return false, err
	}

	if deployment.Status.ReadyReplicas == *deployment.Spec.Replicas && *deployment.Spec.Replicas > 0 {
		return true, nil
	}
	return false, nil
}

func (r *OvnReconReconciler) handleDeletion(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) (reconcile.Result, error) {
	log := log.FromContext(ctx)

	if controllerutil.ContainsFinalizer(ovnRecon, finalizerName) {
		// Managed resources now carry owner references, but the finalizer still
		// deletes them explicitly: garbage collection is asynchronous and
		// unordered, and removePluginFromConsole below must run before the
		// ConsolePlugin is removed. GC is the backstop for when this never runs.
		if err := r.deleteNamespacedResources(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to delete namespaced resources")
			return reconcile.Result{}, err
		}

		// Remove plugin from Console operator
		if consolePluginEnabledFor(ovnRecon) {
			if err := r.removePluginFromConsole(ctx, ovnRecon); err != nil {
				log.Error(err, "Failed to remove plugin from Console operator")
				return reconcile.Result{}, err
			}
		}

		// Delete ConsolePlugin
		plugin := &unstructured.Unstructured{}
		plugin.SetGroupVersionKind(schema.GroupVersionKind{
			Group:   "console.openshift.io",
			Version: "v1",
			Kind:    "ConsolePlugin",
		})
		plugin.SetName(ovnRecon.Name)

		if err := r.Get(ctx, client.ObjectKey{Name: ovnRecon.Name}, plugin); err == nil {
			if err := r.Delete(ctx, plugin); err != nil && !errors.IsNotFound(err) {
				log.Error(err, "Failed to delete ConsolePlugin")
				return reconcile.Result{}, err
			}
		}

		// Remove finalizer
		controllerutil.RemoveFinalizer(ovnRecon, finalizerName)
		if err := r.Update(ctx, ovnRecon); err != nil {
			return reconcile.Result{}, err
		}
	}

	return reconcile.Result{}, nil
}

func (r *OvnReconReconciler) ensureTargetNamespaceExists(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	ns := &corev1.Namespace{}
	err := r.Get(ctx, client.ObjectKey{Name: targetNamespace(ovnRecon)}, ns)
	if err == nil {
		return nil
	}
	return err
}

func (r *OvnReconReconciler) deleteNamespacedResources(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, deployment); err != nil && !errors.IsNotFound(err) {
		return err
	}

	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, service); err != nil && !errors.IsNotFound(err) {
		return err
	}

	if err := r.deleteCollectorResources(ctx, ovnRecon); err != nil {
		return err
	}
	if err := r.deleteCollectorAccessControls(ctx, ovnRecon); err != nil {
		return err
	}

	return nil
}

func (r *OvnReconReconciler) deleteCollectorDeployment(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, deployment); err != nil && !errors.IsNotFound(err) {
		return err
	}

	return nil
}

func (r *OvnReconReconciler) deleteCollectorResources(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, deployment); err != nil && !errors.IsNotFound(err) {
		return err
	}

	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}
	if err := r.Delete(ctx, service); err != nil && !errors.IsNotFound(err) {
		return err
	}

	return nil
}

func (r *OvnReconReconciler) removePluginFromConsole(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	console := &unstructured.Unstructured{}
	console.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "operator.openshift.io",
		Version: "v1",
		Kind:    "Console",
	})
	console.SetName("cluster")

	err := r.Get(ctx, client.ObjectKey{Name: "cluster"}, console)
	if err != nil {
		if errors.IsNotFound(err) {
			return nil // Console operator not found, nothing to clean up
		}
		return err
	}

	spec, ok := console.Object["spec"].(map[string]interface{})
	if !ok {
		return nil // No spec, nothing to clean up
	}

	plugins, ok := spec["plugins"].([]interface{})
	if !ok {
		return nil // No plugins, nothing to clean up
	}

	// Remove plugin from list
	newPlugins := []interface{}{}
	for _, p := range plugins {
		if p != ovnRecon.Name {
			newPlugins = append(newPlugins, p)
		}
	}

	if len(newPlugins) != len(plugins) {
		spec["plugins"] = newPlugins
		return r.Update(ctx, console)
	}

	return nil
}

// reconcileStepFailed converts a failed reconcile step into a result.
//
// A write conflict is the expected outcome of optimistic concurrency, not a
// failure. CreateOrUpdate reads through the cache, and the managed-Deployment
// watch fires reconciles precisely while the deployment controller is rewriting
// that object's status, so the cached read can lose the race. Requeue quietly
// and let the next attempt see the fresh object; logging an error and posting a
// Warning event here would put one of each on the CR for every rollout.
//
// Any other error is a real failure and still gets the log, the event, and the
// False condition. Pass an empty conditionType to skip the condition.
func (r *OvnReconReconciler) reconcileStepFailed(
	ctx context.Context,
	ovnRecon *reconv1beta1.OvnRecon,
	policy operatorLogLevel,
	eventPolicy operatorEventPolicy,
	err error,
	message, reason, conditionType string,
) (reconcile.Result, error) {
	if errors.IsConflict(err) {
		r.logMessage(ctx, policy, operatorLogLevelDebug,
			message+": object modified concurrently, requeueing", "error", err.Error())
		return reconcile.Result{Requeue: true}, nil
	}

	log.FromContext(ctx).Error(err, message)
	r.recordEvent(ctx, ovnRecon, eventPolicy, corev1.EventTypeWarning, reason, err.Error())
	if conditionType != "" {
		r.updateCondition(ctx, ovnRecon, conditionType, metav1.ConditionFalse, reason, err.Error())
	}
	// Return a zero Result alongside the error. controller-runtime discards the
	// Result whenever the error is non-nil and requeues with the workqueue's
	// exponential backoff instead, so a RequeueAfter here would be dead code
	// that also trips a "returned both a non-zero result and a non-nil error"
	// warning on every failure. See TestReconcileNeverReturnsResultWithError.
	return reconcile.Result{}, err
}

func (r *OvnReconReconciler) updateCondition(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon, conditionType string, status metav1.ConditionStatus, reason, message string) bool {
	now := metav1.Now()
	condition := metav1.Condition{
		Type:               conditionType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: now,
		ObservedGeneration: ovnRecon.Generation,
	}

	// Find and update existing condition or add new one.
	found := false
	for i, c := range ovnRecon.Status.Conditions {
		if c.Type == conditionType {
			if c.Status == status && c.Reason == reason && c.Message == message && c.ObservedGeneration == ovnRecon.Generation {
				return false
			}
			if c.Status == status {
				condition.LastTransitionTime = c.LastTransitionTime
			}
			ovnRecon.Status.Conditions[i] = condition
			found = true
			break
		}
	}
	if !found {
		ovnRecon.Status.Conditions = append(ovnRecon.Status.Conditions, condition)
	}

	// Update status.
	if err := r.Status().Update(ctx, ovnRecon); err != nil {
		log.FromContext(ctx).Error(err, "Failed to update status conditions")
		return false
	}
	return true
}
