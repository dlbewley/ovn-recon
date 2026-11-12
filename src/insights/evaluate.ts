import type { GraphContext } from '../topology/context';
import type { LogicalDatabase, LogicalTopologySnapshot } from '../types';
import { LOGICAL_RULES, PHYSICAL_RULES } from './registry';
import type {
    ClusterNetworkInputs,
    Finding,
    LogicalClusterInputs,
    LogicalContext,
    LogicalRule,
    PhysicalContext,
    PhysicalRule,
    Severity
} from './types';

const SEVERITY_ORDER: Record<Severity, number> = { warning: 0, info: 1 };

/** Warnings first, then by rule, then by summary, so every surface lists alike. */
export const compareFindings = (a: Finding, b: Finding): number =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]
    || a.ruleId.localeCompare(b.ruleId)
    || a.summary.localeCompare(b.summary);

const dedupeAndSort = (findings: Finding[]): Finding[] => {
    const byKey = new Map<string, Finding>();
    findings.forEach((finding) => {
        if (!byKey.has(finding.key)) byKey.set(finding.key, finding);
    });
    return Array.from(byKey.values()).sort(compareFindings);
};

const EMPTY_CLUSTER: ClusterNetworkInputs = Object.freeze({ cudns: [], udns: [], nads: [] }) as ClusterNetworkInputs;

export interface PhysicalEvaluatorOptions {
    rules?: readonly PhysicalRule[];
    /** Called when a rule throws. The rule's findings are dropped; the others stand. */
    onRuleError?: (ruleId: string, error: unknown) => void;
}

export interface PhysicalEvaluator {
    /** Findings for one node's page: that node's rules plus the cluster's network rules. */
    (ctx: PhysicalContext): Finding[];
    /** Findings of the network-scope rules alone. */
    network: (cluster: ClusterNetworkInputs) => Finding[];
    /** Findings of the node and node-network rules alone, for one node. */
    node: (node: GraphContext) => Finding[];
    /** Findings for the whole cluster: network rules once, node rules per node. */
    cluster: (cluster: ClusterNetworkInputs, nodes: GraphContext[]) => Finding[];
}

/**
 * A memoised evaluator over a set of rules.
 *
 * Caching is by object identity, so callers rebuild a context when its inputs change
 * (the useMemo a page already does for buildGraphContext) and get the same array back
 * when nothing did. The two halves cache apart -- a node page and the overview share
 * the network findings -- which sets one contract on rules:
 *
 *   network rules read ctx.cluster only;
 *   node and node-network rules read ctx.node only (the GraphContext carries the
 *   CUDNs, UDNs, NADs and enactments they need).
 *
 * The evaluator enforces it by handing each half only its own input.
 */
export const createPhysicalEvaluator = (options: PhysicalEvaluatorOptions = {}): PhysicalEvaluator => {
    const rules = options.rules ?? PHYSICAL_RULES;
    const networkRules = rules.filter((rule) => rule.scope === 'network');
    const nodeRules = rules.filter((rule) => rule.scope !== 'network');

    const run = (selected: readonly PhysicalRule[], ctx: PhysicalContext): Finding[] =>
        dedupeAndSort(selected.flatMap((rule) => {
            try {
                return rule.evaluate(ctx);
            } catch (error) {
                options.onRuleError?.(rule.id, error);
                return [];
            }
        }));

    const networkCache = new WeakMap<ClusterNetworkInputs, Finding[]>();
    const nodeCache = new WeakMap<GraphContext, Finding[]>();
    const combinedCache = new WeakMap<GraphContext, WeakMap<ClusterNetworkInputs, Finding[]>>();

    const network = (cluster: ClusterNetworkInputs): Finding[] => {
        let findings = networkCache.get(cluster);
        if (!findings) {
            findings = run(networkRules, { domain: 'physical', cluster });
            networkCache.set(cluster, findings);
        }
        return findings;
    };

    const node = (graph: GraphContext): Finding[] => {
        let findings = nodeCache.get(graph);
        if (!findings) {
            findings = run(nodeRules, { domain: 'physical', node: graph, cluster: EMPTY_CLUSTER });
            nodeCache.set(graph, findings);
        }
        return findings;
    };

    const evaluate = ((ctx: PhysicalContext): Finding[] => {
        if (!ctx.node) return network(ctx.cluster);
        let byCluster = combinedCache.get(ctx.node);
        if (!byCluster) {
            byCluster = new WeakMap();
            combinedCache.set(ctx.node, byCluster);
        }
        let findings = byCluster.get(ctx.cluster);
        if (!findings) {
            findings = dedupeAndSort([...node(ctx.node), ...network(ctx.cluster)]);
            byCluster.set(ctx.cluster, findings);
        }
        return findings;
    }) as PhysicalEvaluator;

    evaluate.network = network;
    evaluate.node = node;
    evaluate.cluster = (cluster, nodes) =>
        dedupeAndSort([...network(cluster), ...nodes.flatMap((graph) => node(graph))]);
    return evaluate;
};

