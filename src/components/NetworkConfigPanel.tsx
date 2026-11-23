import * as React from 'react';
import { Alert, Card, CardBody, CardTitle, ExpandableSection, Label, Spinner, Stack, StackItem } from '@patternfly/react-core';
import { Table, Tbody, Td, Th, Thead, Tr } from '@patternfly/react-table';
import { Link } from 'react-router';

import { ConsoleLink } from '../linkOut/LinkOut';
import AppliedSpecCard from './AppliedSpecCard';
import { resourceTarget } from '../linkOut/registry';
import { networkPath } from '../routes';
import type {
    Capability, CapabilityStatus, CnoConfigModel, ConditionRow, ConditionSeverity, ConfigRow, ConfigSection, PrerequisiteState,
    RowOrigin, SourceSummary
} from './cnoConfigModel';
import type { MasqueradeFamilyLayout, MasqueradeLayout, MasqueradeLayoutNote, MasqueradeSubnetLayout } from './masqueradeLayoutModel';

/**
 * The Network config tab's body (ovn-recon-n7r.1): the capability checklist first
 * (n7r.2), then the cluster network configuration as `cnoConfigModel` grouped it, with
 * the masquerade subnet's capacity and address layout after the addressing section
 * (n7r.4). Read-only; it draws no page chrome, and every link to a console page goes
 * through the link-out registry.
 */

const subtle: React.CSSProperties = { color: 'var(--pf-t--global--text--color--subtle)' };
const small: React.CSSProperties = { ...subtle, fontSize: 'var(--pf-t--global--font--size--sm)' };

const ORIGIN: Record<RowOrigin, { text: string; color: 'blue' | 'grey' | 'teal' }> = {
    set: { text: 'Set', color: 'blue' },
    default: { text: 'Default', color: 'grey' },
    reported: { text: 'Reported', color: 'teal' },
    unset: { text: 'Not set', color: 'grey' },
};

const SettingRow: React.FC<{ row: ConfigRow }> = ({ row }) => (
    <Tr data-testid={`network-config-row-${row.id}`}>
        <Td dataLabel="Setting">{row.label}</Td>
        <Td dataLabel="Value">
            <span data-testid="network-config-value">{row.value}</span>
            {row.note && <div style={small}>{row.note}</div>}
        </Td>
        <Td dataLabel="Set or default">
            <Label isCompact color={ORIGIN[row.origin].color} data-testid="network-config-origin">{ORIGIN[row.origin].text}</Label>
            {row.immutable && (
                <>
                    {' '}
                    <Label isCompact color="orange" data-testid="network-config-immutable">Immutable</Label>
                    <div style={small}>{row.immutable}</div>
                </>
            )}
        </Td>
        <Td dataLabel="Source">
            <div style={small}>{row.source}</div>
            <code style={{ fontSize: 'var(--pf-t--global--font--size--sm)', overflowWrap: 'anywhere' }}>{row.sourcePath}</code>
        </Td>
    </Tr>
);

const SectionCard: React.FC<{ section: ConfigSection }> = ({ section }) => (
    <Card data-testid={`network-config-section-${section.id}`}>
        <CardTitle>
            {section.title}
            <span style={{ ...small, fontWeight: 'normal', marginInlineStart: 'var(--pf-t--global--spacer--md)' }}>
                <ConsoleLink target={{ type: 'api-resource', kind: section.docs }} hideWhenAbsent />
            </span>
        </CardTitle>
        <CardBody>
            <Table variant="compact" aria-label={section.title}>
                <Thead>
                    <Tr>
                        <Th width={25}>Setting</Th>
                        <Th width={30}>Value</Th>
                        <Th width={20}>Set or default</Th>
                        <Th>Source</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {section.rows.map((row) => <SettingRow key={row.id} row={row} />)}
                </Tbody>
            </Table>
        </CardBody>
    </Card>
);

const CAPABILITY_COLOR: Record<CapabilityStatus, 'green' | 'grey' | 'blue'> = {
    ready: 'green',
    'not-ready': 'grey',
    unknown: 'blue',
};

const PREREQUISITE: Record<PrerequisiteState, { text: string; color: 'green' | 'orange' | 'blue' }> = {
    met: { text: 'Met', color: 'green' },
    unmet: { text: 'Not met', color: 'orange' },
    unknown: { text: 'Unknown', color: 'blue' },
};

