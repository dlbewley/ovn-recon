import { classifySwitchPort } from '../../components/logicalClassification';
import type { Pod } from '../../types';
import { constructSubject, snapshotFact, switchByPort } from '../logical';
import { makeFinding, podRef } from '../refs';
import type { LogicalRule } from '../types';

/**
 * How long a pod must have been running before a down port counts. A pod's port
 * comes up while its sandbox is created, before the containers run, so a running
 * pod normally has an up port; the grace absorbs a snapshot taken mid-change.
 */
export const LSP_DOWN_GRACE_MS = 2 * 60 * 1000;

const podKey = (namespace: string, name: string): string => `${namespace}/${name}`;

/**
 * lsp-down: a pod's Logical_Switch_Port reports up=false while the pod has been
 * Running on this node for longer than LSP_DOWN_GRACE_MS.
 *
 * "Running" is read from the node's own pods (a watch on spec.nodeName, not a
 * cluster-wide pod list): under interconnect a zone's pod ports are that node's
 * pods. Quiet without that list, for a port whose pod is not on it, for a port the
 * NB leaves `up` unset, and for a port disabled on purpose (enabled=false).
 */
export const lspDown: LogicalRule = {
    id: 'lsp-down',
    severity: 'warning',
    scope: 'node',
    domain: 'logical',
    title: 'Running pod with its port down',
    evaluate: ({ nodeName, snapshot, pods, now }) => {
        const database = snapshot.database;
        if (!database || !pods) return [];
        const at = now ?? Date.now();
        const podsByKey = new Map<string, Pod>();
        pods.forEach((pod) => {
            const namespace = pod.metadata?.namespace;
            const name = pod.metadata?.name;
            if (namespace && name) podsByKey.set(podKey(namespace, name), pod);
        });
        const switches = switchByPort(database.logicalSwitches);

        return database.logicalSwitchPorts.flatMap((row) => {
            if (row.up !== false || row.enabled === false || row.externalIds?.pod !== 'true') return [];
            const port = classifySwitchPort(row);
            if (port.role !== 'pod-port' || !port.namespace || !port.pod) return [];
            const pod = podsByKey.get(podKey(port.namespace, port.pod));
            if (!pod || pod.status?.phase !== 'Running') return [];
            const started = Date.parse(pod.status?.startTime ?? '');
            if (!Number.isFinite(started) || at - started < LSP_DOWN_GRACE_MS) return [];
            const logicalSwitch = switches.get(row.uuid);
            if (!logicalSwitch) return [];
            const ref = podRef(port.namespace, port.pod);
            return [makeFinding({
                ruleId: lspDown.id,
                severity: lspDown.severity,
                subject: constructSubject(nodeName, 'switch', logicalSwitch.name),
                scope: { node: nodeName },
                summary: `Pod ${port.namespace}/${port.pod} is running on ${nodeName}, but its port ${row.name} is down.`,
                evidence: [
                    snapshotFact(nodeName, `Logical_Switch_Port ${row.name} has up=false.`,
                        `Logical_Switch_Port[name=${row.name}].up`),
                    {
                        fact: `The pod is Running, and has been since ${pod.status?.startTime}.`,
                        sources: [ref],
                        path: 'status.phase'
                    }
                ],
                remedy: {
                    text: `up=false means ovn-controller on ${nodeName} has not bound this port, so the pod's `
                        + 'traffic on this network is likely dropped. Look for errors about the port in the '
                        + `ovn-controller container of the ovnkube-node pod on ${nodeName}; deleting the pod, if `
                        + 'its controller recreates it, gives it a new port.',
                    target: ref,
                    verb: 'view'
                }
            }, row.name)];
        });
    }
};
