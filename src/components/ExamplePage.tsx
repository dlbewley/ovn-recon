import * as React from 'react';
import { Page, PageSection, Title, Card, CardBody } from '@patternfly/react-core';
import { Helmet } from 'react-helmet';

const ExamplePage: React.FC = () => {
    return (
        <>
            <Helmet>
                <title>Example Plugin Page</title>
            </Helmet>
            <PageSection>
                <Title headingLevel="h1">Example Plugin Page</Title>
            </PageSection>
            <PageSection isFilled >
                <Card isFullHeight>
                    <CardBody>
                        Hello from the OpenShift Console Plugin!
                    </CardBody>
                </Card>
            </PageSection>
        </>
    );
};

export default ExamplePage;
