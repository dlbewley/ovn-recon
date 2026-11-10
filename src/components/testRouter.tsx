import * as React from 'react';
import { Location, MemoryRouter, NavigationType, useLocation, useNavigationType } from 'react-router';

/**
 * Test-only router plumbing. The console renders plugin pages under its own
 * router; tests stand in for it with a MemoryRouter, and record every location
 * it reaches so assertions can check what was written and whether it was a
 * push or a replace.
 */

export interface LocationRecord {
    pathname: string;
    search: string;
    hash: string;
    navigationType: NavigationType;
    location: Location;
}

const LocationSpy: React.FC<{ onLocation: (record: LocationRecord) => void }> = ({ onLocation }) => {
    const location = useLocation();
    const navigationType = useNavigationType();
    React.useEffect(() => {
        onLocation({
            pathname: location.pathname,
            search: location.search,
            hash: location.hash,
            navigationType,
            location,
        });
    }, [location, navigationType, onLocation]);
    return null;
};

export const TestRouter: React.FC<{
    initialEntry?: string;
    onLocation?: (record: LocationRecord) => void;
    children: React.ReactNode;
}> = ({ initialEntry = '/', onLocation, children }) => (
    <MemoryRouter initialEntries={[initialEntry]}>
        {onLocation && <LocationSpy onLocation={onLocation} />}
        {children}
    </MemoryRouter>
);

/** A component wrapped in a MemoryRouter, for tests that only need a router to exist. */
export const routed = <P extends object>(Component: React.ComponentType<P>): React.FC<P> => {
    const Routed: React.FC<P> = (props) => (
        <MemoryRouter>
            <Component {...props} />
        </MemoryRouter>
    );
    Routed.displayName = `Routed(${Component.displayName || Component.name || 'Component'})`;
    return Routed;
};
