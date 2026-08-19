package controller

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// controller-runtime discards the Result whenever the returned error is
// non-nil, requeueing with the workqueue's exponential backoff instead (5ms
// doubling to 1000s, per client-go's DefaultTypedControllerRateLimiter). A
// RequeueAfter paired with an error is therefore dead code that also logs
// "Reconciler returned both a non-zero result and a non-nil error" on every
// failure. Pair a non-zero Result with nil, or an error with a zero Result.
func TestReconcileNeverReturnsResultWithError(t *testing.T) {
	fileSet := token.NewFileSet()
	file, err := parser.ParseFile(fileSet, "ovnrecon_controller.go", nil, 0)
	if err != nil {
		t.Fatalf("failed to parse controller source: %v", err)
	}

	var offenders []string
	ast.Inspect(file, func(n ast.Node) bool {
		ret, ok := n.(*ast.ReturnStmt)
		if !ok || len(ret.Results) != 2 {
			return true
		}
		if isNilIdent(ret.Results[1]) {
			return true
		}
		lit, ok := ret.Results[0].(*ast.CompositeLit)
		if !ok || len(lit.Elts) == 0 {
			return true // zero Result, or not a literal at all
		}
		if !isReconcileResult(lit) {
			return true
		}
		pos := fileSet.Position(ret.Pos())
		fields := make([]string, 0, len(lit.Elts))
		for _, e := range lit.Elts {
			if kv, ok := e.(*ast.KeyValueExpr); ok {
				if k, ok := kv.Key.(*ast.Ident); ok {
					fields = append(fields, k.Name)
				}
			}
		}
		offenders = append(offenders, fmt.Sprintf("%s:%d returns Result{%v} with a non-nil error", pos.Filename, pos.Line, fields))
		return true
	})

	for _, o := range offenders {
		t.Errorf("%s -- the Result is discarded; return reconcile.Result{} instead", o)
	}
}

func isNilIdent(e ast.Expr) bool {
	id, ok := e.(*ast.Ident)
	return ok && id.Name == "nil"
}

func isReconcileResult(lit *ast.CompositeLit) bool {
	sel, ok := lit.Type.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != "Result" {
		return false
	}
	pkg, ok := sel.X.(*ast.Ident)
	return ok && pkg.Name == "reconcile"
}
