import { GraphContext } from './context';
import { AnyNodeTypeDescriptor } from './descriptors';
import { nodeKindRegistry } from './registry';
import { NodeViewModel } from './types';

/**
 * Build the view model for one graph node.
 *
 * This used to be a ladder of `type === '...'` branches, one per node type, each
 * assembling the same nine fields differently. Each descriptor now supplies its own
 * presentation, so the ladder is a lookup and adding a node type touches nothing here.
 */
export const buildNodeViewModel = (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    item: any,
    descriptor: AnyNodeTypeDescriptor,
    ctx: GraphContext
): NodeViewModel => {
    const presentation = descriptor.present(item, ctx);

    const node: NodeViewModel = {
        id: descriptor.id(item, ctx),
        kind: descriptor.kind,
        iconType: descriptor.type,
        label: presentation.label,
        title: presentation.label,
        subtitle: presentation.subtitle,
        graphDisplayLabel: presentation.graphLabel,
        state: presentation.state,
        namespaces: presentation.namespaces,
        resourceRef: presentation.resourceRef,
        isSynthetic: presentation.isSynthetic,
        raw: item
    };

    // Drawer badges still come from the per-kind registry.
    const definition = nodeKindRegistry[descriptor.kind];
    if (definition.buildBadges) node.badges = definition.buildBadges(node);

    return node;
};
