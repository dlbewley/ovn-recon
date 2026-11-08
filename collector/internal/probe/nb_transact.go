package probe

import (
	"encoding/json"
	"fmt"
	"strings"
)

// nbSocket is the Northbound OVSDB socket inside the nbdb container. It is
// the same default ovn-nbctl connects to when run without --db.
const nbSocket = "unix:/var/run/ovn/ovnnb_db.sock"

// nbTables lists the Northbound tables one snapshot collects, in the order
// their select ops appear in the transact (and in the result). Adding a
// table means appending here and mapping its rows in collectDatabase.
var nbTables = []string{
	"Logical_Router",
	"Logical_Router_Port",
	"Logical_Switch",
	"Logical_Switch_Port",
	"NAT",
	"Logical_Router_Static_Route",
}

// nbTransactCommand builds the single ovsdb-client exec that reads every NB
// table in one transaction: one pod exec instead of one per table, and one
// consistent database state across all of them.
func nbTransactCommand(tables []string) []string {
	ops := make([]string, 0, len(tables)+1)
	ops = append(ops, `"OVN_Northbound"`)
	for _, table := range tables {
		ops = append(ops, fmt.Sprintf(`{"op":"select","table":"%s","where":[]}`, table))
	}
	return []string{"ovsdb-client", "-f", "json", "transact", nbSocket, "[" + strings.Join(ops, ",") + "]"}
}

// nbListCommand is the per-table ovn-nbctl fallback for clusters where the
// transact exec fails (no ovsdb-client in the container, different socket).
func nbListCommand(table string) []string {
	return []string{"ovn-nbctl", "--format=json", "list", table}
}

// transactOpResult is one element of the transact result array: either a
// row set, an error (ovsdb-server reports per-op errors in-band with exit
// code 0), or null for ops aborted after an earlier error.
type transactOpResult struct {
	Rows    []map[string]any `json:"rows"`
	Error   string           `json:"error"`
	Details string           `json:"details"`
}

// decodeNBTransact maps a transact result onto the requested tables. Rows
// are decoded with the same set/map/uuid rules as ovn-nbctl list output.
// A per-op error is returned per table so the caller can degrade one table
// instead of the whole snapshot.
func decodeNBTransact(raw string, tables []string) (map[string][]map[string]any, map[string]error, error) {
	var results []*transactOpResult
	if err := json.Unmarshal([]byte(raw), &results); err != nil {
		return nil, nil, fmt.Errorf("decode transact result: %w", err)
	}
	if len(results) != len(tables) {
		return nil, nil, fmt.Errorf("transact returned %d results for %d tables", len(results), len(tables))
	}

	rowsByTable := make(map[string][]map[string]any, len(tables))
	errByTable := map[string]error{}
	for i, table := range tables {
		result := results[i]
		switch {
		case result == nil:
			errByTable[table] = fmt.Errorf("select aborted after an earlier operation failed")
		case result.Error != "":
			errByTable[table] = fmt.Errorf("%s: %s", result.Error, result.Details)
		default:
			rows := make([]map[string]any, 0, len(result.Rows))
			for _, row := range result.Rows {
				decoded := make(map[string]any, len(row))
				for column, value := range row {
					decoded[column] = decodeOVSValue(value)
				}
				rows = append(rows, decoded)
			}
			rowsByTable[table] = rows
		}
	}
	return rowsByTable, errByTable, nil
}
