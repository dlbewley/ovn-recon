import { Layer3Subnet } from '../types';

/**
 * Render a UDN/CUDN subnets list for display. The CRD schemas differ per
 * topology: Layer2 subnets are plain CIDR strings, Layer3 subnets are
 * {cidr, hostSubnet} objects — joining the raw array stringifies the latter
 * to "[object Object]" (ovn-recon-s3t.50). hostSubnet is the per-node prefix
 * length carved out of the cidr.
 */
/** Bare CIDRs from either topology's subnet shape, for containment checks. */
export const subnetCidrs = (subnets?: (string | Layer3Subnet)[]): string[] =>
    (subnets ?? [])
        .map((subnet) => (typeof subnet === 'string' ? subnet : subnet.cidr))
        .filter(Boolean);

export const formatSubnets = (subnets?: (string | Layer3Subnet)[]): string =>
    (subnets ?? [])
        .map((subnet) => {
            if (typeof subnet === 'string') return subnet;
            if (subnet.hostSubnet != null) return `${subnet.cidr} (hostSubnet /${subnet.hostSubnet})`;
            return subnet.cidr;
        })
        .filter(Boolean)
        .join(', ');