const CapabilityBlock: React.FC<{ capability: Capability }> = ({ capability }) => (
    <section
        aria-label={capability.label}
        data-testid={`network-config-capability-${capability.id}`}
        data-status={capability.status}
        style={{ marginBlockEnd: 'var(--pf-t--global--spacer--lg)' }}
    >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--pf-t--global--spacer--sm)', alignItems: 'baseline' }}>
            <strong>{capability.label}</strong>
            <Label isCompact color={CAPABILITY_COLOR[capability.status]} data-testid="network-config-capability-status">
                {capability.statusText}
            </Label>
        </div>
        <Table variant="compact" aria-label={`${capability.label} prerequisites`}>
            <Thead>
                <Tr>
                    <Th width={10}>State</Th>
                    <Th width={30}>Prerequisite</Th>
                    <Th width={25}>Actual</Th>
                    <Th>Source</Th>
                </Tr>
            </Thead>
            <Tbody>
                {capability.prerequisites.map((prerequisite) => (
                    <Tr key={prerequisite.id} data-testid={`network-config-prerequisite-${prerequisite.id}`} data-state={prerequisite.state}>
                        <Td dataLabel="State">
                            <Label isCompact color={PREREQUISITE[prerequisite.state].color}>{PREREQUISITE[prerequisite.state].text}</Label>
                        </Td>
                        <Td dataLabel="Prerequisite">{prerequisite.label}</Td>
                        <Td dataLabel="Actual" style={{ overflowWrap: 'anywhere' }}>{prerequisite.actual}</Td>
                        <Td dataLabel="Source">
                            <div style={small}>{prerequisite.source}</div>
                            <code style={{ fontSize: 'var(--pf-t--global--font--size--sm)', overflowWrap: 'anywhere' }}>{prerequisite.sourcePath}</code>
                        </Td>
                    </Tr>
                ))}
            </Tbody>
        </Table>
        {capability.notes.map((note) => <div key={note} style={small}>{note}</div>)}
    </section>
);

const CapabilitiesCard: React.FC<{ capabilities: Capability[] }> = ({ capabilities }) => (
    <Card data-testid="network-config-capabilities">
        <CardTitle>Capabilities</CardTitle>
        <CardBody>
            <p style={{ ...subtle, marginBlockEnd: 'var(--pf-t--global--spacer--md)' }}>
                What each advanced feature needs from this configuration, and whether it is there.
            </p>
            {capabilities.map((capability) => <CapabilityBlock key={capability.id} capability={capability} />)}
        </CardBody>
    </Card>
);

const code: React.CSSProperties = { fontSize: 'var(--pf-t--global--font--size--sm)', overflowWrap: 'anywhere' };

const LayoutNotes: React.FC<{ notes: MasqueradeLayoutNote[] }> = ({ notes }) => (
    <>
        {notes.map((note) => (note.severity === 'warning' ? (
            <div key={note.id} data-testid={`network-config-masquerade-note-${note.id}`}>
                <Label isCompact color="orange">Warning</Label> {note.text}
            </div>
        ) : (
            <div key={note.id} style={small} data-testid={`network-config-masquerade-note-${note.id}`}>{note.text}</div>
        )))}
    </>
);

const MasqueradeAddressLayout: React.FC<{ subnet: MasqueradeSubnetLayout }> = ({ subnet }) => {
    const [open, setOpen] = React.useState(false);
    return (
        <ExpandableSection
            toggleText={`Address layout of ${subnet.cidr}`}
            isExpanded={open}
            onToggle={(_event, expanded) => setOpen(expanded)}
            data-testid={`network-config-masquerade-layout-${subnet.cidr}`}
        >
            <Table variant="compact" aria-label={`Address layout of ${subnet.cidr}`}>
                <Thead>
                    <Tr>
                        <Th width={35}>Address</Th>
                        <Th>Used for</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {subnet.globals.map((global) => (
                        <Tr key={global.address}>
                            <Td dataLabel="Address"><code style={code}>{global.address}</code></Td>
                            <Td dataLabel="Used for">{global.label}</Td>
                        </Tr>
                    ))}
                    {subnet.networks.map((network) => (
                        <Tr key={network.networkId} data-testid={`network-config-masquerade-network-${network.networkId}`}>
                            <Td dataLabel="Address">
                                {network.gatewayRouter ? (
                                    <>
                                        <code style={code}>{network.gatewayRouter}</code>
                                        <span style={small}> gateway router</span>
                                        <br />
                                        <code style={code}>{network.managementPort}</code>
                                        <span style={small}> management port</span>
                                    </>
                                ) : <span style={subtle}>No room in this subnet</span>}
                            </Td>
                            <Td dataLabel="Used for">
                                {network.target ? <Link to={networkPath(network.target)}>{network.label}</Link> : network.label}
                                <div style={small}>Network ID {network.networkId}</div>
                            </Td>
                        </Tr>
                    ))}
                </Tbody>
            </Table>
            <div style={small}>
                {subnet.firstPair
                    ? `The addresses after the global ones are reserved up to the first network's pair, ${subnet.firstPair.gatewayRouter} `
                        + `and ${subnet.firstPair.managementPort}; each network ID takes the next two. `
                    : ''}
                {subnet.networks.length === 0 ? 'No primary network holds a pair. ' : ''}
                Derived from the network IDs; only primary networks are listed.
            </div>
        </ExpandableSection>
    );
};

