import * as React from 'react';
import { Alert, PageSection } from '@patternfly/react-core';

/**
 * Keeps a failure inside an OVN Recon tab inside the tab (ovn-recon-zdt.1). The tab
 * renders on a console page the plugin does not own; whatever goes wrong in it must
 * leave the rest of that page working.
 */
export class IntegrationErrorBoundary extends React.Component<
    { children: React.ReactNode },
    { error: Error | null }
> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    render() {
        if (this.state.error) {
            return (
                <PageSection>
                    <Alert variant="danger" isInline title="OVN Recon could not render this tab" data-testid="ovn-recon-tab-error">
                        {this.state.error.message}
                    </Alert>
                </PageSection>
            );
        }
        return this.props.children;
    }
}
