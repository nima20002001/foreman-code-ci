import type { ReactNode } from 'react'
import type { GraphRuntimeScope } from './runtimeIndex'
import { GraphRuntimeContext } from './graphContexts'

/** Scope only; the editor or future Run synchronizer owns the one poller. */
export function GraphRuntimeProvider({ scope, children }: { scope: GraphRuntimeScope; children: ReactNode }) {
  return <GraphRuntimeContext.Provider value={scope}>{children}</GraphRuntimeContext.Provider>
}
