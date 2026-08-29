import { formatSubnets, subnetCidrs } from './subnets';

describe('formatSubnets', () => {
    it('passes Layer2 CIDR strings through', () => {
        expect(formatSubnets(['10.1.2.0/24', 'fd01::/64'])).toBe('10.1.2.0/24, fd01::/64');
    });

    it('renders Layer3 subnet objects with cidr and hostSubnet', () => {
        expect(formatSubnets([{ cidr: '10.3.0.0/16', hostSubnet: 24 }])).toBe(
            '10.3.0.0/16 (hostSubnet /24)',
        );
    });

    it('omits the hostSubnet suffix when absent', () => {
        expect(formatSubnets([{ cidr: '10.3.0.0/16' }])).toBe('10.3.0.0/16');
    });

    it('handles empty and undefined lists', () => {
        expect(formatSubnets(undefined)).toBe('');
        expect(formatSubnets([])).toBe('');
    });
});

describe('subnetCidrs', () => {
    it('extracts bare CIDRs from either topology shape', () => {
        expect(subnetCidrs(['10.1.2.0/24', { cidr: '10.3.0.0/16', hostSubnet: 24 }])).toEqual([
            '10.1.2.0/24',
            '10.3.0.0/16',
        ]);
    });
});
