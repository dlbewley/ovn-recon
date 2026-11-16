package probe

import (
	"strconv"
	"strings"

	"github.com/dlbewley/ovn-recon/collector/internal/snapshot"
)

// ParseOVSBondShow reads the text of `ovs-appctl bond/show` run with no
// argument, which prints every bond on the node (ovn-recon-1tw.7). bond/show
// has no JSON mode (`-f json` only wraps the same text in {"reply": ...}),
// so this reads the lines OVS's bond_print_details writes:
//
//	---- bond1 ----
//	bond_mode: balance-slb
//	all members active: false
//	updelay: 0 ms
//	next rebalance: 9036 ms
//	lacp_status: off
//	active-backup primary: <none>
//	active member mac: 00:50:56:b4:1b:27(ens161)
//
//	member ens161: enabled
//	  active member
//	  may_enable: true
//
// A line it does not know (per-member hash loads, the MACs an SLB bucket
// carries, LACP details, anything a later OVS adds) is skipped, never an
// error: the output is a diagnostic format, not an interface. Empty output
// is a node without bonds. Older OVS releases said "slave" where current
// ones say "member"; both spellings are read.
func ParseOVSBondShow(raw string) []snapshot.OVSBond {
	bonds := []snapshot.OVSBond{}
	var bond *snapshot.OVSBond
	var member *snapshot.OVSBondMember

	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimRight(line, " \t\r")
		trimmed := strings.TrimSpace(line)
		if trimmed == "" {
			continue
		}

		if name, ok := bondHeading(trimmed); ok {
			bonds = append(bonds, snapshot.OVSBond{Name: name, Members: []snapshot.OVSBondMember{}})
			bond = &bonds[len(bonds)-1]
			member = nil
			continue
		}
		if bond == nil {
			// Anything before the first heading (an ovs-appctl banner) is
			// not about a bond.
			continue
		}

		indented := line != trimmed && (line[0] == ' ' || line[0] == '\t')
		if indented {
			if member != nil {
				readMemberDetail(member, trimmed)
			}
			continue
		}

		if name, enabled, ok := memberHeading(trimmed); ok {
			bond.Members = append(bond.Members, snapshot.OVSBondMember{Name: name, Enabled: enabled})
			member = &bond.Members[len(bond.Members)-1]
			continue
		}
		member = nil
		readBondField(bond, trimmed)
	}
	return bonds
}

// bondHeading reads "---- <name> ----".
func bondHeading(line string) (string, bool) {
	if !strings.HasPrefix(line, "---- ") || !strings.HasSuffix(line, " ----") || len(line) < len("---- x ----") {
		return "", false
	}
	name := strings.TrimSpace(line[len("---- ") : len(line)-len(" ----")])
	return name, name != ""
}

// memberHeading reads "member <name>: enabled|disabled". The state is the
// text after the last colon, so a name is never cut short.
func memberHeading(line string) (string, bool, bool) {
	var rest string
	switch {
	case strings.HasPrefix(line, "member "):
		rest = strings.TrimPrefix(line, "member ")
	case strings.HasPrefix(line, "slave "):
		rest = strings.TrimPrefix(line, "slave ")
	default:
		return "", false, false
	}
	colon := strings.LastIndex(rest, ":")
	if colon <= 0 {
		return "", false, false
	}
	name := strings.TrimSpace(rest[:colon])
	switch strings.TrimSpace(rest[colon+1:]) {
	case "enabled":
		return name, true, name != ""
	case "disabled":
		return name, false, name != ""
	}
	return "", false, false
}

func readMemberDetail(member *snapshot.OVSBondMember, line string) {
	switch {
	case line == "active member" || line == "active slave":
		member.Active = true
	case strings.HasPrefix(line, "may_enable:"):
		if value, ok := parseOVSBool(strings.TrimPrefix(line, "may_enable:")); ok {
			member.MayEnable = value
		}
	}
}

func readBondField(bond *snapshot.OVSBond, line string) {
	key, value, found := strings.Cut(line, ":")
	if !found {
		return
	}
	value = strings.TrimSpace(value)
	switch strings.TrimSpace(key) {
	case "bond_mode":
		bond.Mode = value
	case "lacp_status":
		bond.LACPStatus = value
	case "lacp_fallback_ab":
		bond.LACPFallbackAB = optionalBool(value)
	case "all members active", "all slaves active":
		bond.AllMembersActive = optionalBool(value)
	case "updelay":
		bond.UpdelayMs = optionalMillis(value)
	case "downdelay":
		bond.DowndelayMs = optionalMillis(value)
	case "next rebalance":
		bond.NextRebalanceMs = optionalMillis(value)
	case "active-backup primary":
		if value != "" && value != "<none>" {
			primary := value
			bond.ActiveBackupPrimary = &primary
		}
	case "active member mac", "active slave mac":
		bond.ActiveMember = parseActiveMember(value)
	}
}

// parseActiveMember reads "<mac>(<member>)". OVS prints the member as
// "none" (and an all-zero MAC) when no member is active; the contract also
// allows a bare <none>. Either way there is no active member to report.
func parseActiveMember(value string) *snapshot.OVSBondActiveMember {
	if value == "" || value == "<none>" {
		return nil
	}
	open := strings.Index(value, "(")
	if open <= 0 || !strings.HasSuffix(value, ")") {
		return nil
	}
	mac := strings.ToLower(strings.TrimSpace(value[:open]))
	name := strings.TrimSpace(value[open+1 : len(value)-1])
	if name == "" || name == "none" || name == "<none>" {
		return nil
	}
	return &snapshot.OVSBondActiveMember{Name: name, MAC: mac}
}

func parseOVSBool(value string) (bool, bool) {
	switch strings.TrimSpace(value) {
	case "true":
		return true, true
	case "false":
		return false, true
	}
	return false, false
}

func optionalBool(value string) *bool {
	parsed, ok := parseOVSBool(value)
	if !ok {
		return nil
	}
	return &parsed
}

// optionalMillis reads "<n> ms".
func optionalMillis(value string) *int64 {
	number := strings.TrimSpace(strings.TrimSuffix(strings.TrimSpace(value), "ms"))
	parsed, err := strconv.ParseInt(number, 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}
