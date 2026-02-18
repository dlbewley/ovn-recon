package controller

import (
	"go/ast"
	"go/parser"
	"go/token"
	"sort"
	"strconv"
	"testing"
)

func TestOperatorEventReasonCatalogIsStable(t *testing.T) {
	t.Helper()

	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "ovnrecon_controller.go", nil, 0)
	if err != nil {
		t.Fatalf("failed to parse controller source: %v", err)
	}

	reasons := map[string]struct{}{}
	ast.Inspect(file, func(n ast.Node) bool {
		call, ok := n.(*ast.CallExpr)
		if !ok {
			return true
		}
		sel, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}

		switch sel.Sel.Name {
		case "updateCondition":
			addReasonFromArg(t, call.Args, 4, reasons)
		case "recordEvent":
			addReasonFromArg(t, call.Args, 4, reasons)
		}
		return true
	})

	expected := []string{
		"CollectorDeploymentReconcileFailed",
		"CollectorFeatureDisabled",
		"CollectorRBACReconcileFailed",
		"CollectorReady",
		"CollectorServiceReconcileFailed",
		"ConsoleOperatorUpdateFailed",
		"ConsolePluginReady",
		"ConsolePluginReconcileFailed",
		"DeploymentNotReady",
		"DeploymentReady",
		"DeploymentReconcileFailed",
		"NamespaceFound",
		"NamespaceNotFound",
		"NotPrimary",
		"PluginDisabled",
		"PluginEnabled",
		"PluginEnabling",
		"ServiceReady",
		"ServiceReconcileFailed",
	}

	var actual []string
	for reason := range reasons {
		actual = append(actual, reason)
	}
	sort.Strings(actual)
	sort.Strings(expected)

	if len(actual) != len(expected) {
		t.Fatalf("reason catalog size mismatch:\nactual=%v\nexpected=%v", actual, expected)
	}
	for i := range actual {
		if actual[i] != expected[i] {
			t.Fatalf("reason catalog mismatch:\nactual=%v\nexpected=%v", actual, expected)
		}
	}
}

func addReasonFromArg(t *testing.T, args []ast.Expr, idx int, set map[string]struct{}) {
	t.Helper()

	if len(args) <= idx {
		return
	}
	lit, ok := args[idx].(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return
	}
	reason, err := strconv.Unquote(lit.Value)
	if err != nil {
		t.Fatalf("failed to unquote reason literal %q: %v", lit.Value, err)
	}
	set[reason] = struct{}{}
}
