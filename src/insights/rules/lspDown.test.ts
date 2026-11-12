import type { LogicalTopologySnapshot, Pod } from '../../types';
import { loadSnapshot, logicalContext } from '../testing';
import { LSP_DOWN_GRACE_MS, lspDown } from './lspDown';

const NOW = Date.parse('2026-11-11T12:00:00Z');
const PORT = 'openshift-mtv_forklift-volume-populator-controller-6d5f776884-cllnz';

const pod = (overrides: Partial<NonNullable<Pod['status']>> = {}): Pod => ({
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { namespace: 'openshift-mtv', name: 'forklift-volume-populator-controller-6d5f776884-cllnz' },
    spec: { nodeName: 'cnv-1' },
    status: { phase: 'Running', startTime: new Date(NOW - 10 * 60 * 1000).toISOString(), ...overrides }
});

/** cnv-1's snapshot with one pod port's `up` (and optionally `enabled`) changed. */
const withPort = (up: boolean | undefined, enabled?: boolean): LogicalTopologySnapshot => {
    const snapshot = loadSnapshot('cnv-1');
    const row = snapshot.database!.logicalSwitchPorts.find((port) => port.name === PORT)!;
    row.up = up;
    if (enabled !== undefined) row.enabled = enabled;
    return snapshot;
};

describe('lsp-down', () => {
    it('fires for a pod running past the grace period whose port is down, on its switch', () => {
        const findings = lspDown.evaluate(logicalContext(withPort(false), { pods: [pod()], now: NOW }));

        expect(findings).toHaveLength(1);
        expect(findings[0]).toEqual(expect.objectContaining({
            ruleId: 'lsp-down',
            severity: 'warning',
            subject: { kind: 'construct', node: 'cnv-1', constructKind: 'switch', name: 'cnv-1' },
            scope: { node: 'cnv-1' },
            summary: `Pod openshift-mtv/forklift-volume-populator-controller-6d5f776884-cllnz is running on cnv-1, but its port ${PORT} is down.`
        }));
        expect(findings[0].evidence[0]).toEqual(expect.objectContaining({
            path: `Logical_Switch_Port[name=${PORT}].up`,
            origin: 'the northbound database of node cnv-1'
        }));
        expect(findings[0].remedy).toEqual(expect.objectContaining({
            verb: 'view',
            target: expect.objectContaining({ kind: 'Pod', namespace: 'openshift-mtv' })
        }));
    });

    it('stays quiet on the capture as taken: every pod port is up', () => {
        expect(lspDown.evaluate(logicalContext(loadSnapshot('cnv-1'), { pods: [pod()], now: NOW }))).toEqual([]);
    });

    it('stays quiet without the node\'s pods, so a missing watch is not a finding', () => {
        expect(lspDown.evaluate(logicalContext(withPort(false), { now: NOW }))).toEqual([]);
    });

    it('stays quiet while the pod is starting, pending, or not on this node', () => {
        const recent = new Date(NOW - LSP_DOWN_GRACE_MS + 1000).toISOString();
        expect(lspDown.evaluate(logicalContext(withPort(false), { pods: [pod({ startTime: recent })], now: NOW }))).toEqual([]);
        expect(lspDown.evaluate(logicalContext(withPort(false), { pods: [pod({ phase: 'Pending' })], now: NOW }))).toEqual([]);
        expect(lspDown.evaluate(logicalContext(withPort(false), { pods: [], now: NOW }))).toEqual([]);
    });

    it('stays quiet for a port disabled on purpose, or with up unset', () => {
        expect(lspDown.evaluate(logicalContext(withPort(false, false), { pods: [pod()], now: NOW }))).toEqual([]);
        expect(lspDown.evaluate(logicalContext(withPort(undefined), { pods: [pod()], now: NOW }))).toEqual([]);
    });
});
