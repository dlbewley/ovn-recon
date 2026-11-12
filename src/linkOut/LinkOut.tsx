import * as React from 'react';
import { Link } from 'react-router';

import {
    ConsoleCapabilities, LinkOut as LinkOutDestination, LinkTarget, NO_CAPABILITIES, resolveLinkOuts
} from './registry';
import { useConsoleCapabilities } from './useConsoleCapabilities';

/**
 * The components that turn a LinkTarget into a link (ovn-recon-zdt.4, folding in
 * the link consolidation of ovn-recon-s3t.18).
 *
 * Every link is a react-router Link, so following one stays inside the console
 * without a page reload, in the same tab. A target with no page renders its
 * children as plain text: an honest non-link beats a link to nowhere.
 */

const CapabilitiesContext = React.createContext<ConsoleCapabilities>(NO_CAPABILITIES);

/**
 * Reads what the console has loaded once and shares it with every link below.
 * Links outside a provider still work: they resolve against nothing loaded,
 * which is the generic console page.
 */
export const LinkOutProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <CapabilitiesContext.Provider value={useConsoleCapabilities()}>{children}</CapabilitiesContext.Provider>
);

/** For tests and stories: a fixed set of capabilities, without the console. */
export const StaticLinkOutProvider: React.FC<{
    capabilities: ConsoleCapabilities;
    children?: React.ReactNode;
}> = ({ capabilities, children }) => (
    <CapabilitiesContext.Provider value={capabilities}>{children}</CapabilitiesContext.Provider>
);

export const useLinkOuts = (target: LinkTarget | undefined) => {
    const capabilities = React.useContext(CapabilitiesContext);
    return React.useMemo(
        () => (target ? resolveLinkOuts(target, capabilities) : { secondary: [] as LinkOutDestination[] }),
        // A target is a small literal rebuilt each render; its JSON is its identity.
        [JSON.stringify(target), capabilities],
    );
};

export interface ConsoleLinkProps {
    target: LinkTarget | undefined;
    /** Link text; the destination's own label when absent. */
    children?: React.ReactNode;
    className?: string;
    title?: string;
    style?: React.CSSProperties;
    /** Render nothing, instead of the children as text, when no page is there. */
    hideWhenAbsent?: boolean;
    'data-testid'?: string;
    'data-view'?: string;
}

/**
 * A link to the page that owns `target`. Renders the children alone when no
 * such page is there.
 */
export const ConsoleLink: React.FC<ConsoleLinkProps> = ({ target, children, hideWhenAbsent, ...rest }) => {
    const { primary } = useLinkOuts(target);
    if (!primary) return hideWhenAbsent ? null : <>{children}</>;
    return (
        <Link to={primary.path} data-link-owner={primary.owner} {...rest}>
            {children ?? primary.label}
        </Link>
    );
};

/**
 * The other pages worth offering for `target`, each under its own label
 * ("Interface details in nmstate"). Renders nothing when there are none, so a
 * caller can place it unconditionally.
 */
export const SecondaryLinks: React.FC<{ target: LinkTarget | undefined; style?: React.CSSProperties }> = ({
    target,
    style,
}) => {
    const { secondary } = useLinkOuts(target);
    if (secondary.length === 0) return null;
    return (
        <div data-testid="secondary-links" style={{ display: 'flex', flexWrap: 'wrap', gap: '0 1em', ...style }}>
            {secondary.map((link) => (
                <Link key={link.id} to={link.path} data-link-owner={link.owner} data-link-id={link.id}>
                    {link.label}
                </Link>
            ))}
        </div>
    );
};
