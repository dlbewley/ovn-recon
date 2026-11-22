import type { ConfigMap, OperatorNetwork } from '../types';
import type { ConfigNotice, Source } from './cnoConfigModel';

/**
 * What the Cluster Network Operator last applied, against what it is told now
 * (ovn-recon-n7r.5). Pure, like the rest of the Network config model.
 *
 * The operator keeps the spec it last rendered successfully in the ConfigMap
 * `openshift-network-operator/applied-cluster`, as JSON under the data key `applied`
 * (shape confirmed on OpenShift 4.22: the whole `operator.openshift.io` Network spec,
 * defaults filled in). Before it applies a new spec it checks the change against that
 * one, and a change it refuses (a new MTU without a migration, a new Geneve port, a
 * hybrid overlay edit) leaves the ConfigMap as it was and the operator Degraded. So a
 * field whose spec value differs from the applied one was either refused or is still
 * pending.
 *
 * A field the spec leaves out but the applied copy has is not a difference: the
 * operator filled in the default when it rendered. Empty values (absent, null, '', {}
 * and []) are all the same nothing.
 *
 * Also here, because they are read from the same optional ConfigMaps: the legacy
 * `gateway-mode-config` switch, read against routingViaHost.
 */

export const APPLIED_DATA_KEY = 'applied';
export const APPLIED_CONFIG_MAP = 'applied-cluster';

export interface AppliedDifference {
    /** The field's path in the operator Network, "spec.defaultNetwork.ovnKubernetesConfig.mtu". */
    path: string;
    /** The value in the spec now, as text. */
    spec: string;
    /** The value last applied, as text; "Not set" when the applied copy has none. */
    applied: string;
}

/**
 * `match`: everything in the spec has been applied. `differs`: something has not.
 * `unavailable`: the ConfigMap or the spec could not be read, `reason` says which and
 * why; `loading` until both have answered. `unreadable`: the ConfigMap holds no JSON
 * spec under `applied`.
 */
export type AppliedStatus = 'loading' | 'match' | 'differs' | 'unavailable' | 'unreadable';

export interface AppliedComparison {
    status: AppliedStatus;
    differences: AppliedDifference[];
    /** One line for the user. */
    text: string;
}

const NOT_SET = 'Not set';

const isEmpty = (value: unknown): boolean =>
    value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => {
    if (isEmpty(value)) return NOT_SET;
    return typeof value === 'string' ? value : JSON.stringify(value);
};

/** Every field set in `spec` whose value `applied` does not have, leaf by leaf. */
const diff = (spec: unknown, applied: unknown, path: string, out: AppliedDifference[]): void => {
    if (isEmpty(spec)) return;
    if (isPlainObject(spec) && isPlainObject(applied)) {
        for (const key of Object.keys(spec).sort()) diff(spec[key], applied[key], `${path}.${key}`, out);
        return;
    }
    if (Array.isArray(spec) && Array.isArray(applied)) {
        // Order matters in these lists (the first cluster network is the primary family).
        if (spec.length === applied.length) {
            spec.forEach((item, index) => diff(item, applied[index], `${path}[${index}]`, out));
            return;
        }
    } else if (isPlainObject(spec) && isEmpty(applied)) {
        // A whole block the operator has not applied: name its fields, not the block.
        for (const key of Object.keys(spec).sort()) diff(spec[key], undefined, `${path}.${key}`, out);
        return;
    } else if (spec === applied || (typeof spec !== 'object' && String(spec) === String(applied ?? ''))) {
        return;
    }
    if (JSON.stringify(spec) !== JSON.stringify(applied)) out.push({ path, spec: text(spec), applied: text(applied) });
};

/** The applied spec in the ConfigMap, or why there is none. */
export const parseAppliedSpec = (configMap: ConfigMap | undefined): { spec?: Record<string, unknown>; error?: string } => {
    const raw = configMap?.data?.[APPLIED_DATA_KEY];
    if (!raw) return { error: `The ConfigMap has no "${APPLIED_DATA_KEY}" key` };
    try {
        const parsed: unknown = JSON.parse(raw);
        return isPlainObject(parsed) ? { spec: parsed } : { error: `"${APPLIED_DATA_KEY}" is not a JSON object` };
    } catch {
        return { error: `"${APPLIED_DATA_KEY}" is not JSON` };
    }
};

