import * as React from 'react';
import { Link } from 'react-router';

import {
    isLauncherPodName, LauncherVm, launcherVmIndex, LauncherVmIndex, launcherVmOf, launcherVmsServed, NO_LAUNCHER_VMS,
    VmiLike
} from './launcherVm';
import {
    ConsoleCapabilities, LinkOut as LinkOutDestination, LinkTarget, NO_CAPABILITIES, resolveLinkOuts, resourceTarget
} from './registry';
import { useConsoleCapabilities } from './useConsoleCapabilities';
import { useLauncherVmIndex } from './useLauncherVmIndex';

/**
 * The components that turn a LinkTarget into a link (ovn-recon-zdt.4, folding in
 * the link consolidation of ovn-recon-s3t.18).
 *
 * Every link is a react-router Link, so following one stays inside the console
 * without a page reload, in the same tab. A target with no page renders its
 * children as plain text: an honest non-link beats a link to nowhere.
 */

const CapabilitiesContext = React.createContext<ConsoleCapabilities>(NO_CAPABILITIES);

interface LauncherVms {
    index: LauncherVmIndex;
    /** Says a launcher pod is on screen; the returned function takes that back. */
    retain: () => () => void;
}

const LauncherVmsContext = React.createContext<LauncherVms>({
    index: NO_LAUNCHER_VMS,
    retain: () => () => undefined,
});

/**
 * Holds the VirtualMachineInstance watch (ovn-recon-zdt.5). It runs only on a
 * console that serves the kubevirt.io kinds, and only while something below has
 * a launcher pod on screen.
 */
const LauncherVmWatch: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
    const capabilities = React.useContext(CapabilitiesContext);
    const [demand, setDemand] = React.useState(0);
    const index = useLauncherVmIndex(launcherVmsServed(capabilities) && demand > 0);
    const retain = React.useCallback(() => {
        setDemand((count) => count + 1);
        return () => setDemand((count) => count - 1);
    }, []);
    const value = React.useMemo(() => ({ index, retain }), [index, retain]);
    return <LauncherVmsContext.Provider value={value}>{children}</LauncherVmsContext.Provider>;
};

/**
 * Reads what the console has loaded once and shares it with every link below.
 * Links outside a provider still work: they resolve against nothing loaded,
 * which is the generic console page.
 */
export const LinkOutProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => (
    <CapabilitiesContext.Provider value={useConsoleCapabilities()}>
        <LauncherVmWatch>{children}</LauncherVmWatch>
    </CapabilitiesContext.Provider>
);

/**
 * For tests and stories: a fixed set of capabilities, without the console, and
 * the VirtualMachineInstances a watch would return where they are served.
 */
export const StaticLinkOutProvider: React.FC<{
    capabilities: ConsoleCapabilities;
    vmis?: VmiLike[];
    children?: React.ReactNode;
}> = ({ capabilities, vmis, children }) => {
    const launcherVms = React.useMemo<LauncherVms>(() => ({
        index: vmis && launcherVmsServed(capabilities) ? launcherVmIndex(vmis) : NO_LAUNCHER_VMS,
        retain: () => () => undefined,
    }), [capabilities, vmis]);
    return (
        <CapabilitiesContext.Provider value={capabilities}>
            <LauncherVmsContext.Provider value={launcherVms}>{children}</LauncherVmsContext.Provider>
        </CapabilitiesContext.Provider>
    );
};

/**
 * The VM behind a launcher pod, by namespace and pod name. `wanted` says the
 * caller has a launcher pod to resolve, which is what keeps the watch running.
 */
export const useLauncherVmLookup = (wanted: boolean) => {
    const { index, retain } = React.useContext(LauncherVmsContext);
    React.useEffect(() => (wanted ? retain() : undefined), [wanted, retain]);
    return React.useCallback(
        (namespace: string | undefined, pod: string | undefined): LauncherVm | undefined =>
            launcherVmOf(index, namespace, pod),
        [index],
    );
};

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
                <Link
                    key={link.id}
                    to={link.path}
                    title={link.hint}
                    data-link-owner={link.owner}
                    data-link-id={link.id}
                >
                    {link.label}
                </Link>
            ))}
        </div>
    );
};

const LAUNCHER_POD_LINK: React.CSSProperties = {
    fontSize: 'var(--pf-t--global--font--size--body--sm)',
    overflowWrap: 'anywhere',
};

/**
 * A pod by namespace and name. A virt-launcher pod whose VirtualMachine is known
 * shows as `VM namespace/name`, linked to the VM, with the pod as a secondary link
 * (ovn-recon-zdt.5). Every other pod is a link to the pod, reading as `children`.
 */
export const PodLink: React.FC<{
    namespace: string;
    pod: string;
    title?: string;
    style?: React.CSSProperties;
    children?: React.ReactNode;
}> = ({ namespace, pod, title, style, children }) => {
    const vm = useLauncherVmLookup(isLauncherPodName(pod))(namespace, pod);
    if (!vm) {
        return (
            <ConsoleLink
                target={resourceTarget({ apiVersion: 'v1', kind: 'Pod', namespace, name: pod })}
                title={title}
                style={style}
            >
                {children ?? `${namespace}/${pod}`}
            </ConsoleLink>
        );
    }
    const target: LinkTarget = { type: 'virtual-machine', namespace: vm.namespace, name: vm.name, launcherPod: pod };
    return (
        <span data-testid="launcher-vm">
            <ConsoleLink target={target} title={title} style={style}>
                VM {vm.namespace}/<wbr />{vm.name}
            </ConsoleLink>
            <SecondaryLinks target={target} style={LAUNCHER_POD_LINK} />
        </span>
    );
};
