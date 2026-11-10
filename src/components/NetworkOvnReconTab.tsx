import * as React from 'react';
import { EmptyState, EmptyStateBody, PageSection, Title } from '@patternfly/react-core';
import { K8sResourceCommon } from '@openshift-console/dynamic-plugin-sdk';
import { Link } from 'react-router';

import { networkAddressOf } from './consoleIntegration';
import { IntegrationErrorBoundary } from './IntegrationErrorBoundary';
import { NetworkBody, NetworkTabHeader, useNetworkData } from './NetworkDetails';
import { findNetwork, NETWORKS_PATH } from './networkPageModel';

/**
 * The "OVN Recon" tab on the console's ClusterUserDefinedNetwork, UserDefinedNetwork
 * and NetworkAttachmentDefinition details pages (ovn-recon-zdt.1). Gated on
 * OVN_RECON_RESOURCE_TABS in console-extensions.json. It renders the network page's
 * own body: findings, summary and placement by node, with a link to the full page.
 * A NAD with no CUDN or UDN behind it renders like any other network.
 */

const NetworkOvnReconTabBody: React.FC<{ obj: K8sResourceCommon; kind: string }> = ({ obj, kind }) => {
    const { inputs, loaded, nns, showLogical } = useNetworkData();
    const address = React.useMemo(() => networkAddressOf(obj, kind), [obj, kind]);
    const record = React.useMemo(
        () => (address ? findNetwork(address, inputs) : undefined),
        [address, inputs],
    );

    if (!loaded) {
        return <PageSection><Title headingLevel="h2">Loading...</Title></PageSection>;
    }
    if (!record) {
        return (
            <PageSection>
                <EmptyState data-testid="ovn-recon-tab-no-network">
                    <Title headingLevel="h4" size="lg">OVN Recon cannot see this network</Title>
                    <EmptyStateBody>
                        The network is not in what OVN Recon could read.{' '}
                        <Link to={NETWORKS_PATH}>See every network OVN Recon can see</Link>.
                    </EmptyStateBody>
                </EmptyState>
            </PageSection>
        );
    }
    return (
        <>
            <NetworkTabHeader record={record} />
            <NetworkBody record={record} inputs={inputs} nns={nns} showLogical={showLogical} />
        </>
    );
};

/** One component per kind would be three copies of this; the kind comes from the model. */
const makeNetworkTab = (kind: string): React.FC<{ obj?: K8sResourceCommon }> => {
    const NetworkTab: React.FC<{ obj?: K8sResourceCommon }> = ({ obj }) => (
        <IntegrationErrorBoundary>
            {obj
                ? <NetworkOvnReconTabBody obj={obj} kind={obj.kind ?? kind} />
                : <PageSection><Title headingLevel="h2">Loading...</Title></PageSection>}
        </IntegrationErrorBoundary>
    );
    NetworkTab.displayName = `${kind}OvnReconTab`;
    return NetworkTab;
};

export const ClusterUserDefinedNetworkTab = makeNetworkTab('ClusterUserDefinedNetwork');
export const UserDefinedNetworkTab = makeNetworkTab('UserDefinedNetwork');
export const NetworkAttachmentDefinitionTab = makeNetworkTab('NetworkAttachmentDefinition');