const MasqueradeFamilyRows: React.FC<{ family: MasqueradeFamilyLayout }> = ({ family }) => (
    <>
        {family.subnets.map((subnet, index) => (
            <Tr key={subnet.cidr} data-testid={`network-config-masquerade-${family.name.toLowerCase()}`} data-source={subnet.source}>
                <Td dataLabel="Family">{family.name}</Td>
                <Td dataLabel="Subnet in effect">
                    <span data-testid="network-config-masquerade-subnet">{subnet.cidr}</span>
                    {subnet.nodes > 0 && <div style={small}>Reported by {subnet.nodes} node{subnet.nodes === 1 ? '' : 's'}</div>}
                    {index === 0 && <LayoutNotes notes={family.notes} />}
                </Td>
                <Td dataLabel="Source">
                    <div style={small}>{subnet.sourceText}</div>
                    {subnet.sourcePath && <code style={code}>{subnet.sourcePath}</code>}
                </Td>
                <Td dataLabel="Capacity">
                    <span data-testid="network-config-masquerade-capacity">{subnet.capacityText}</span>
                    <LayoutNotes notes={subnet.notes} />
                    <MasqueradeAddressLayout subnet={subnet} />
                </Td>
            </Tr>
        ))}
    </>
);

const MasqueradeCard: React.FC<{ masquerade: MasqueradeLayout }> = ({ masquerade }) => (
    <Card data-testid="network-config-masquerade">
        <CardTitle>Masquerade subnet</CardTitle>
        <CardBody>
            <p style={{ ...subtle, marginBlockEnd: 'var(--pf-t--global--spacer--md)' }}>
                Link-local addresses every node reserves: a few global ones, then a gateway router and a management port
                address for each network, placed by its network ID.
            </p>
            <Table variant="compact" aria-label="Masquerade subnet">
                <Thead>
                    <Tr>
                        <Th width={10}>Family</Th>
                        <Th width={25}>Subnet in effect</Th>
                        <Th width={25}>Source</Th>
                        <Th>Capacity and layout</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {masquerade.families.map((family) => <MasqueradeFamilyRows key={family.family} family={family} />)}
                </Tbody>
            </Table>
            <div data-testid="network-config-masquerade-usage" style={{ marginBlockStart: 'var(--pf-t--global--spacer--sm)' }}>
                {masquerade.usageText}.
            </div>
            <div data-testid="network-config-masquerade-immutable">
                <Label isCompact color="orange">Immutable</Label> {masquerade.immutableText}
            </div>
        </CardBody>
    </Card>
);

const CONDITION_COLOR: Record<ConditionSeverity, 'red' | 'orange' | 'blue' | 'grey'> = {
    danger: 'red',
    warning: 'orange',
    info: 'blue',
    none: 'grey',
};

const ConditionsCard: React.FC<{ conditions: ConditionRow[] }> = ({ conditions }) => (
    <Card data-testid="network-config-conditions">
        <CardTitle>Operator conditions</CardTitle>
        <CardBody>
            <Table variant="compact" aria-label="Operator conditions">
                <Thead>
                    <Tr>
                        <Th>Source</Th>
                        <Th>Condition</Th>
                        <Th>Status</Th>
                        <Th>Reason</Th>
                        <Th>Message</Th>
                        <Th>Since</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {conditions.map((condition) => (
                        <Tr key={condition.id} data-testid={`network-config-condition-${condition.type}`} data-severity={condition.severity}>
                            <Td dataLabel="Source">{condition.source}</Td>
                            <Td dataLabel="Condition">{condition.type}</Td>
                            <Td dataLabel="Status">
                                <Label isCompact color={CONDITION_COLOR[condition.severity]}>{condition.status}</Label>
                                {condition.note && <div style={small}>{condition.note}</div>}
                            </Td>
                            <Td dataLabel="Reason">{condition.reason}</Td>
                            <Td dataLabel="Message" style={{ overflowWrap: 'anywhere' }}>{condition.message}</Td>
                            <Td dataLabel="Since">{condition.lastTransitionTime ?? ''}</Td>
                        </Tr>
                    ))}
                </Tbody>
            </Table>
        </CardBody>
    </Card>
);

