// React 18 requires this flag before act() will suppress its "not configured to
// support act(...)" warning. Set globally so every suite gets it.
// https://react.dev/reference/react/act#error-the-current-testing-environment-is-not-configured-to-support-act
global.IS_REACT_ACT_ENVIRONMENT = true;

// react-router 7 reaches for TextEncoder at import time; jsdom does not provide
// it. The console supplies the router in production, so this matters only for
// suites that load the real react-router instead of mocking it: those rendering
// under a MemoryRouter, and every suite that builds drawer facts, since route
// tables render through RuleTable, which imports Link.
if (typeof global.TextEncoder === 'undefined') {
    const { TextEncoder, TextDecoder } = require('util');
    global.TextEncoder = TextEncoder;
    global.TextDecoder = TextDecoder;
}

// The link-out registry reads what the console has loaded through SDK hooks
// (useResolvedExtensions, useFlag). Most suites mock the SDK with a factory
// that lists only what the component under test calls, so the hook would be
// undefined in every drawer test. Suites get "nothing loaded" by default, which
// resolves every link to its generic console page. The hook's own suite takes
// the real module back with jest.requireActual over a mocked SDK; a suite that
// wants a plugin present mocks this module itself, or renders a link under
// StaticLinkOutProvider.
jest.mock('./src/linkOut/useConsoleCapabilities', () => ({
    useConsoleCapabilities: () => jest.requireActual('./src/linkOut/registry').NO_CAPABILITIES,
}));

// The explorer tree's width and collapsed state live in the console's user settings
// (useUserSettings), which the SDK cannot provide under jest. Suites get the same
// contract held in component state: loaded at once, the defaults, kept for the mount.
// A suite that needs a stored value, or one that outlives a remount, mocks this module.
jest.mock('./src/components/useTreePreferences', () => ({
    useTreePreferences: () => jest.requireActual('./src/components/treePreferencesModel').useMemoryTreePreferences(),
}));

// Which tree groups are open is kept in sessionStorage per browser tab; start every
// test from an empty store so one test's open groups never reach the next.
beforeEach(() => {
    try {
        window.sessionStorage.clear();
    } catch {
        // Not every environment is jsdom.
    }
});

// The collector client remembers its last ladder payloads for the browser tab and
// shares in-flight requests (ovn-recon-nt4.4); start every test with none, so one
// test's aggregate never paints in the next. A suite that mocks collectorApi with a
// factory has no such function, and nothing to forget.
beforeEach(() => {
    const api = require('./src/components/collectorApi');
    if (typeof api.forgetCollectorResponses === 'function') api.forgetCollectorResponses();
});
