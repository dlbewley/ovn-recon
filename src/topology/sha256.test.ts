import { createHash } from 'crypto';

import { sha256Hex } from './sha256';

const reference = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

describe('sha256Hex', () => {
    it('matches the published test vectors', () => {
        expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
        expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('agrees with the platform implementation across block boundaries', () => {
        // 55, 56 and 64 bytes are where the padding changes shape.
        [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 300].forEach((length) => {
            const input = 'vtep-name-'.repeat(40).slice(0, length);
            expect(sha256Hex(input)).toBe(reference(input));
        });
    });

    it('hashes UTF-8 bytes, not UTF-16 code units', () => {
        ['é', '網路', 'vtep-😀', 'a\u0000b'].forEach((input) => {
            expect(sha256Hex(input)).toBe(reference(input));
        });
    });

    it('reproduces the device suffix OVN-Kubernetes derived on a real node', () => {
        // evx4.4a75265e and evbr.4a75265e in test/fixtures/nns/evpn-vxlan.json.
        expect(sha256Hex('demo-evpn-vteps').slice(0, 8)).toBe('4a75265e');
    });
});