const unavailable = (why: string): AppliedComparison => ({ status: 'unavailable', differences: [], text: why });

export const compareAppliedSpec = (
    operatorNetwork: Source<OperatorNetwork>, appliedCluster: Source<ConfigMap>,
): AppliedComparison => {
    if (operatorNetwork.status === 'loading' || appliedCluster.status === 'loading') {
        return { status: 'loading', differences: [], text: 'Loading' };
    }
    if (appliedCluster.status === 'forbidden') return unavailable(`ConfigMap ${APPLIED_CONFIG_MAP} is not visible to you`);
    if (appliedCluster.status === 'absent') return unavailable(`ConfigMap ${APPLIED_CONFIG_MAP} is not present`);
    if (appliedCluster.status === 'error') return unavailable(`ConfigMap ${APPLIED_CONFIG_MAP} could not be read`);
    const spec = operatorNetwork.data?.spec;
    if (operatorNetwork.status !== 'ok' || !spec) return unavailable('The network operator configuration could not be read');

    const { spec: applied, error } = parseAppliedSpec(appliedCluster.data);
    if (!applied) return { status: 'unreadable', differences: [], text: error ?? 'Unreadable' };

    const differences: AppliedDifference[] = [];
    diff(spec, applied, 'spec', differences);
    if (differences.length === 0) return { status: 'match', differences, text: 'Matches the spec' };
    return {
        status: 'differs',
        differences,
        text: `${differences.length} field${differences.length === 1 ? '' : 's'} not applied yet`,
    };
};

/** The warning a difference earns; nothing when everything is applied or it cannot be told. */
export const appliedNotice = (comparison: AppliedComparison): ConfigNotice | undefined => {
    if (comparison.status !== 'differs') return undefined;
    const count = comparison.differences.length;
    return {
        id: 'applied-differs',
        severity: 'warning',
        title: `The network operator has not applied ${count === 1 ? 'one change' : `${count} changes`} to its configuration`,
        body: `The spec differs from what ConfigMap ${APPLIED_CONFIG_MAP} records as last applied: the change was refused `
            + 'or is still pending, and a refused change leaves the operator Degraded.',
    };
};

// --- gateway-mode-config -------------------------------------------------------------

export const GATEWAY_MODE_CONFIG_MAP = 'gateway-mode-config';

/**
 * The legacy gateway mode switch. Before gatewayConfig existed in the API, the operator
 * took the mode from this ConfigMap's `mode` key ("local" or "shared"), and it still
 * reads it at bootstrap. Say what it holds and whether it agrees with routingViaHost.
 */
export const gatewayModeNotice = (
    configMap: Source<ConfigMap>, routingViaHost: boolean | undefined,
): ConfigNotice | undefined => {
    if (configMap.status !== 'ok') return undefined;
    const data = configMap.data?.data ?? {};
    const mode = data.mode?.trim().toLowerCase();
    const others = Object.entries(data).filter(([key]) => key !== 'mode').map(([key, value]) => `${key}: ${value}`);
    const parts: string[] = [];
    if (mode === 'local' || mode === 'shared') {
        const specMode = routingViaHost === true ? 'local' : 'shared';
        parts.push(mode === specMode
            ? `mode: ${mode}, which agrees with routingViaHost`
            : `mode: ${mode}, which disagrees with routingViaHost (${specMode})`);
    } else if (data.mode !== undefined) {
        parts.push(`mode: ${data.mode} (not a mode the operator knows)`);
    } else {
        parts.push('No mode key');
    }
    parts.push(...others);
    return {
        id: 'gateway-mode-configmap',
        severity: mode !== undefined && mode !== (routingViaHost === true ? 'local' : 'shared') ? 'warning' : 'info',
        title: `The legacy gateway mode switch is present (ConfigMap ${GATEWAY_MODE_CONFIG_MAP})`,
        body: parts.join('; '),
    };
};
