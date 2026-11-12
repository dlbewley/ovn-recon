import type { GraphContext } from '../topology/context';
import type {
    ClusterUserDefinedNetwork,
    LogicalTopologySnapshot,
    MultiNetworkPolicy,
    NetworkAttachmentDefinition,
    NodeNetworkState,
    Pod,
    SnapshotSection,
    UserDefinedNetwork
} from '../types';

/**
 * The findings model (ovn-recon-7i6.4). See README.md in this directory for the
 * severity vocabulary and for the things deliberately NOT reported.
 *
 *   warning  looks broken: investigate. Never for something that works.
 *   info     works, but current guidance differs. Never drawn as a warning.
 */
export type Severity = 'warning' | 'info';

/**
 * What a rule looks at.
 *
 *   node          one node's state (its NodeNetworkState, its enactments)
 *   network       one network object across the cluster (a CUDN, a NAD)
 *   node-network  one network as it lands on one node
 */
export type RuleScope = 'node' | 'network' | 'node-network';

/** A Kubernetes object, addressed the way a console link needs it. */
export interface K8sRef {
    group: string;
    version: string;
    kind: string;
    name: string;
    namespace?: string;
}

/**
 * The thing a finding is about, in a form each surface can address without a lookup.
 *
 *   graph-node  a node on one node's physical graph, by the canonical id from
 *               src/topology/ids.ts (`iface:bond0`, `cudn:blue`)
 *   construct   a logical construct, as kind plus name -- the `?select=KIND:NAME`
 *               form the ladder deep links use (useSelectParam.constructSelectValue)
 *   k8s         a Kubernetes object, for findings that belong to no one graph
 */
export type FindingSubject =
    | { kind: 'graph-node'; node: string; graphNodeId: string }
    | { kind: 'construct'; node?: string; constructKind: string; name: string }
    | { kind: 'k8s'; ref: K8sRef };

/**
 * One fact a finding rests on, and where it came from.
 *
 * `inferred` is set, with the basis in words, whenever the fact rests on a naming
 * convention or a default rather than on a field that states it. The surfaces must
 * show that, so a reader can tell a guess from an observation.
 */
export interface Evidence {
    fact: string;
    /**
     * The objects the fact was read from: usually one, several when the fact is
     * about all of them ("no node maps thirdmap" cites every NodeNetworkState).
     */
    sources: K8sRef[];
    /** The field the fact was read from, in dotted form; `[name=x]` picks a list entry. */
    path?: string;
    inferred?: string;
    /**
     * Where the fact was read when it is not a Kubernetes object: the logical rules
     * read a collector snapshot ("the northbound database of node worker-1").
     */
    origin?: string;
}

/** What to change, naming the object to edit. */
export interface Remedy {
    text: string;
    target: K8sRef;
    /** The field to edit, when one field is the fix. */
    path?: string;
    /**
     * `view` when the target is where to look rather than what to edit: OVN-Kubernetes
     * owns the northbound rows, so a logical remedy often starts at a Pod or a Node.
     * Default `edit`, which links the target's YAML.
     */
    verb?: 'edit' | 'view';
}

export interface FindingScope {
    /** The node the finding is on, for node and node-network rules. */
    node?: string;
    /** The network object the finding is about, for network and node-network rules. */
    network?: K8sRef;
}

export interface Finding {
    /** Stable across evaluations of the same state; see findingKey. */
    key: string;
    ruleId: string;
    severity: Severity;
    subject: FindingSubject;
    scope: FindingScope;
    /** One sentence naming the object. */
    summary: string;
    evidence: Evidence[];
    remedy: Remedy;
    docsUrl?: string;
}

/**
 * Cluster-wide inputs for network-scope rules. Each list is what the page watches;
 * `nodeNetworkStates` is undefined until every node's NodeNetworkState is loaded (or
 * when nmstate is absent), and a rule needing it then reports nothing -- absence of
 * data is never a finding.
 */
export interface ClusterNetworkInputs {
    cudns: ClusterUserDefinedNetwork[];
    udns: UserDefinedNetwork[];
    nads: NetworkAttachmentDefinition[];
    nodeNetworkStates?: NodeNetworkState[];
}

/**
 * Context for physical and Kubernetes rules: one node's assembled topology context
 * (buildGraphContext), plus the cluster inputs. `node` is absent when evaluating for a
 * surface that shows no one node, such as the overview's network counts.
 */
export interface PhysicalContext {
    domain: 'physical';
    node?: GraphContext;
    cluster: ClusterNetworkInputs;
}

/**
 * Cluster-wide inputs for the logical network rules: what the page watches. Absent
 * (undefined) until every list has loaded, and when a CRD is not installed; a rule
 * needing it then reports nothing.
 */
export interface LogicalClusterInputs {
    nads: NetworkAttachmentDefinition[];
    multiNetworkPolicies: MultiNetworkPolicy[];
}

/**
 * Context for logical rules (ovn-recon-7i6.3): one zone's collector snapshot, plus
 * what a rule needs beside it. Each extra input is optional and a rule needing one
 * stays quiet without it -- absence of data is never a finding.
 */
export interface LogicalContext {
    domain: 'logical';
    /** The node whose zone the snapshot is. */
    nodeName: string;
    snapshot: LogicalTopologySnapshot;
    /** The pods scheduled on `nodeName`, once loaded. */
    pods?: Pod[];
    /** For network-scope rules; see LogicalClusterInputs. */
    cluster?: LogicalClusterInputs;
    /** Evaluation time in ms, for rules with a grace period; defaults to Date.now(). */
    now?: number;
}

export type RuleContext = PhysicalContext | LogicalContext;

export interface Rule<C extends RuleContext = RuleContext> {
    id: string;
    severity: Severity;
    scope: RuleScope;
    domain: C['domain'];
    /** A short noun phrase for lists and settings. */
    title: string;
    /** Pure: no hooks, no fetches, no mutation of ctx. */
    evaluate: (ctx: C) => Finding[];
    /**
     * Logical rules that read an optional snapshot section (and nothing else but
     * `ctx.snapshot.database` and `ctx.nodeName`). A surface that loads the section
     * on its own, as the drawer does, runs them over that database.
     */
    section?: SnapshotSection;
}

export type PhysicalRule = Rule<PhysicalContext>;
export type LogicalRule = Rule<LogicalContext>;
