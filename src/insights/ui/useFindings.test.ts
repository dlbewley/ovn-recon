import { makeFinding, nodeRef } from '../refs';
import type { NodeNetworkState } from '../../types';
import type { Finding } from '../types';
import {
    clusterNodeNetworkStates, HIDE_INFO_STORAGE_KEY, readHideInfo, visibleFindings, writeHideInfo
} from './useFindings';

const finding = (severity: Finding['severity'], summary: string): Finding => makeFinding({
    ruleId: `rule-${severity}`, severity,
    subject: { kind: 'graph-node', node: 'n', graphNodeId: `iface:${summary}` },
    scope: { node: 'n' }, summary, evidence: [], remedy: { text: '', target: nodeRef('n') }
});

describe('hide info findings preference', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        window.localStorage.clear();
    });

    it('defaults to showing info, and remembers a choice', () => {
        expect(readHideInfo()).toBe(false);
        writeHideInfo(true);
        expect(window.localStorage.getItem(HIDE_INFO_STORAGE_KEY)).toBe('true');
        expect(readHideInfo()).toBe(true);
        writeHideInfo(false);
        expect(readHideInfo()).toBe(false);
    });

    it('reads "not hidden" and writes nothing when storage throws', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('QuotaExceededError'); });
        expect(readHideInfo()).toBe(false);
        expect(() => writeHideInfo(true)).not.toThrow();
    });

    it('drops info findings only when hidden', () => {
        const findings = [finding('warning', 'a'), finding('info', 'b')];
        expect(visibleFindings(findings, false)).toBe(findings);
        expect(visibleFindings(findings, true).map((f) => f.summary)).toEqual(['a']);
    });
});

describe('clusterNodeNetworkStates', () => {
    it('is undefined until the list is loaded and non-empty, so cluster rules stay quiet', () => {
        const list = [{ metadata: { name: 'a' } }] as NodeNetworkState[];
        expect(clusterNodeNetworkStates(list, false)).toBeUndefined();
        expect(clusterNodeNetworkStates([], true)).toBeUndefined();
        expect(clusterNodeNetworkStates(undefined, true)).toBeUndefined();
        expect(clusterNodeNetworkStates(null, true)).toBeUndefined();
        expect(clusterNodeNetworkStates(list, true)).toBe(list);
    });
});