const SourcesCard: React.FC<{ sources: SourceSummary[] }> = ({ sources }) => (
    <Card data-testid="network-config-sources">
        <CardTitle>Sources</CardTitle>
        <CardBody>
            <p style={subtle}>Read with your own permissions; nothing here is changed by OVN Recon.</p>
            <Table variant="compact" aria-label="Sources">
                <Thead>
                    <Tr>
                        <Th>Source</Th>
                        <Th>Resource</Th>
                        <Th>State</Th>
                    </Tr>
                </Thead>
                <Tbody>
                    {sources.map((source) => (
                        <Tr key={source.id} data-testid={`network-config-source-${source.id}`} data-status={source.status}>
                            <Td dataLabel="Source">{source.label}</Td>
                            <Td dataLabel="Resource">
                                {source.status === 'ok' ? (
                                    <ConsoleLink target={resourceTarget(source.resource)}>
                                        {source.resource.kind} {source.resource.namespace ? `${source.resource.namespace}/` : ''}{source.resource.name}
                                    </ConsoleLink>
                                ) : (
                                    <>{source.resource.kind} {source.resource.namespace ? `${source.resource.namespace}/` : ''}{source.resource.name}</>
                                )}
                                <div style={small}>{source.resource.apiVersion}</div>
                            </Td>
                            <Td dataLabel="State">
                                {source.text}
                                {source.optional && <span style={subtle}> (optional)</span>}
                                {source.message && <div style={small}>{source.message}</div>}
                            </Td>
                        </Tr>
                    ))}
                </Tbody>
            </Table>
        </CardBody>
    </Card>
);

/** The sources whose absence leaves rows out: named, never a spinner that does not end. */
const missingSources = (sources: SourceSummary[]): SourceSummary[] =>
    sources.filter((source) => !source.optional && source.status !== 'ok' && source.status !== 'loading');

const NetworkConfigPanel: React.FC<{ model: CnoConfigModel }> = ({ model }) => {
    if (model.loading) return <Spinner size="lg" aria-label="Loading the cluster network configuration" />;
    const missing = missingSources(model.sources);
    return (
        <Stack hasGutter data-testid="network-config">
            {missing.length > 0 && (
                <StackItem>
                    <Alert isInline variant="warning" title="Some of the configuration could not be read" data-testid="network-config-missing">
                        <ul>
                            {missing.map((source) => (
                                <li key={source.id}>
                                    {source.label} ({source.resource.kind} {source.resource.name}): {source.text.toLowerCase()}
                                </li>
                            ))}
                        </ul>
                        The rest is shown below.
                    </Alert>
                </StackItem>
            )}
            {model.notices.map((notice) => (
                <StackItem key={notice.id}>
                    <Alert isInline variant={notice.severity} title={notice.title} data-testid={`network-config-notice-${notice.id}`}>
                        {notice.body}
                    </Alert>
                </StackItem>
            ))}
            {model.applied.status === 'differs' && <StackItem><AppliedSpecCard comparison={model.applied} /></StackItem>}
            {model.capabilities.length > 0 && <StackItem><CapabilitiesCard capabilities={model.capabilities} /></StackItem>}
            {model.sections.map((section) => (
                <React.Fragment key={section.id}>
                    <StackItem><SectionCard section={section} /></StackItem>
                    {section.id === 'addressing' && model.masquerade.families.length > 0 && (
                        <StackItem><MasqueradeCard masquerade={model.masquerade} /></StackItem>
                    )}
                </React.Fragment>
            ))}
            {model.masquerade.families.length > 0 && !model.sections.some((section) => section.id === 'addressing') && (
                <StackItem><MasqueradeCard masquerade={model.masquerade} /></StackItem>
            )}
            {model.conditions.length > 0 && <StackItem><ConditionsCard conditions={model.conditions} /></StackItem>}
            <StackItem><SourcesCard sources={model.sources} /></StackItem>
        </Stack>
    );
};

export default NetworkConfigPanel;
