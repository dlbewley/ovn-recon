package snapshot

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

const fixtureDir = "../../fixtures/snapshots"

// TestFixturesConformToV2Contract keeps the fixture corpus in lockstep with
// the Go types: every fixture must decode without unknown fields, declare
// schemaVersion 2, and carry a database payload.
func TestFixturesConformToV2Contract(t *testing.T) {
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}

	checked := 0
	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}
		checked++

		t.Run(entry.Name(), func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			decoder := json.NewDecoder(bytes.NewReader(raw))
			decoder.DisallowUnknownFields()
			var snap LogicalTopologySnapshot
			if err := decoder.Decode(&snap); err != nil {
				t.Fatalf("fixture does not match Go contract: %v", err)
			}

			if snap.Metadata.SchemaVersion != SchemaVersionV2 {
				t.Fatalf("schemaVersion = %q, want %q", snap.Metadata.SchemaVersion, SchemaVersionV2)
			}
			if snap.Database == nil {
				t.Fatalf("v2 fixture missing database payload")
			}
		})
	}

	if checked == 0 {
		t.Fatal("no fixtures found")
	}
}

// TestDatabaseReferentialIntegrity ensures fixture rows reference each other
// consistently: router/switch port UUID lists, NAT and static route UUID
// lists, and router-type switch ports naming a real router port.
func TestDatabaseReferentialIntegrity(t *testing.T) {
	entries, err := os.ReadDir(fixtureDir)
	if err != nil {
		t.Fatalf("read fixture dir: %v", err)
	}

	for _, entry := range entries {
		if entry.IsDir() || filepath.Ext(entry.Name()) != ".json" {
			continue
		}

		t.Run(entry.Name(), func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join(fixtureDir, entry.Name()))
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			var snap LogicalTopologySnapshot
			if err := json.Unmarshal(raw, &snap); err != nil {
				t.Fatalf("decode fixture: %v", err)
			}
			db := snap.Database
			if db == nil {
				t.Fatal("missing database payload")
			}

			lrpByUUID := map[string]bool{}
			lrpByName := map[string]bool{}
			for _, port := range db.LogicalRouterPorts {
				lrpByUUID[port.UUID] = true
				lrpByName[port.Name] = true
			}
			lspByUUID := map[string]bool{}
			for _, port := range db.LogicalSwitchPorts {
				lspByUUID[port.UUID] = true
			}
			natByUUID := map[string]bool{}
			for _, nat := range db.NATs {
				natByUUID[nat.UUID] = true
			}
			routeByUUID := map[string]bool{}
			for _, route := range db.StaticRoutes {
				routeByUUID[route.UUID] = true
			}

			for _, router := range db.LogicalRouters {
				for _, uuid := range router.PortUUIDs {
					if !lrpByUUID[uuid] {
						t.Errorf("router %s references unknown port %s", router.Name, uuid)
					}
				}
				for _, uuid := range router.NATUUIDs {
					if !natByUUID[uuid] {
						t.Errorf("router %s references unknown NAT %s", router.Name, uuid)
					}
				}
				for _, uuid := range router.StaticRouteUUIDs {
					if !routeByUUID[uuid] {
						t.Errorf("router %s references unknown static route %s", router.Name, uuid)
					}
				}
			}

			for _, logicalSwitch := range db.LogicalSwitches {
				for _, uuid := range logicalSwitch.PortUUIDs {
					if !lspByUUID[uuid] {
						t.Errorf("switch %s references unknown port %s", logicalSwitch.Name, uuid)
					}
				}
			}

			for _, port := range db.LogicalSwitchPorts {
				if port.Type != "router" {
					continue
				}
				routerPort := port.Options["router-port"]
				if routerPort == "" {
					t.Errorf("router-type port %s missing router-port option", port.Name)
					continue
				}
				if !lrpByName[routerPort] {
					t.Errorf("port %s references unknown router port %s", port.Name, routerPort)
				}
			}
		})
	}
}
