/**
 * IPv4 and IPv6 addresses and prefixes as numbers, for containment tests and
 * numeric ordering. OVN stores addresses as strings in several spellings: a
 * bare address (`10.0.0.5`), an address with its prefix length on a router
 * port (`10.131.0.1/23`), and a network prefix on a route (`10.128.0.0/14`).
 */

export interface ParsedPrefix {
    family: 4 | 6;
    /** The address as written, before masking. */
    address: bigint;
    /** The network address: `address` with host bits cleared. */
    network: bigint;
    length: number;
}

const parseIpv4 = (text: string): bigint | null => {
    const octets = text.split('.');
    if (octets.length !== 4) return null;
    let value = 0n;
    for (const octet of octets) {
        if (!/^\d{1,3}$/.test(octet)) return null;
        const n = Number(octet);
        if (n > 255) return null;
        value = (value << 8n) | BigInt(n);
    }
    return value;
};

const parseIpv6 = (text: string): bigint | null => {
    const halves = text.toLowerCase().split('::');
    if (halves.length > 2) return null;
    const groups = (part: string): string[] | null => {
        if (part === '') return [];
        const items = part.split(':');
        return items.every((item) => /^[0-9a-f]{1,4}$/.test(item)) ? items : null;
    };
    const head = groups(halves[0]);
    const tail = halves.length === 2 ? groups(halves[1]) : [];
    if (head === null || tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
    const all = [...head, ...Array<string>(missing).fill('0'), ...tail];
    return all.reduce((value, group) => (value << 16n) | BigInt(parseInt(group, 16)), 0n);
};

/** Parse an address or prefix; a bare address is a host prefix (/32 or /128). */
export const parsePrefix = (text: string): ParsedPrefix | null => {
    const [addressText, lengthText, extra] = text.trim().split('/');
    if (extra !== undefined || !addressText) return null;
    const v4 = parseIpv4(addressText);
    const family = v4 !== null ? 4 : 6;
    const address = v4 ?? parseIpv6(addressText);
    if (address === null) return null;
    const width = family === 4 ? 32 : 128;
    const length = lengthText === undefined ? width : Number(lengthText);
    if (!Number.isInteger(length) || length < 0 || length > width || (lengthText !== undefined && !/^\d+$/.test(lengthText))) {
        return null;
    }
    const hostBits = BigInt(width - length);
    const network = (address >> hostBits) << hostBits;
    return { family, address, network, length };
};

/** True when the address (or every address of the inner prefix) lies inside `outer`. */
export const prefixContains = (outer: ParsedPrefix, inner: ParsedPrefix): boolean => {
    if (outer.family !== inner.family || inner.length < outer.length) return false;
    const width = outer.family === 4 ? 32 : 128;
    const hostBits = BigInt(width - outer.length);
    return (inner.network >> hostBits) === (outer.network >> hostBits);
};

const formatIpv4 = (value: bigint): string =>
    [24n, 16n, 8n, 0n].map((shift) => ((value >> shift) & 255n).toString()).join('.');

const formatIpv6 = (value: bigint): string => {
    const groups = Array.from({ length: 8 }, (_, i) => Number((value >> BigInt(112 - 16 * i)) & 0xffffn));
    // Compress the longest run of two or more zero groups (RFC 5952).
    let bestStart = -1;
    let bestLength = 0;
    for (let i = 0; i < 8; ) {
        if (groups[i] !== 0) {
            i += 1;
            continue;
        }
        let j = i;
        while (j < 8 && groups[j] === 0) j += 1;
        if (j - i > bestLength && j - i >= 2) {
            bestStart = i;
            bestLength = j - i;
        }
        i = j;
    }
    const hex = groups.map((group) => group.toString(16));
    if (bestStart < 0) return hex.join(':');
    return `${hex.slice(0, bestStart).join(':')}::${hex.slice(bestStart + bestLength).join(':')}`;
};

/** The prefix's network in CIDR form: `10.131.0.1/23` → `10.131.0.0/23`. */
export const networkCidr = (prefix: ParsedPrefix): string =>
    `${prefix.family === 4 ? formatIpv4(prefix.network) : formatIpv6(prefix.network)}/${prefix.length}`;

/** True for 0.0.0.0/0 and ::/0. */
export const isDefaultPrefix = (text: string): boolean => parsePrefix(text)?.length === 0;

/** True when the text names a single address: bare, /32 or /128. */
export const isHostAddress = (text: string): boolean => {
    const parsed = parsePrefix(text);
    return parsed !== null && parsed.length === (parsed.family === 4 ? 32 : 128);
};

/**
 * Numeric order for prefixes and addresses: IPv4 before IPv6, then network
 * address, then shorter prefix first. Unparseable text sorts last, by text.
 */
export const comparePrefixes = (a: string, b: string): number => {
    const pa = parsePrefix(a);
    const pb = parsePrefix(b);
    if (!pa || !pb) return (pa ? -1 : 0) + (pb ? 1 : 0) || a.localeCompare(b);
    if (pa.family !== pb.family) return pa.family - pb.family;
    if (pa.network !== pb.network) return pa.network < pb.network ? -1 : 1;
    return pa.length - pb.length;
};
