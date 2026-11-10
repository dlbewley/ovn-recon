import { parseNadConfig } from '../../components/nodeVisualizationSelectors';
import { makeFinding, nadRef } from '../refs';
import type { Evidence, PhysicalRule } from '../types';

/** What the topology view's regex fallback recovers from a config it cannot parse. */
const FALLBACK_FIELDS = ['type', 'bridge', 'physicalNetworkName'];

const parseError = (config: string): string => {
    try {
        JSON.parse(config);
        return 'it is JSON, but not a JSON object';
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
};

/**
 * nad-config-unparsed: a NAD's spec.config is not a JSON object, so the topology view
 * fell back to pattern-matching a few fields out of the text. What it drew for that
 * NAD is a guess; Multus parses the same text as JSON, so attachments through the NAD
 * may fail as well. An empty config, or one the API client already parsed, is not a
 * finding.
 */
export const nadConfigUnparsed: PhysicalRule = {
    id: 'nad-config-unparsed',
    severity: 'warning',
    scope: 'network',
    domain: 'physical',
    title: 'NAD config is not valid JSON',
    evaluate: ({ cluster }) => cluster.nads.flatMap((nad) => {
        const config = nad.spec?.config;
        if (typeof config !== 'string' || config.trim() === '' || parseNadConfig(config)) return [];
        const ref = nadRef(nad);
        const label = `${ref.namespace}/${ref.name}`;
        const recovered = FALLBACK_FIELDS
            .map((field) => [field, new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`).exec(config)?.[1]] as const)
            .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
        const evidence: Evidence[] = [{
            fact: `spec.config does not parse as a JSON object: ${parseError(config)}.`,
            sources: [ref],
            path: 'spec.config'
        }];
        if (recovered.length > 0) {
            evidence.push({
                fact: `The view read ${recovered.map(([field, value]) => `${field} ${value}`).join(', ')} from it by pattern.`,
                sources: [ref],
                path: 'spec.config',
                inferred: 'Matched by regular expression in text that is not JSON.'
            });
        }
        return [makeFinding({
            ruleId: nadConfigUnparsed.id,
            severity: nadConfigUnparsed.severity,
            subject: { kind: 'k8s', ref },
            scope: { network: ref },
            summary: `NetworkAttachmentDefinition ${label} has a spec.config that is not valid JSON.`,
            evidence,
            remedy: {
                text: `Rewrite the spec.config of ${label} as one JSON object.`,
                target: ref,
                path: 'spec.config'
            }
        })];
    })
};
