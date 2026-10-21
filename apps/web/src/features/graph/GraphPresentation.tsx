import { useState, type ReactNode } from 'react'
import { createGraphPresentationStore } from './presentationStore'
import { GraphPresentationContext } from './useGraphPresentation'

export function GraphPresentationProvider({ children }: { children: ReactNode }) {
  const [store] = useState(createGraphPresentationStore)
  return <GraphPresentationContext.Provider value={store}>{children}</GraphPresentationContext.Provider>
}
