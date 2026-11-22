import fs from 'fs';
import path from 'path';

import type { ConfigMap, OperatorNetwork } from '../types';
import { appliedNotice, compareAppliedSpec, gatewayModeNotice, parseAppliedSpec } from './cnoAppliedModel';
import { buildCnoConfigModel, NO_CNO_CONFIG_INPUTS, Source } from './cnoConfigModel';

/**
 * The applied-versus-spec comparison (ovn-recon-n7r.5), from the shape the captured 4.22
 * applied-cluster ConfigMap has: the whole spec as JSON under data.applied.
 */

interface Capture {
    operatorNetwork: OperatorNetwork;
    configMaps: { appliedCluster: ConfigMap };
}

const capture = (): Capture => JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'test', 'fixtures', 'network-config', 'ocp-4.22-capture.json'), 'utf-8'),
);

const ok = <T,>(data: T): Source<T> => ({ status: 'ok', data });
const OVN = 'spec.defaultNetwork.ovnKubernetesConfig';

/** The capture with its spec changed after the operator last applied it. */
const edited = (edit: (spec: NonNullable<OperatorNetwork['spec']>) => void) => {
    const data = capture();
    edit(data.operatorNetwork.spec!);
    return { network: ok(data.operatorNetwork), applied: ok(data.configMaps.appliedCluster) };
};

describe('parseAppliedSpec', () => {
    it('reads the captured ConfigMap', () => {
        expect(parseAppliedSpec(capture().configMaps.appliedCluster).spec).toMatchObject({ managementState: 'Managed' });
    });

    it('says why there is no spec', () => {
        expect(parseAppliedSpec({ data: {} }).error).toBe('The ConfigMap has no "applied" key');
        expect(parseAppliedSpec({ data: { applied: '{nope' } }).error).toBe('"applied" is not JSON');
        expect(parseAppliedSpec({ data: { applied: '[1]' } }).error).toBe('"applied" is not a JSON object');
    });
});

describe('compareAppliedSpec', () => {
    it('matches when the spec is what was applied, whatever the key order', () => {
        const { network, applied } = edited(() => undefined);
        expect(compareAppliedSpec(network, applied).status).toBe('match');
    });

    it('names a refused MTU change, with both values', () => {
        const { network, applied } = edited((spec) => { spec.defaultNetwork!.ovnKubernetesConfig!.mtu = 9000; });
        const comparison = compareAppliedSpec(network, applied);
        expect(comparison).toEqual({
            status: 'differs',
            differences: [{ path: `${OVN}.mtu`, spec: '9000', applied: '1400' }],
            text: '1 field not applied yet',
        });
        expect(appliedNotice(comparison)).toMatchObject({ id: 'applied-differs', severity: 'warning', title: 'The network operator has not applied one change to its configuration' });
    });

    it('names each field of a new block, and a changed list', () => {
        const { network, applied } = edited((spec) => {
            spec.defaultNetwork!.ovnKubernetesConfig!.ipsecConfig = { mode: 'Full', full: { encapsulation: 'Always' } };
            spec.serviceNetwork = ['172.30.0.0/16', 'fd02::/112'];
            spec.defaultNetwork!.ovnKubernetesConfig!.hybridOverlayConfig = { hybridClusterNetwork: [{ cidr: '10.132.0.0/14', hostPrefix: 23 }] };
        });
        expect(compareAppliedSpec(network, applied).differences).toEqual([
            { path: `${OVN}.hybridOverlayConfig.hybridClusterNetwork`, spec: '[{"cidr":"10.132.0.0/14","hostPrefix":23}]', applied: 'Not set' },
            { path: `${OVN}.ipsecConfig.full.encapsulation`, spec: 'Always', applied: 'Not set' },
            { path: `${OVN}.ipsecConfig.mode`, spec: 'Full', applied: 'Disabled' },
            { path: 'spec.serviceNetwork', spec: '["172.30.0.0/16","fd02::/112"]', applied: '["172.30.0.0/16"]' },
        ]);
    });

    it('does not count a default the operator filled in when it applied, nor empty against absent', () => {
        const { network, applied } = edited((spec) => {
            delete spec.defaultNetwork!.ovnKubernetesConfig!.policyAuditConfig;
            delete spec.defaultNetwork!.ovnKubernetesConfig!.genevePort;
            spec.defaultNetwork!.ovnKubernetesConfig!.egressIPConfig = undefined;
            (spec as Record<string, unknown>).kubeProxyConfig = {};
        });
        expect(compareAppliedSpec(network, applied).status).toBe('match');
    });

    it('fails soft when the ConfigMap is forbidden, absent or unreadable, and waits while loading', () => {
        const network = ok(capture().operatorNetwork);
        expect(compareAppliedSpec(network, { status: 'forbidden', message: 'no' }))
            .toEqual({ status: 'unavailable', differences: [], text: 'ConfigMap applied-cluster is not visible to you' });
        expect(compareAppliedSpec(network, { status: 'absent' }).text).toBe('ConfigMap applied-cluster is not present');
        expect(compareAppliedSpec(network, ok({ data: { applied: 'x' } })).status).toBe('unreadable');
        expect(compareAppliedSpec(network, { status: 'loading' }).status).toBe('loading');
        expect(compareAppliedSpec({ status: 'forbidden' }, ok(capture().configMaps.appliedCluster)).text)
            .toBe('The network operator configuration could not be read');
        expect(appliedNotice(compareAppliedSpec(network, { status: 'forbidden' }))).toBeUndefined();
    });
});

