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

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	logf "sigs.k8s.io/controller-runtime/pkg/log"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	reconv1alpha1 "github.com/dlbewley/ovn-recon-operator/api/v1alpha1"
)

// OvnReconReconciler reconciles a OvnRecon object
type OvnReconReconciler struct {
	client.Client
	Scheme *runtime.Scheme
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
// TODO(user): Modify the Reconcile function to compare the state specified by
// the OvnRecon object against the actual cluster state, and then
// perform operations to make the cluster state reflect the state specified by
// the user.
//
// For more details, check Reconcile and its Result here:
// - https://pkg.go.dev/sigs.k8s.io/controller-runtime@v0.21.0/pkg/reconcile
func (r *OvnReconReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	log := logf.FromContext(ctx)

	// Fetch the OvnRecon instance
	ovnRecon := &reconv1alpha1.OvnRecon{}
	err := r.Get(ctx, req.NamespacedName, ovnRecon)
	if err != nil {
		if client.IgnoreNotFound(err) == nil {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	// 1. Reconcile Deployment
	if err := r.reconcileDeployment(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Deployment")
		return ctrl.Result{}, err
	}

	// 2. Reconcile Service
	if err := r.reconcileService(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile Service")
		return ctrl.Result{}, err
	}

	// 3. Reconcile ConsolePlugin
	if err := r.reconcileConsolePlugin(ctx, ovnRecon); err != nil {
		log.Error(err, "Failed to reconcile ConsolePlugin")
		return ctrl.Result{}, err
	}

	// 4. Auto-enable plugin in Console operator configuration
	if ovnRecon.Spec.ConsolePlugin.Enabled {
		if err := r.reconcileConsoleOperator(ctx, ovnRecon); err != nil {
			log.Error(err, "Failed to auto-enable plugin in Console operator")
			return ctrl.Result{}, err
		}
	}

	return ctrl.Result{}, nil
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
					Containers: []corev1.Container{{
						Name:  "ovn-recon",
						Image: fmt.Sprintf("%s:%s", ovnRecon.Spec.Image.Repository, ovnRecon.Spec.Image.Tag),
						Ports: []corev1.ContainerPort{{
							ContainerPort: 9443,
							Name:          "https",
						}},
					}},
				},
			},
		}

		if ovnRecon.Spec.Image.PullPolicy != "" {
			deployment.Spec.Template.Spec.Containers[0].ImagePullPolicy = corev1.PullPolicy(ovnRecon.Spec.Image.PullPolicy)
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

		plugin.Object["spec"] = map[string]interface{}{
			"displayName": displayName,
			"service": map[string]interface{}{
				"name":      ovnRecon.Name,
				"namespace": ovnRecon.Namespace,
				"port":      9443,
				"basePath":  "/",
			},
		}
		// Notice: ConsolePlugin is cluster-scoped, so we don't set a controller reference
		// unless we want to use a finalizer or a cross-namespace owner reference (which is tricky).
		return nil
	})
	return err
}

func (r *OvnReconReconciler) reconcileConsoleOperator(ctx context.Context, ovnRecon *reconv1alpha1.OvnRecon) error {
	console := &unstructured.Unstructured{}
	console.SetGroupVersionKind(schema.GroupVersionKind{
		Group:   "operator.openshift.io",
		Version: "v1",
		Kind:    "Console",
	})
	console.SetName("cluster") // The singleton console operator instance

	err := r.Get(ctx, client.ObjectKey{Name: "cluster"}, console)
	if err != nil {
		return err
	}

	spec, ok := console.Object["spec"].(map[string]interface{})
	if !ok {
		spec = make(map[string]interface{})
		console.Object["spec"] = spec
	}

	plugins, _ := spec["plugins"].([]interface{})
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
		return r.Update(ctx, console)
	}

	return nil
}
