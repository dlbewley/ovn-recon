// React 18 requires this flag before act() will suppress its "not configured to
// support act(...)" warning. Set globally so every suite gets it.
// https://react.dev/reference/react/act#error-the-current-testing-environment-is-not-configured-to-support-act
global.IS_REACT_ACT_ENVIRONMENT = true;

// react-router 7 reaches for TextEncoder at import time; jsdom does not provide
// it. The console supplies the router in production, so this matters only for
// suites that render under a real MemoryRouter instead of mocking react-router.
if (typeof global.TextEncoder === 'undefined') {
    const { TextEncoder, TextDecoder } = require('util');
    global.TextEncoder = TextEncoder;
    global.TextDecoder = TextDecoder;
}