/** The evaluator over every shipped physical rule, shared by the surfaces. */
export const evaluatePhysical = createPhysicalEvaluator();

// --- Logical ------------------------------------------------------------------

export interface LogicalEvaluatorOptions {
    rules?: readonly LogicalRule[];
    /** Called when a rule throws. The rule's findings are dropped; the others stand. */
    onRuleError?: (ruleId: string, error: unknown) => void;
}

export interface LogicalEvaluator {
    /** Findings for one zone's page: its zone rules plus the network rules. */
    (ctx: LogicalContext): Finding[];
    /** Findings of the network-scope rules alone. */
    network: (cluster: LogicalClusterInputs) => Finding[];
    /**
     * Findings of the rules that read one optional section (see Rule.section), over a
     * database that carries it: what the drawer adds once it has loaded the section.
     */
    sections: (database: LogicalDatabase, nodeName: string) => Finding[];
}

const EMPTY_SNAPSHOT: LogicalTopologySnapshot = Object.freeze({
    metadata: { schemaVersion: '', generatedAt: '', sourceHealth: '', nodeName: '' },
    nodes: [], edges: [], groups: [], warnings: []
}) as LogicalTopologySnapshot;

/**
 * A memoised evaluator over a set of logical rules, cached by object identity like
 * the physical one, with the same contract split:
 *
 *   network rules read ctx.cluster only;
 *   node rules read everything else (the snapshot, the node's pods, the time) and
 *   never ctx.cluster;
 *   section rules (Rule.section) read ctx.snapshot.database and ctx.nodeName only.
 */
export const createLogicalEvaluator = (options: LogicalEvaluatorOptions = {}): LogicalEvaluator => {
    const rules = options.rules ?? LOGICAL_RULES;
    const networkRules = rules.filter((rule) => rule.scope === 'network');
    const zoneRules = rules.filter((rule) => rule.scope !== 'network');
    const sectionRules = zoneRules.filter((rule) => rule.section !== undefined);

    const run = (selected: readonly LogicalRule[], ctx: LogicalContext): Finding[] =>
        dedupeAndSort(selected.flatMap((rule) => {
            try {
                return rule.evaluate(ctx);
            } catch (error) {
                options.onRuleError?.(rule.id, error);
                return [];
            }
        }));

    const networkCache = new WeakMap<LogicalClusterInputs, Finding[]>();
    const contextCache = new WeakMap<LogicalContext, Finding[]>();
    const sectionCache = new WeakMap<LogicalDatabase, Map<string, Finding[]>>();

    const network = (cluster: LogicalClusterInputs): Finding[] => {
        let findings = networkCache.get(cluster);
        if (!findings) {
            findings = run(networkRules, { domain: 'logical', nodeName: '', snapshot: EMPTY_SNAPSHOT, cluster });
            networkCache.set(cluster, findings);
        }
        return findings;
    };

    const evaluate = ((ctx: LogicalContext): Finding[] => {
        let findings = contextCache.get(ctx);
        if (!findings) {
            const zone = run(zoneRules, { ...ctx, cluster: undefined });
            findings = ctx.cluster ? dedupeAndSort([...zone, ...network(ctx.cluster)]) : zone;
            contextCache.set(ctx, findings);
        }
        return findings;
    }) as LogicalEvaluator;

    evaluate.network = network;
    evaluate.sections = (database, nodeName) => {
        let byNode = sectionCache.get(database);
        if (!byNode) {
            byNode = new Map();
            sectionCache.set(database, byNode);
        }
        let findings = byNode.get(nodeName);
        if (!findings) {
            findings = run(sectionRules, {
                domain: 'logical',
                nodeName,
                snapshot: { ...EMPTY_SNAPSHOT, database }
            });
            byNode.set(nodeName, findings);
        }
        return findings;
    };
    return evaluate;
};

/** The evaluator over every shipped logical rule, shared by the surfaces. */
export const evaluateLogical = createLogicalEvaluator();
