import { createContext, useContext } from 'react'
import { useStore } from 'zustand'
import type { GraphPresentationState, GraphPresentationStore } from './presentationStore'

export const GraphPresentationContext = createContext<GraphPresentationStore | undefined>(undefined)

export function useGraphPresentationStore() {
  const store = useContext(GraphPresentationContext)
  if (!store) throw new Error('A graph presentation provider is required.')
  return store
}

export function useGraphPresentation<T>(selector: (state: GraphPresentationState) => T): T {
  return useStore(useGraphPresentationStore(), selector)
}
