// React 18 requires this flag before act() will suppress its "not configured to
// support act(...)" warning. Set globally so every suite gets it.
// https://react.dev/reference/react/act#error-the-current-testing-environment-is-not-configured-to-support-act
global.IS_REACT_ACT_ENVIRONMENT = true;
