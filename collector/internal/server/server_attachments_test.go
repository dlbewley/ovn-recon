package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// attachmentCollector serves each zone one attached pod, and fails failNode.
type attachmentCollector struct {
	fakeAggregateCollector
}

func (c attachmentCollector) Collect(ctx context.Context, nodeName string) (snapshot.LogicalTopologySnapshot, error) {
	payload, err := c.fakeAggregateCollector.Collect(ctx, nodeName)
	if err != nil {
		return payload, err
	}
	payload.Database.LogicalSwitchPorts = []snapshot.LogicalSwitchPortRow{{
		UUID: "port-1",
		Name: "demo.net_blue_web-" + nodeName,
		ExternalIDs: map[string]string{
			"pod": "true", "namespace": "blue", "k8s.ovn.org/nad": "blue/net",
		},
	}}
	return payload, nil
}

func TestAttachmentsCountEveryLiveZone(t *testing.T) {
	collector := attachmentCollector{fakeAggregateCollector{failNode: "worker-b"}}
	srv := NewWithLiveCollector(snapshot.NewFileStore(t.TempDir(), ""), collector).
		WithNodeLister(fakeLister{nodes: []string{"worker-a", "worker-b", "worker-c"}})

	var got snapshot.NetworkAttachments
	rr := getJSON(t, srv, "/api/v1/attachments", &got)
	if rr.Code != http.StatusOK {
		t.Fatalf("attachments: %d %s", rr.Code, rr.Body.String())
	}
	if got.Metadata.SchemaVersion != snapshot.AttachmentsSchemaVersion {
		t.Fatalf("schemaVersion %q", got.Metadata.SchemaVersion)
	}
	if got.Metadata.SourceHealth != snapshot.SourceDegraded {
		t.Fatalf("sourceHealth %q, want degraded with a failed zone", got.Metadata.SourceHealth)
	}
	if want := []string{"worker-a", "worker-c"}; !reflect.DeepEqual(got.Zones, want) {
		t.Fatalf("zones %v, want %v", got.Zones, want)
	}
	want := []snapshot.AttachedNetwork{{NAD: "blue/net", Nodes: []snapshot.AttachedNode{
		{NodeName: "worker-a", Pods: 1},
		{NodeName: "worker-c", Pods: 1},
	}}}
	if !reflect.DeepEqual(got.Networks, want) {
		t.Fatalf("networks %#v, want %#v", got.Networks, want)
	}
	if len(got.Warnings) != 1 || got.Warnings[0].Code != "ZONE_COLLECTION_FAILED" {
		t.Fatalf("warnings %#v", got.Warnings)
	}
	if body := rr.Body.String(); strings.Contains(body, "web-worker") || strings.Contains(body, "database") {
		t.Fatalf("attachments carry more than counts: %s", body)
	}
}

func TestAttachmentsWithoutListerReturnNotFound(t *testing.T) {
	srv := New(snapshot.NewFileStore(t.TempDir(), ""))
	if rr := getJSON(t, srv, "/api/v1/attachments", nil); rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404 without a lister, got %d", rr.Code)
	}
}

func TestAttachmentsRejectOtherMethods(t *testing.T) {
	srv := New(snapshot.NewFileStore(t.TempDir(), "")).WithNodeLister(fakeLister{})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/attachments", nil)
	rr := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rr, req)
	if rr.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", rr.Code)
	}
}
