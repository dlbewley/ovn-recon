// React 18 requires this flag before act() will suppress its "not configured to
// support act(...)" warning. Set globally so every suite gets it.
// https://react.dev/reference/react/act#error-the-current-testing-environment-is-not-configured-to-support-act
global.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no TextEncoder, and react-router builds one when it is imported.
// The drawer facts render route tables through RuleTable, which links with
// react-router, so every suite reaching the facts would otherwise fail to load.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;
