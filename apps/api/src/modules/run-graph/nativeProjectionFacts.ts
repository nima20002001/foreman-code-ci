import { isDeepStrictEqual } from 'node:util'
import type { PublicGraphProjection, GraphFact } from '@foreman-code/contracts/wave25'
import { runtimeTimingPoint } from '../../infrastructure/runtimeTiming.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'
import { publicNodeProjectionDelta } from './publicProjection.js'

/** Identical validated overlays cannot change the public node projection. */
export async function readNativeProjectionFacts(before: CurrentNativeActivity[], after: CurrentNativeActivity[],
  readNodes: (native: CurrentNativeActivity[]) => Promise<PublicGraphProjection['nodes']>): Promise<GraphFact[]> {
  if (isDeepStrictEqual(before, after)) {
    runtimeTimingPoint('db', 'native.projection_reads', { count: 0 })
    return []
  }
  runtimeTimingPoint('db', 'native.projection_reads', { count: 2 })
  return publicNodeProjectionDelta(await readNodes(before), await readNodes(after))
}
