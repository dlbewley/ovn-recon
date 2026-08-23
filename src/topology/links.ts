import { ResourceRef, NodeLink } from './types';

/** Console path for a resource, e.g. /k8s/ns/foo/k8s.ovn.org~v1~ClusterUserDefinedNetwork/bar. */
export const getResourcePath = (ref: ResourceRef): string => {
    const resourceId = ref.apiVersion ? `${ref.apiVersion.replace('/', '~')}~${ref.kind}` : ref.kind;
    const base = ref.namespace ? `/k8s/ns/${ref.namespace}` : '/k8s/cluster';
    return `${base}/${resourceId}/${ref.name}`;
};

export const getResourceLinks = (ref: ResourceRef): NodeLink[] => {
    const resourcePath = getResourcePath(ref);
    return [
        { label: 'Resource', href: resourcePath },
        { label: 'YAML', href: `${resourcePath}/yaml` }
    ];
};
