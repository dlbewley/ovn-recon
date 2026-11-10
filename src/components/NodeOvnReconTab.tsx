import * as React from 'react';
import { PageSection, Title } from '@patternfly/react-core';
import { K8sResourceCommon, useK8sModel } from '@openshift-console/dynamic-plugin-sdk';

import { IntegrationErrorBoundary } from './IntegrationErrorBoundary';
import { NodeNetworkStateBody, NoNodeNetworkState } from './NodeNetworkStateDetails';

/**
 * The "OVN Recon" tab on the console's Node details page (ovn-recon-zdt.1), at
 * /k8s/cluster/nodes/:name/ovn-recon. Gated on OVN_RECON_RESOURCE_TABS in
 * console-extensions.json. It renders the physical page's own body for the node.
 *
 * Selection: the embedded graph reads and writes ?select= on the host page's URL,
 * exactly as on the physical page. It writes with replace and touches no other query
 * parameter (useSelectParam.withSelectParam), so the host page's own parameters
 * survive, a selected node survives a reload of the tab, and the "Open physical
 * topology" link carries the selection over.
 */

const NNS_GVK = { group: 'nmstate.io', version: 'v1beta1', kind: 'NodeNetworkState' };

const NodeOvnReconTabBody: React.FC<{ name: string }> = ({ name }) => {
    // A cluster without the NMState Operator serves no NodeNetworkState. Say so rather
    // than watch a kind the console has no model for.
    const [model, inFlight] = useK8sModel(NNS_GVK);
    if (inFlight) {
        return <PageSection><Title headingLevel="h2">Loading...</Title></PageSection>;
    }
    if (!model) {
        return (
            <NoNodeNetworkState
                name={name}
                reason="This cluster does not serve NodeNetworkState, which the Kubernetes NMState Operator provides, so OVN Recon has no physical topology to draw."
            />
        );
    }
    return <NodeNetworkStateBody name={name} embedded />;
};

const NodeOvnReconTab: React.FC<{ obj?: K8sResourceCommon }> = ({ obj }) => {
    const name = obj?.metadata?.name;
    return (
        <IntegrationErrorBoundary>
            {name
                ? <NodeOvnReconTabBody name={name} />
                : <PageSection><Title headingLevel="h2">Loading...</Title></PageSection>}
        </IntegrationErrorBoundary>
    );
};

export default NodeOvnReconTab;
