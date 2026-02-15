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
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/tools/record"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
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
// +kubebuilder:rbac:groups=apps,resources=deployments,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=services,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=serviceaccounts,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups="",resources=pods,verbs=get;list;watch
// +kubebuilder:rbac:groups="",resources=pods/exec,verbs=create
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=clusterroles,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=rbac.authorization.k8s.io,resources=rolebindings,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=console.openshift.io,resources=consoleplugins,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=operator.openshift.io,resources=consoles,verbs=get;list;watch;update;patch

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
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
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
		log.FromContext(deploymentCtx).Error(err, "Failed to reconcile Deployment")
		r.recordEvent(deploymentCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "DeploymentReconcileFailed", err.Error())
		r.updateCondition(deploymentCtx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	r.logMessage(deploymentCtx, policy, operatorLogLevelTrace, "Deployment reconciled")

	// 2. Reconcile Service
	serviceCtx := withReconcilePhase(ctx, "reconcile-service")
	if err := r.reconcileService(serviceCtx, ovnRecon); err != nil {
		log.FromContext(serviceCtx).Error(err, "Failed to reconcile Service")
		r.recordEvent(serviceCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "ServiceReconcileFailed", err.Error())
		r.updateCondition(serviceCtx, ovnRecon, "ServiceReady", metav1.ConditionFalse, "ServiceReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	if r.updateCondition(serviceCtx, ovnRecon, "ServiceReady", metav1.ConditionTrue, "ServiceReady", "Service is ready") {
		r.recordEvent(serviceCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "ServiceReady", "Service is ready")
	}
	r.logMessage(serviceCtx, policy, operatorLogLevelTrace, "Service reconciled")

	// 2.5 Reconcile collector resources behind feature gate.
	if collectorFeatureEnabled(ovnRecon) {
		collectorRBACCtx := withReconcilePhase(ctx, "reconcile-collector-rbac")
		if err := r.reconcileCollectorAccessControls(collectorRBACCtx, ovnRecon); err != nil {
			log.FromContext(collectorRBACCtx).Error(err, "Failed to reconcile collector access controls")
			r.recordEvent(collectorRBACCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "CollectorRBACReconcileFailed", err.Error())
			r.updateCondition(collectorRBACCtx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorRBACReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		collectorDeploymentCtx := withReconcilePhase(ctx, "reconcile-collector-deployment")
		if err := r.reconcileCollectorDeployment(collectorDeploymentCtx, ovnRecon); err != nil {
			log.FromContext(collectorDeploymentCtx).Error(err, "Failed to reconcile collector Deployment")
			r.recordEvent(collectorDeploymentCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "CollectorDeploymentReconcileFailed", err.Error())
			r.updateCondition(collectorDeploymentCtx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorDeploymentReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		collectorServiceCtx := withReconcilePhase(ctx, "reconcile-collector-service")
		if err := r.reconcileCollectorService(collectorServiceCtx, ovnRecon); err != nil {
			log.FromContext(collectorServiceCtx).Error(err, "Failed to reconcile collector Service")
			r.recordEvent(collectorServiceCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "CollectorServiceReconcileFailed", err.Error())
			r.updateCondition(collectorServiceCtx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorServiceReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if r.updateCondition(collectorServiceCtx, ovnRecon, "CollectorReady", metav1.ConditionTrue, "CollectorReady", "Collector resources are reconciled") {
			r.recordEvent(collectorServiceCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "CollectorReady", "Collector resources are reconciled")
		}
	} else {
		collectorDeleteCtx := withReconcilePhase(ctx, "delete-collector-resources")
		if err := r.deleteCollectorResources(collectorDeleteCtx, ovnRecon); err != nil {
			log.FromContext(collectorDeleteCtx).Error(err, "Failed to delete collector resources while feature gate is disabled")
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		collectorRBACDeleteCtx := withReconcilePhase(ctx, "delete-collector-rbac")
		if err := r.deleteCollectorAccessControls(collectorRBACDeleteCtx, ovnRecon); err != nil {
			log.FromContext(collectorRBACDeleteCtx).Error(err, "Failed to delete collector RBAC while feature gate is disabled")
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if r.updateCondition(collectorRBACDeleteCtx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorFeatureDisabled", "Collector feature gate is disabled") {
			r.recordEvent(collectorRBACDeleteCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "CollectorFeatureDisabled", "Collector feature gate is disabled")
		}
	}

	// 3. Reconcile ConsolePlugin
	consolePluginCtx := withReconcilePhase(ctx, "reconcile-consoleplugin")
	if err := r.reconcileConsolePlugin(consolePluginCtx, ovnRecon); err != nil {
		log.FromContext(consolePluginCtx).Error(err, "Failed to reconcile ConsolePlugin")
		r.recordEvent(consolePluginCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "ConsolePluginReconcileFailed", err.Error())
		r.updateCondition(consolePluginCtx, ovnRecon, "ConsolePluginReady", metav1.ConditionFalse, "ConsolePluginReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	if r.updateCondition(consolePluginCtx, ovnRecon, "ConsolePluginReady", metav1.ConditionTrue, "ConsolePluginReady", "ConsolePlugin is ready") {
		r.recordEvent(consolePluginCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "ConsolePluginReady", "ConsolePlugin is ready")
	}

	// Check deployment status after the service is in place.
	deploymentStatusCtx := withReconcilePhase(ctx, "deployment-status")
	deploymentReady, err := r.checkDeploymentReady(deploymentStatusCtx, ovnRecon)
	if err != nil {
		log.FromContext(deploymentStatusCtx).Error(err, "Failed to check Deployment status")
		return reconcile.Result{RequeueAfter: time.Second * 10}, err
	}

	if deploymentReady {
		if r.updateCondition(deploymentStatusCtx, ovnRecon, "Available", metav1.ConditionTrue, "DeploymentReady", "Deployment is ready") {
			r.recordEvent(deploymentStatusCtx, ovnRecon, eventPolicy, corev1.EventTypeNormal, "DeploymentReady", "Deployment is ready")
		}
	} else {
		r.updateCondition(deploymentStatusCtx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentNotReady", "Deployment is not ready")
		return reconcile.Result{RequeueAfter: time.Second * 10}, nil
	}

	// 4. Auto-enable plugin in Console operator configuration
	if ovnRecon.Spec.ConsolePlugin.Enabled {
		consoleOperatorCtx := withReconcilePhase(ctx, "reconcile-console-operator")
		enabled, err := r.reconcileConsoleOperator(consoleOperatorCtx, ovnRecon)
		if err != nil {
			log.FromContext(consoleOperatorCtx).Error(err, "Failed to auto-enable plugin in Console operator")
			r.recordEvent(consoleOperatorCtx, ovnRecon, eventPolicy, corev1.EventTypeWarning, "ConsoleOperatorUpdateFailed", err.Error())
			// Retry on conflict
			if errors.IsConflict(err) {
				return reconcile.Result{Requeue: true}, nil
			}
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
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
		deployment.Labels = mergeStringMap(deployment.Labels, desired.Labels)
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
		service.Labels = mergeStringMap(service.Labels, desired.Labels)
		service.Annotations = mergeStringMap(service.Annotations, desired.Annotations)
		service.Spec = desired.Spec
		return nil
	})
	return err
}

func (r *OvnReconReconciler) reconcileCollectorDeployment(ctx context.Context, ovnRecon *reconv1beta1.OvnRecon) error {
	namespace := targetNamespace(ovnRecon)
	name := collectorName(ovnRecon)

	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, deployment, func() error {
		desired := DesiredCollectorDeployment(ovnRecon)
		deployment.Labels = mergeStringMap(deployment.Labels, desired.Labels)
		deployment.Annotations = mergeStringMap(deployment.Annotations, desired.Annotations)
		deployment.Spec = desired.Spec
		return nil
	})
	return err
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
		serviceAccount.Labels = mergeStringMap(serviceAccount.Labels, labelsForOvnRecon(ovnRecon.Name))
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
		clusterRole.Labels = mergeStringMap(clusterRole.Labels, labelsForOvnRecon(ovnRecon.Name))
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
		roleBinding := &rbacv1.RoleBinding{
			ObjectMeta: metav1.ObjectMeta{
				Name:      collectorRoleBindingName(ovnRecon),
				Namespace: probeNamespace,
			},
		}
		if _, err := controllerutil.CreateOrUpdate(ctx, r.Client, roleBinding, func() error {
			roleBinding.Labels = mergeStringMap(roleBinding.Labels, labelsForOvnRecon(ovnRecon.Name))
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
		service.Labels = mergeStringMap(service.Labels, desired.Labels)
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
		For(&reconv1beta1.OvnRecon{}).
		Named("ovnrecon").
		WithEventFilter(predicate.GenerationChangedPredicate{}).
		Complete(r)
}

func labelsForOvnRecon(name string) map[string]string {
	return map[string]string{
		"app.kubernetes.io/name":       "ovn-recon",
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
	return ovnRecon.Spec.FeatureGates.OVNCollector
}

func imageTagFor(ovnRecon *reconv1beta1.OvnRecon) string {
	if ovnRecon.Spec.ConsolePlugin.Image.Tag != "" {
		return ovnRecon.Spec.ConsolePlugin.Image.Tag
	}
	if ovnRecon.Spec.Image.Tag != "" {
		return ovnRecon.Spec.Image.Tag
	}
	// Use operator version as default tag if available
	version := os.Getenv("OPERATOR_VERSION")
	// Sanity check: valid tags cannot contain colons.
	// This protects against polluted env vars (e.g. "v0.1.2:quay.io/...")
	if version != "" && version != "dev" && !strings.Contains(version, ":") {
		return version
	}
	return defaultImageTag
}

func operatorVersionAnnotations() map[string]string {
	version := os.Getenv("OPERATOR_VERSION")
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
		// ConsolePlugin is cluster-scoped, so we don't set a controller reference
		// We use finalizers instead for cleanup
		return nil
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
		// Delete namespaced resources (no owner refs with cluster-scoped CRs).
		if err := r.deleteNamespacedResources(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to delete namespaced resources")
			return reconcile.Result{RequeueAfter: time.Second * 10}, err
		}

		// Remove plugin from Console operator
		if ovnRecon.Spec.ConsolePlugin.Enabled {
			if err := r.removePluginFromConsole(ctx, ovnRecon); err != nil {
				log.Error(err, "Failed to remove plugin from Console operator")
				return reconcile.Result{RequeueAfter: time.Second * 10}, err
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
				return reconcile.Result{RequeueAfter: time.Second * 10}, err
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
