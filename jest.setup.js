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