describe('the comparison in the Network config model', () => {
    const inputs = (network: Source<OperatorNetwork>, applied: Source<ConfigMap>) => ({
        ...NO_CNO_CONFIG_INPUTS,
        operatorNetwork: network,
        configMaps: { ...NO_CNO_CONFIG_INPUTS.configMaps, appliedCluster: applied },
    });

    it('warns and notes the row when a change is pending', () => {
        const { network, applied } = edited((spec) => { spec.defaultNetwork!.ovnKubernetesConfig!.genevePort = 6082; });
        const model = buildCnoConfigModel(inputs(network, applied));
        expect(model.notices.map((notice) => notice.id)).toEqual(['applied-differs']);
        expect(model.sections.find((section) => section.id === 'operator')?.rows.find((row) => row.id === 'applied-configuration'))
            .toMatchObject({ value: '1 field not applied yet', note: 'A change was refused or is still pending' });
    });

    it('keeps the rest of the view and says why when the ConfigMap is forbidden', () => {
        const model = buildCnoConfigModel(inputs(ok(capture().operatorNetwork), { status: 'forbidden', message: 'no' }));
        expect(model.notices).toEqual([]);
        expect(model.sections.length).toBeGreaterThan(0);
        expect(model.sections.flatMap((section) => section.rows).find((row) => row.id === 'applied-configuration')?.value)
            .toBe('ConfigMap applied-cluster is not visible to you');
    });
});

describe('gatewayModeNotice', () => {
    const cm = (data: Record<string, string>): Source<ConfigMap> => ok({ data });

    it('says nothing when the ConfigMap is absent or forbidden', () => {
        expect(gatewayModeNotice({ status: 'absent' }, true)).toBeUndefined();
        expect(gatewayModeNotice({ status: 'forbidden' }, true)).toBeUndefined();
    });

    it('notes a mode that agrees with routingViaHost, and warns of one that does not', () => {
        expect(gatewayModeNotice(cm({ mode: 'local' }), true)).toMatchObject({ severity: 'info', body: 'mode: local, which agrees with routingViaHost' });
        expect(gatewayModeNotice(cm({ mode: 'Shared' }), true)).toMatchObject({ severity: 'warning', body: 'mode: shared, which disagrees with routingViaHost (local)' });
    });

    it('says when the mode key is missing or unknown, and lists other keys', () => {
        expect(gatewayModeNotice(cm({ other: '1' }), false)?.body).toBe('No mode key; other: 1');
        expect(gatewayModeNotice(cm({ mode: 'hybrid' }), false)?.body).toBe('mode: hybrid (not a mode the operator knows)');
    });
});
