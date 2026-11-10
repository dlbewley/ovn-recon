import { constructDisplayName, constructIdentifiers } from './constructIdentity';

describe('construct identity (ovn-recon-dp7.1)', () => {
    it('drops a CUDN network prefix, written with dots, from the display name', () => {
        expect(constructDisplayName({ name: 'cluster_udn_example.p.cudn_transit_router', network: 'cluster_udn_example-p-cudn' }))
            .toBe('transit_router');
    });

    it('keeps a name that does not carry its network prefix', () => {
        expect(constructDisplayName({ name: 'GR_cnv-1', network: 'default' })).toBe('GR_cnv-1');
        expect(constructDisplayName({ name: 'GR_cnv-1', network: 'cluster_udn_example-p-cudn' })).toBe('GR_cnv-1');
        // A name that is only the prefix stays whole.
        expect(constructDisplayName({ name: 'cluster_udn_x_', network: 'cluster_udn_x' })).toBe('cluster_udn_x_');
    });

    it('lists the OVN name only when it differs from the display name, then the UUID', () => {
        expect(constructIdentifiers({ name: 'GR_cnv-1', network: 'default', uuid: 'u-1' })).toEqual([
            { label: 'UUID', value: 'u-1' },
        ]);
        expect(constructIdentifiers({
            name: 'cluster_udn_machinenet_ovn_localnet_switch', network: 'cluster_udn_machinenet', uuid: 'u-2',
        })).toEqual([
            { label: 'OVN name', value: 'cluster_udn_machinenet_ovn_localnet_switch' },
            { label: 'UUID', value: 'u-2' },
        ]);
    });
});
