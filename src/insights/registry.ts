import { bondDegraded } from './rules/bondDegraded';
import { cnoEvpnGatewayPrereq } from './rules/cnoEvpnGatewayPrereq';
import { cnoEvpnWithIpsec } from './rules/cnoEvpnWithIpsec';
import { cnoMigrationInProgress } from './rules/cnoMigrationInProgress';
import { cnoMnpDisabled } from './rules/cnoMnpDisabled';
import { cnoOperatorUnhealthy } from './rules/cnoOperatorUnhealthy';
import { cnoRouteAdsDisabled } from './rules/cnoRouteAdsDisabled';
import { cnoUnsupportedOverrides } from './rules/cnoUnsupportedOverrides';
import { collectorDegraded } from './rules/collectorDegraded';
import { interfaceDown } from './rules/interfaceDown';
import { localnetUnmapped } from './rules/localnetUnmapped';
import { lspDown } from './rules/lspDown';
import { macBindingOrphan } from './rules/macBindingOrphan';
import { mappingBridgeMissing } from './rules/mappingBridgeMissing';
import { masqueradeAddressMismatch } from './rules/masqueradeAddressMismatch';
import { masqueradeSubnetDisagreement } from './rules/masqueradeSubnetDisagreement';
import { masqueradeSubnetOverlap } from './rules/masqueradeSubnetOverlap';
import { masqueradeSubnetTooSmall } from './rules/masqueradeSubnetTooSmall';
import { matchRefUnresolved } from './rules/matchRefUnresolved';
import { mnpMissingNad } from './rules/mnpMissingNad';
import { mtuExceedsUplink } from './rules/mtuExceedsUplink';
import { nadConfigUnparsed } from './rules/nadConfigUnparsed';
import { nnceFailing } from './rules/nnceFailing';
import { ovsBridgeUnbondedUplinks } from './rules/ovsBridgeUnbondedUplinks';
import { vrfPortUnmatched } from './rules/vrfPortUnmatched';
import type { LogicalRule, PhysicalRule, Rule } from './types';

/**
 * Every rule that ships. Adding a rule is one file under rules/ and one line here; see
 * README.md. The confirmed list and its severities live on ovn-recon-7i6.2 (physical)
 * and ovn-recon-7i6.3 (logical).
 */
export const PHYSICAL_RULES: readonly PhysicalRule[] = [
    localnetUnmapped,
    mappingBridgeMissing,
    interfaceDown,
    bondDegraded,
    nnceFailing,
    mtuExceedsUplink,
    nadConfigUnparsed,
    vrfPortUnmatched,
    ovsBridgeUnbondedUplinks,
    // Masquerade subnet and addresses (ovn-recon-2n6.5): network-scope rules over the
    // Nodes and the zone databases the shell holds.
    masqueradeSubnetTooSmall,
    masqueradeSubnetOverlap,
    masqueradeAddressMismatch,
    masqueradeSubnetDisagreement,
    // The Cluster Network Operator's configuration (ovn-recon-n7r.3): network-scope
    // rules over the sources the shell watches and the Network config tab's model.
    cnoEvpnGatewayPrereq,
    cnoRouteAdsDisabled,
    cnoMnpDisabled,
    cnoEvpnWithIpsec,
    cnoOperatorUnhealthy,
    cnoUnsupportedOverrides,
    cnoMigrationInProgress
];

/**
 * The logical rules of ovn-recon-7i6.3, evaluated over one zone's collector snapshot.
 * `localnet-unmapped` covers a localnet switch with no bridge mapping; it is a
 * physical rule and is not repeated here.
 */
export const LOGICAL_RULES: readonly LogicalRule[] = [
    lspDown,
    mnpMissingNad,
    matchRefUnresolved,
    macBindingOrphan,
    collectorDegraded
];

export const ALL_RULES: readonly Rule[] = [
    ...(PHYSICAL_RULES as readonly Rule[]),
    ...(LOGICAL_RULES as readonly Rule[])
];

export const getRule = (id: string): Rule | undefined => ALL_RULES.find((rule) => rule.id === id);
