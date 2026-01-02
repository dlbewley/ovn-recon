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
	"time"

	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/tools/record"
	"k8s.io/utils/pointer"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"
	"sigs.k8s.io/controller-runtime/pkg/predicate"
	"sigs.k8s.io/controller-runtime/pkg/reconcile"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

const (
	finalizerName = "ovnrecon.bewley.net/finalizer"
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

	// 1. Reconcile Deployment
	if err := r.reconcileDeployment(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Deployment")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "DeploymentReconcileFailed", err.Error())
		r.updateCondition(ctx, ovnRecon, "Available", metav1.ConditionFalse, "DeploymentReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}

	// Check deployment status
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

	// 2. Reconcile Service
	if err := r.reconcileService(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Service")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "ServiceReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
	}

	// 3. Reconcile ConsolePlugin
	if err := r.reconcileConsolePlugin(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile ConsolePlugin")
		r.Recorder.Event(ovnRecon, corev1.EventTypeWarning, "ConsolePluginReconcileFailed", err.Error())
		return reconcile.Result{RequeueAfter: time.Second * 30}, err
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

func (r *OvnReconReconciler) reconcileDeployment(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
	deployment := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: ovnRecon.Namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, deployment, func() error {
		replicas := int32(1)
		pullPolicy := corev1.PullIfNotPresent
		if ovnRecon.Spec.Image.PullPolicy != "" {
			pullPolicy = corev1.PullPolicy(ovnRecon.Spec.Image.PullPolicy)
		}

		imageTag := ovnRecon.Spec.Image.Tag
		if imageTag == "" {
			imageTag = "latest"
		}
		image := fmt.Sprintf("%s:%s", ovnRecon.Spec.Image.Repository, imageTag)

		deployment.Spec = appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{
				MatchLabels: labelsForOvnRecon(ovnRecon.Name),
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{
					Labels: labelsForOvnRecon(ovnRecon.Name),
				},
				Spec: corev1.PodSpec{
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: pointer.Bool(true),
						SeccompProfile: &corev1.SeccompProfile{
							Type: corev1.SeccompProfileTypeRuntimeDefault,
						},
					},
					Containers: []corev1.Container{{
						Name:  "ovn-recon",
						Image: image,
						Ports: []corev1.ContainerPort{{
							ContainerPort: 9443,
							Name:          "https",
							Protocol:      corev1.ProtocolTCP,
						}},
						ImagePullPolicy: pullPolicy,
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: pointer.Bool(false),
							Capabilities: &corev1.Capabilities{
								Drop: []corev1.Capability{"ALL"},
							},
							ReadOnlyRootFilesystem: pointer.Bool(false),
							RunAsNonRoot:          pointer.Bool(true),
							RunAsUser:              pointer.Int64(1001),
						},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("100m"),
								corev1.ResourceMemory: resource.MustParse("128Mi"),
							},
							Limits: corev1.ResourceList{
								corev1.ResourceCPU:    resource.MustParse("500m"),
								corev1.ResourceMemory: resource.MustParse("512Mi"),
							},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path:   "/healthz",
									Port:   intstr.FromInt32(9443),
									Scheme: corev1.URISchemeHTTPS,
								},
							},
							InitialDelaySeconds: 30,
							PeriodSeconds:       10,
							TimeoutSeconds:      5,
							FailureThreshold:    3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler: corev1.ProbeHandler{
								HTTPGet: &corev1.HTTPGetAction{
									Path:   "/readyz",
									Port:   intstr.FromInt32(9443),
									Scheme: corev1.URISchemeHTTPS,
								},
							},
							InitialDelaySeconds: 5,
							PeriodSeconds:       5,
							TimeoutSeconds:      3,
							FailureThreshold:    3,
						},
						VolumeMounts: []corev1.VolumeMount{{
							Name:      "plugin-serving-cert",
							ReadOnly:  true,
							MountPath: "/var/serving-cert",
						}},
					}},
					Volumes: []corev1.Volume{{
						Name: "plugin-serving-cert",
						VolumeSource: corev1.VolumeSource{
							Secret: &corev1.SecretVolumeSource{
								SecretName: "plugin-serving-cert",
								DefaultMode: pointer.Int32(420),
							},
						},
					}},
				},
			},
		}

		return controllerutil.SetControllerReference(ovnRecon, deployment, r.Scheme)
	})
	return err
}

func (r *OvnReconReconciler) reconcileService(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{
			Name:      ovnRecon.Name,
			Namespace: ovnRecon.Namespace,
		},
	}

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, service, func() error {
		service.Spec = corev1.ServiceSpec{
			Selector: labelsForOvnRecon(ovnRecon.Name),
			Ports: []corev1.ServicePort{{
				Port: 9443,
				Name: "https",
			}},
		}
		return controllerutil.SetControllerReference(ovnRecon, service, r.Scheme)
	})
	return err
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

func (r *OvnReconReconciler) reconcileConsolePlugin(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
	plugin := &unstructured.Unstructured{}
	plugin.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "console.openshift.io",
		Version: "v1",
		Kind:    "ConsolePlugin",
	})
	plugin.SetName(ovnRecon.Name)

	_, err := controllerutil.CreateOrUpdate(ctx, r.Client, plugin, func() error {
		displayName := ovnRecon.Spec.ConsolePlugin.DisplayName
		if displayName == "" {
			displayName = "OVN Recon"
		}

		// Use the correct API structure for OpenShift 4.20
		plugin.Object["spec"] = map[string]interface{}{
			"displayName": displayName,
			"backend": map[string]interface{}{
				"type": "Service",
				"service": map[string]interface{}{
					"name":      ovnRecon.Name,
					"namespace": ovnRecon.Namespace,
					"port":      9443,
					"basePath":  "/",
				},
			},
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
		Namespace: ovnRecon.Namespace,
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
