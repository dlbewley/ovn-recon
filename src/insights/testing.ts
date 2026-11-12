import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import { buildGraphContext, GraphContextInput } from '../topology/context';
import type { LogicalTopologySnapshot } from '../types';
import type { ClusterNetworkInputs, LogicalContext, PhysicalContext } from './types';

/*
 * Test helpers for the rule tests. Not imported by any shipped module.
 */

const FIXTURES = path.join(process.cwd(), 'test', 'fixtures');

/**
 * A fixture file, whether it holds one object, an array, or a `kind: List`. One
 * capture (nns/host-lldp.json) is raw `oc get -o yaml` output under a .json name.
 */
export const loadFixture = <T>(...segments: string[]): T => {
    const content = fs.readFileSync(path.join(FIXTURES, ...segments), 'utf-8');
    try {
        return JSON.parse(content) as T;
    } catch {
        return yaml.load(content) as T;
    }
};

/** A fixture holding several objects, as an array. */
export const loadItems = <T>(...segments: string[]): T[] => {
    const data = loadFixture<T[] | { items: T[] }>(...segments);
    return Array.isArray(data) ? data : data.items;
};

/** Every file in one fixture directory, by name. */
export const fixtureNames = (directory: string): string[] =>
    fs.readdirSync(path.join(FIXTURES, directory)).filter((name) => name.endsWith('.json')).sort();

/** A deep copy, for a test that varies a real capture. */
export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A physical context for one node, with the cluster inputs defaulting to that node's. */
export const physicalContext = (
    input: GraphContextInput,
    cluster: Partial<ClusterNetworkInputs> = {}
): PhysicalContext => ({
    domain: 'physical',
    node: buildGraphContext(input),
    cluster: {
        cudns: input.cudns ?? [],
        udns: input.udns ?? [],
        nads: input.nads ?? [],
        nodeNetworkStates: [input.nns],
        ...cluster
    }
});

/** A physical context with no node, for network-scope rules. */
export const clusterContext = (cluster: Partial<ClusterNetworkInputs>): PhysicalContext => ({
    domain: 'physical',
    cluster: { cudns: [], udns: [], nads: [], ...cluster }
});

const SNAPSHOT_FIXTURES = path.join(process.cwd(), 'collector', 'fixtures', 'snapshots');

/**
 * A collector snapshot fixture (collector/fixtures/snapshots/<name>.json), as a fresh
 * copy a test may vary. These hold the full snapshot, policy and services included.
 */
export const loadSnapshot = (name: string): LogicalTopologySnapshot =>
    JSON.parse(fs.readFileSync(path.join(SNAPSHOT_FIXTURES, `${name}.json`), 'utf-8')) as LogicalTopologySnapshot;

/** A logical context for one zone's snapshot; the node defaults to the snapshot's. */
export const logicalContext = (
    snapshot: LogicalTopologySnapshot,
    extra: Partial<Omit<LogicalContext, 'domain' | 'snapshot'>> = {}
): LogicalContext => ({
    domain: 'logical',
    nodeName: snapshot.metadata.nodeName,
    snapshot,
    ...extra
});
