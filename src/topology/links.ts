import { LabelSelector } from '../types';
import { ResourceRef, NodeLink } from './types';

/** Console path for a resource, e.g. /k8s/ns/foo/k8s.ovn.org~v1~ClusterUserDefinedNetwork/bar. */
export const getResourcePath = (ref: ResourceRef): string => {
    const resourceId = ref.apiVersion ? `${ref.apiVersion.replace('/', '~')}~${ref.kind}` : ref.kind;
    const base = ref.namespace ? `/k8s/ns/${ref.namespace}` : '/k8s/cluster';
    return `${base}/${resourceId}/${ref.name}`;
};

/**
 * Console path for a namespace itself. On OpenShift the namespace landing page is
 * the Project view -- a bare /k8s/ns/<name> is not a valid destination.
 */
export const getProjectPath = (namespace: string): string =>
    `/k8s/cluster/projects/${namespace}`;

/**
 * Console path listing the namespaces a label selector matches, e.g.
 * /api-resource/cluster/core~v1~Namespace/instances?label=network%2Fmachine%3D
 *
 * Only pure matchLabels selectors serialize into the console's label filter;
 * for anything with matchExpressions this returns undefined and the caller
 * shows the selector as text -- an honest non-link beats a wrong query.
 */
export const getNamespaceQueryPath = (selector: LabelSelector | undefined): string | undefined => {
    const labels = Object.entries(selector?.matchLabels || {});
    if (labels.length === 0 || selector?.matchExpressions?.length) {
        return undefined;
    }
    const params = labels
        .map(([key, value]) => `label=${encodeURIComponent(`${key}=${value}`)}`)
        .join('&');
    return `/api-resource/cluster/core~v1~Namespace/instances?${params}`;
};

export const getResourceLinks = (ref: ResourceRef): NodeLink[] => {
    const resourcePath = getResourcePath(ref);
    return [
        { label: 'Resource', href: resourcePath },
        { label: 'YAML', href: `${resourcePath}/yaml` }
    ];
};
