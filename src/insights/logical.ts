import type { LogicalSwitchRow } from '../types';
import { nodeRef } from './refs';
import type { Evidence, FindingSubject } from './types';

/** Helpers shared by the logical rules (ovn-recon-7i6.3). */

/**
 * A logical switch or router of one zone, as the ladder and `?select=KIND:NAME`
 * address it. The zone is always set: under interconnect each node has its own
 * northbound database, and a construct's name alone does not say which one.
 */
export const constructSubject = (node: string, constructKind: 'switch' | 'router', name: string): FindingSubject =>
    ({ kind: 'construct', node, constructKind, name });

/**
 * A finding about a zone as a whole (its collection, a row that belongs to no one
 * construct). Addressed as the zone's Node; the logical page lists these above its
 * ladder.
 */
export const zoneSubject = (node: string): FindingSubject => ({ kind: 'k8s', ref: nodeRef(node) });

/** True for a finding the logical page lists above the ladder rather than on a card. */
export const isZoneFinding = (subject: FindingSubject): boolean => subject.kind !== 'construct';

/** "the northbound database of node worker-1": where a snapshot fact was read. */
export const zoneOrigin = (node: string): string => `the northbound database of node ${node}`;

/** An evidence line read from one zone's snapshot, at an OVN table path. */
export const snapshotFact = (node: string, fact: string, path?: string): Evidence =>
    ({ fact, sources: [], origin: zoneOrigin(node), path });

/** Logical_Switch_Port uuid to the switch that holds it. */
export const switchByPort = (switches: LogicalSwitchRow[]): Map<string, LogicalSwitchRow> => {
    const byPort = new Map<string, LogicalSwitchRow>();
    switches.forEach((logicalSwitch) => logicalSwitch.ports.forEach((port) => byPort.set(port, logicalSwitch)));
    return byPort;
};
