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

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

const (
	finalizerName    = "ovnrecon.bewley.net/finalizer"
	defaultNamespace = "ovn-recon"
	defaultImageRepository = "quay.io/dbewley/ovn-recon"
	defaultImageTag  = "latest"
)

// OvnReconReconciler reconciles a OvnRecon object
type OvnReconReconciler struct {
	client.Client
	Scheme   *runtime.Scheme
	Recorder record.EventRecorder
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
	log := log.FromContext(ctx)

	// Fetch the OvnRecon instance
	ovnRecon := &reconv1alpha1.OvnRecon{}
	err := r.Get(ctx, req.NamespacedName, ovnRecon)
	if err != nil {
		if errors.IsNotFound(err) {
			return reconcile.Result{}, nil
		}
		return reconcile.Result{}, err
	}

	// Handle deletion
	if !ovnRecon.DeletionTimestamp.IsZero() {
		return r.handleDeletion(ctx, ovnRecon)
	}

	primary, err := r.isPrimaryInstance(ctx, ovnRecon)
	if err != nil {
		log.Error(err, "Failed to determine primary OvnRecon instance")
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	if !primary {
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "NotPrimary", "Another OvnRecon instance is already active")
		r.updateCondition(ctx, ovnRecon, "Available", metav1.ConditionFalse, "NotPrimary", "Another OvnRecon instance is already active")
		r.updateCondition(ctx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "NotPrimary", "Another OvnRecon instance is already active")
		return reconcile.Result{RequeueAfter: time.Minute * 2}, nil
	}

	// Add finalizer if not present
	if !controllerutil.ContainsFinalizer(ovnRecon, finalizerName) {
		controllerutil.AddFinalizer(ovnRecon, finalizerName)
		if err := r.Update(ctx, ovnRecon); err != nil {
			return reconcile.Result{}, err
		}
	}

	// Initialize status conditions if needed
	if ovnRecon.Status.Conditions == nil {
		ovnRecon.Status.Conditions = []metav1.Condition{}
	}

	// Require target namespace to exist for namespaced resources.
	if err := r.ensureTargetNamespaceExists(ctx, ovnRecon); err != nil {
		log.Error(err, "Target namespace does not exist")
		r.updateCondition(ctx, ovnRecon, "NamespaceReady", metav1.ConditionFalse, "NamespaceNotFound", err.Error())
		return reconcile.Result{RequeueAfter: time.Minute}, nil
	}
	r.updateCondition(ctx, ovnRecon, "NamespaceReady", metav1.ConditionTrue, "NamespaceFound", "Target namespace exists")

	// 1. Reconcile Deployment
	if err := r.reconcileDeployment(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Deployment")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "DeploymentReconcileFailed", err.Error())
		r.updateCondition(ctx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}

	// 2. Reconcile Service
	if err := r.reconcileService(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Service")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "ServiceReconcileFailed", err.Error())
		r.updateCondition(ctx, ovnRecon, "ServiceReady", metav1.ConditionFalse, "ServiceReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	r.updateCondition(ctx, ovnRecon, "ServiceReady", metav1.ConditionTrue, "ServiceReady", "Service is ready")

	// 2.5 Reconcile collector resources behind feature gate.
	if collectorFeatureEnabled(ovnRecon) {
		if err := r.reconcileCollectorAccessControls(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to reconcile collector access controls")
			r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "CollectorRBACReconcileFailed", err.Error())
			r.updateCondition(ctx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorRBACReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if err := r.reconcileCollectorDeployment(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to reconcile collector Deployment")
			r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "CollectorDeploymentReconcileFailed", err.Error())
			r.updateCondition(ctx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorDeploymentReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if err := r.reconcileCollectorService(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to reconcile collector Service")
			r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "CollectorServiceReconcileFailed", err.Error())
			r.updateCondition(ctx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorServiceReconcileFailed", err.Error())
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		r.updateCondition(ctx, ovnRecon, "CollectorReady", metav1.ConditionTrue, "CollectorReady", "Collector resources are reconciled")
	} else {
		if err := r.deleteCollectorResources(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to delete collector resources while feature gate is disabled")
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if err := r.deleteCollectorAccessControls(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to delete collector RBAC while feature gate is disabled")
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		r.updateCondition(ctx, ovnRecon, "CollectorReady", metav1.ConditionFalse, "CollectorFeatureDisabled", "Collector feature gate is disabled")
	}

	// 3. Reconcile ConsolePlugin
	if err := r.reconcileConsolePlugin(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile ConsolePlugin")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "ConsolePluginReconcileFailed", err.Error())
		r.updateCondition(ctx, ovnRecon, "ConsolePluginReady", metav1.ConditionFalse, "ConsolePluginReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}
	r.updateCondition(ctx, ovnRecon, "ConsolePluginReady", metav1.ConditionTrue, "ConsolePluginReady", "ConsolePlugin is ready")

	// Check deployment status after the service is in place.
	deploymentReady, err := r.checkDeploymentReady(ctx, ovnRecon)
	if err != nil {
		log.Error(err, "Failed to check Deployment status")
		return reconcile.Result{RequeueAfter: time.Second * 10}, err
	}

	if deploymentReady {
		r.updateCondition(ctx, ovnRecon, "Available", metav1.ConditionTrue, "DeploymentReady", "Deployment is ready")
	} else {
		r.updateCondition(ctx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentNotReady", "Deployment is not ready")
		return reconcile.Result{RequeueAfter: time.Second * 10}, nil
	}

	// 4. Auto-enable plugin in Console operator configuration
	if ovnRecon.Spec.ConsolePlugin.Enabled {
		enabled, err := r.reconcileConsoleOperator(ctx, ovnRecon)
		if err != nil {
			log.Error(err, "Failed to auto-enable plugin in Console operator")
			r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "ConsoleOperatorUpdateFailed", err.Error())
			// Retry on conflict
			if errors.IsConflict(err) {
				return reconcile.Result{Requeue: true}, nil
			}
			return reconcile.Result{RequeueAfter: time.Second * 30}, err
		}
		if enabled {
			r.updateCondition(ctx, ovnRecon, "PluginEnabled", metav1.ConditionTrue, "PluginEnabled", "Plugin is enabled in Console operator")
		} else {
			r.updateCondition(ctx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "PluginEnabling", "Plugin is being enabled in Console operator")
		}
	} else {
		r.updateCondition(ctx, ovnRecon, "PluginEnabled", metav1.ConditionFalse, "PluginDisabled", "Plugin is disabled")
	}

	return reconcile.Result{}, nil
}

func (r *OvnReconReconciler) isPrimaryInstance(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) (bool, error) {
	list := &reconv1alpha1.OvnReconList{}
	if err := r.List(ctx, list); err != nil {
		return false, err
	}
	if len(list.Items) <= 1 {
		return true, nil
	}

	sort.Slice(list.Items, func(i, j int) bool {
		ti := list.Items[i].CreationTimestamp
		tj := list.Items[j].CreationTimestamp
		if !ti.Equal(&tj) {
			return ti.Before(&tj)
		}
		if list.Items[i].Namespace != list.Items[j].Namespace {
			return list.Items[i].Namespace < list.Items[j].Namespace
		}
		return list.Items[i].Name < list.Items[j].Name
	})

	primary := list.Items[0]
	return ovnRecon.Namespace == primary.Namespace && ovnRecon.Name == primary.Name, nil
}

func (r *OvnReconReconciler) reconcileDeployment(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) reconcileService(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) reconcileCollectorDeployment(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) reconcileCollectorAccessControls(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) reconcileCollectorService(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) deleteCollectorAccessControls(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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
		For(&reconv1alpha1.OvnRecon{}).
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

func targetNamespace(ovnRecon *reconv1alpha1.OvnRecon) string {
	if ovnRecon.Spec.TargetNamespace != "" {
		return ovnRecon.Spec.TargetNamespace
	}
	return defaultNamespace
}

func collectorName(ovnRecon *reconv1alpha1.OvnRecon) string {
	return ovnRecon.Name + "-collector"
}

func collectorServiceAccountName(ovnRecon *reconv1alpha1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorClusterRoleName(ovnRecon *reconv1alpha1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorRoleBindingName(ovnRecon *reconv1alpha1.OvnRecon) string {
	return collectorName(ovnRecon)
}

func collectorFeatureEnabled(ovnRecon *reconv1alpha1.OvnRecon) bool {
	return ovnRecon.Spec.FeatureGates.OVNCollector
}

func imageTagFor(ovnRecon *reconv1alpha1.OvnRecon) string {
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

func (r *OvnReconReconciler) reconcileConsolePlugin(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) reconcileConsoleOperator(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) (bool, error) {
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

func (r *OvnReconReconciler) checkDeploymentReady(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) (bool, error) {
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

func (r *OvnReconReconciler) handleDeletion(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) (reconcile.Result, error) {
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

func (r *OvnReconReconciler) ensureTargetNamespaceExists(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
	ns := &corev1.Namespace{}
	err := r.Get(ctx, client.ObjectKey{Name: targetNamespace(ovnRecon)}, ns)
	if err == nil {
		return nil
	}
	return err
}

func (r *OvnReconReconciler) deleteNamespacedResources(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) deleteCollectorResources(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) removePluginFromConsole(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
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

func (r *OvnReconReconciler) updateCondition(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon, conditionType string, status metav1.ConditionStatus, reason, message string) {
	now := metav1.Now()
	condition := metav1.Condition{
		Type:               conditionType,
		Status:             status,
		Reason:             reason,
		Message:            message,
		LastTransitionTime: now,
		ObservedGeneration: ovnRecon.Generation,
	}

	// Find and update existing condition or add new one
	found := false
	for i, c := range ovnRecon.Status.Conditions {
		if c.Type == conditionType {
			ovnRecon.Status.Conditions[i] = condition
			found = true
			break
		}
	}
	if !found {
		ovnRecon.Status.Conditions = append(ovnRecon.Status.Conditions, condition)
	}

	// Update status
	if err := r.Status().Update(ctx, ovnRecon); err != nil {
		log.FromContext(ctx).Error(err, "Failed to update status conditions")
	}
}
