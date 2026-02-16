package probe

import (
	"bytes"
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/kubernetes/scheme"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
)

// KubernetesExecRunnerFactory creates node-scoped runners that execute probe commands in-cluster.
type KubernetesExecRunnerFactory struct {
	clientset        kubernetes.Interface
	restConfig       *rest.Config
	targetNamespaces []string
	logger           *slog.Logger
}

// NewKubernetesExecRunnerFactory builds a runner factory for in-cluster pod exec.
func NewKubernetesExecRunnerFactory(
	clientset kubernetes.Interface,
	restConfig *rest.Config,
	targetNamespaces []string,
	logger *slog.Logger,
) *KubernetesExecRunnerFactory {
	if logger == nil {
		logger = slog.Default()
	}
	return &KubernetesExecRunnerFactory{
		clientset:        clientset,
		restConfig:       restConfig,
		targetNamespaces: targetNamespaces,
		logger:           logger,
	}
}

// RunnerForNode returns a runner that prefers pods scheduled on the target node.
func (f *KubernetesExecRunnerFactory) RunnerForNode(nodeName string) (Runner, error) {
	if f.clientset == nil || f.restConfig == nil {
		return nil, fmt.Errorf("kubernetes client is not configured")
	}
	if strings.TrimSpace(nodeName) == "" {
		return nil, fmt.Errorf("node name is required")
	}
	return &KubernetesExecRunner{
		clientset:        f.clientset,
		restConfig:       f.restConfig,
		targetNamespaces: slices.Clone(f.targetNamespaces),
		nodeName:         nodeName,
		logger:           f.logger.With("node", nodeName),
	}, nil
}

// KubernetesExecRunner executes OVN commands inside a selected pod/container.
type KubernetesExecRunner struct {
	clientset        kubernetes.Interface
	restConfig       *rest.Config
	targetNamespaces []string
	nodeName         string
	logger           *slog.Logger
}

// Run executes a command in a target pod and returns stdout.
func (r *KubernetesExecRunner) Run(ctx context.Context, command []string) (string, error) {
	if len(command) == 0 {
		return "", fmt.Errorf("empty command")
	}

	targets, err := r.resolveExecTargets(ctx)
	if err != nil {
		return "", err
	}

	var lastErr error
	for _, target := range targets {
		stdout, stderr, execErr := r.execInPod(ctx, target.namespace, target.podName, target.containerName, command)
		if execErr == nil {
			r.logger.Debug(
				"probe command executed successfully",
				"namespace", target.namespace,
				"pod", target.podName,
				"container", target.containerName,
				"command", strings.Join(command, " "),
				"stdoutBytes", len(stdout),
			)
			return stdout, nil
		}

		lastErr = fmt.Errorf("%w; stderr=%s", execErr, strings.TrimSpace(stderr))
		r.logger.Debug(
			"probe command execution attempt failed",
			"namespace", target.namespace,
			"pod", target.podName,
			"container", target.containerName,
			"command", strings.Join(command, " "),
			"error", execErr,
			"stderr", strings.TrimSpace(stderr),
		)
	}

	if lastErr == nil {
		return "", fmt.Errorf("no exec targets were resolved")
	}
	return "", fmt.Errorf("probe exec failed on all targets: %w", lastErr)
}

type execTarget struct {
	namespace     string
	podName       string
	containerName string
}

func (r *KubernetesExecRunner) resolveExecTargets(ctx context.Context) ([]execTarget, error) {
	var preferred []execTarget
	var fallback []execTarget

	for _, namespace := range r.targetNamespaces {
		namespace = strings.TrimSpace(namespace)
		if namespace == "" {
			continue
		}

		podList, err := r.clientset.CoreV1().Pods(namespace).List(ctx, metav1.ListOptions{
			FieldSelector: "status.phase=Running",
		})
		if err != nil {
			r.logger.Warn("failed to list pods for probe namespace", "namespace", namespace, "error", err)
			continue
		}

		for _, pod := range podList.Items {
			targets := podExecTargets(namespace, &pod)
			if len(targets) == 0 {
				continue
			}

			if pod.Spec.NodeName == r.nodeName {
				preferred = append(preferred, targets...)
			} else {
				fallback = append(fallback, targets...)
			}
		}
	}

	if len(preferred) == 0 && len(fallback) == 0 {
		return nil, fmt.Errorf(
			"no running pods available for probe in namespaces %q on node %q",
			strings.Join(r.targetNamespaces, ","),
			r.nodeName,
		)
	}

	if len(preferred) > 0 {
		return append(preferred, fallback...), nil
	}
	return fallback, nil
}

func podExecTargets(namespace string, pod *corev1.Pod) []execTarget {
	targets := make([]execTarget, 0, len(pod.Spec.Containers))
	for _, container := range pod.Spec.Containers {
		targets = append(targets, execTarget{
			namespace:     namespace,
			podName:       pod.Name,
			containerName: container.Name,
		})
	}
	return targets
}

func (r *KubernetesExecRunner) execInPod(
	ctx context.Context,
	namespace string,
	podName string,
	containerName string,
	command []string,
) (string, string, error) {
	req := r.clientset.CoreV1().RESTClient().Post().
		Resource("pods").
		Namespace(namespace).
		Name(podName).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: containerName,
			Command:   command,
			Stdout:    true,
			Stderr:    true,
		}, scheme.ParameterCodec)

	executor, err := remotecommand.NewSPDYExecutor(r.restConfig, "POST", req.URL())
	if err != nil {
		return "", "", fmt.Errorf("create spdy executor: %w", err)
	}

	var stdout bytes.Buffer
	var stderr bytes.Buffer
	if err := executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: &stdout,
		Stderr: &stderr,
	}); err != nil {
		return stdout.String(), stderr.String(), err
	}

	return stdout.String(), stderr.String(), nil
}
