import { OvsBondRuntime } from '../types';
import { GraphContext, OvsBondRuntimeState } from './context';

/** The collector's warning when it could not run bond/show and served its fixture (or nothing). */
export const LIVE_PROBE_FAILED = 'LIVE_PROBE_FAILED';

type LoadedOvsBondRuntime = Exclude<OvsBondRuntimeState, { error: string }>;

/** The collector answered (ovn-recon-1tw.7), as against a failed request. */
export const isLoadedOvsBondRuntime = (state: OvsBondRuntimeState | undefined): state is LoadedOvsBondRuntime =>
    Boolean(state) && !('error' in (state as OvsBondRuntimeState));

/**
 * The answer is not OVS's live state (ovn-recon-1tw.7): the collector's probe failed
 * and it served the fixture it ships for the node, or an empty list, marked as the
 * snapshot endpoint marks it (sourceHealth "degraded", warning LIVE_PROBE_FAILED).
 */
export const isDegradedOvsBondRuntime = (state: LoadedOvsBondRuntime): boolean =>
    (state.sourceHealth !== '' && state.sourceHealth !== 'ok')
    || state.warnings.some((warning) => warning.code === LIVE_PROBE_FAILED);

/**
 * A bond's live runtime state from the context, or undefined: with no answer, a
 * failed request, a degraded (fixture) answer, or no bond of that name in it. For
 * the canvas, which has no room to say "not live", so it shows only what is.
 */
export const liveOvsBondRuntime = (bondName: string, ctx: GraphContext): OvsBondRuntime | undefined => {
    const state = ctx.ovsBondRuntime;
    if (!isLoadedOvsBondRuntime(state) || isDegradedOvsBondRuntime(state)) return undefined;
    return state.byBond.get(bondName);
};
