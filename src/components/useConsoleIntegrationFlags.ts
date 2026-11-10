import * as React from 'react';
import { SetFeatureFlag, useK8sWatchResource, WatchK8sResource } from '@openshift-console/dynamic-plugin-sdk';

import { OvnRecon } from '../types';
import { FLAG_RESOURCE_ACTIONS, FLAG_RESOURCE_TABS, resolveIntegrationFlags } from './consoleIntegration';

/** Module-level so the watch is not re-created on every render. */
const OVN_RECON_WATCH: WatchK8sResource = {
    groupVersionKind: {
        group: 'recon.bewley.net',
        // v1beta1 is the only served version; see useOvnCollectorFeatureGate.
        version: 'v1beta1',
        kind: 'OvnRecon',
    },
    isList: true,
};

/**
 * The console.flag/hookProvider handler (ovn-recon-zdt.7). The console calls it as a
 * hook with its flag setter, so it may watch: it sets OVN_RECON_RESOURCE_TABS and
 * OVN_RECON_RESOURCE_ACTIONS from the primary OvnRecon's status.effective, and both
 * stay false until the watch has loaded and the operator has said true.
 *
 * Both are set on every change, including to false, so turning a switch off withdraws
 * the tabs or actions it gated. Whether the console re-filters already-rendered pages
 * live or only on the next page load is not proven by these tests.
 */
export const useConsoleIntegrationFlags = (setFeatureFlag: SetFeatureFlag): void => {
    const [instances, loaded, loadError] = useK8sWatchResource<OvnRecon[]>(OVN_RECON_WATCH);
    const { resourceTabs, resourceActions } = resolveIntegrationFlags(instances, loaded, loadError);

    React.useEffect(() => {
        setFeatureFlag(FLAG_RESOURCE_TABS, resourceTabs);
        setFeatureFlag(FLAG_RESOURCE_ACTIONS, resourceActions);
    }, [setFeatureFlag, resourceTabs, resourceActions]);
};

export default useConsoleIntegrationFlags;
