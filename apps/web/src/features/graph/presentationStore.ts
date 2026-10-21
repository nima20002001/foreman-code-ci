import { createStore } from 'zustand/vanilla'

/** Disposable decoration only. These IDs/captions never authorize or advance a Run. */
export type GraphExchangeCue = Readonly<{ key: string; relationshipId: string; token: string; caption: string }>

type IdsUpdate = Set<string> | ((previous: Set<string>) => Set<string>)

export type GraphPresentationState = {
  selectedNodeIds: Set<string>
  openMenuNodeId?: string
  focusedNodeId?: string
  focusedEdgeId?: string
  enteringNodeIds: Set<string>
  departingNodeIds: Set<string>
  enteringEdgeId?: string
  focusedExchangeKey?: string
  exchangeCues: readonly GraphExchangeCue[]
  setFocusedExchangeKey: (key?: string) => void
  setExchangeCues: (cues: readonly GraphExchangeCue[]) => void
  epoch: number
  resetPresentation: () => void
  setSelectedNodeIds: (update: IdsUpdate) => void
  setOpenMenuNodeId: (id?: string) => void
  setFocusedNodeId: (id?: string) => void
  setFocusedEdgeId: (id?: string) => void
  setEnteringNodeIds: (update: IdsUpdate) => void
  setDepartingNodeIds: (update: IdsUpdate) => void
  setEnteringEdgeId: (id?: string) => void
}

function sameIds(left: Set<string>, right: Set<string>) {
  return left.size === right.size && [...left].every((id) => right.has(id))
}

/** No workflow definitions, Run records, transport cursors, or gesture geometry live here. */
export function createGraphPresentationStore() {
  return createStore<GraphPresentationState>((set) => ({
    selectedNodeIds: new Set(), enteringNodeIds: new Set(), departingNodeIds: new Set(), epoch: 0, exchangeCues: [],
    resetPresentation: () => set((state) => ({ selectedNodeIds: new Set(), enteringNodeIds: new Set(),
      departingNodeIds: new Set(), openMenuNodeId: undefined, focusedNodeId: undefined,
      focusedEdgeId: undefined, enteringEdgeId: undefined, focusedExchangeKey: undefined, exchangeCues: [], epoch: state.epoch + 1 })),
    setFocusedExchangeKey: (focusedExchangeKey) => set((state) => state.focusedExchangeKey === focusedExchangeKey
      ? state : { focusedExchangeKey }),
    setExchangeCues: (cues) => set((state) => {
      const exchangeCues = cues.filter((cue, index) => cues.findIndex((item) => item.key === cue.key) === index).slice(0, 4)
      return state.exchangeCues.length === exchangeCues.length && state.exchangeCues.every((cue, index) => cue === exchangeCues[index])
        ? state : { exchangeCues }
    }),
    setSelectedNodeIds: (update) => set((state) => {
      const selectedNodeIds = typeof update === 'function' ? update(state.selectedNodeIds) : update
      return sameIds(state.selectedNodeIds, selectedNodeIds) ? state : { selectedNodeIds }
    }),
    setOpenMenuNodeId: (openMenuNodeId) => set((state) => state.openMenuNodeId === openMenuNodeId
      ? state : { openMenuNodeId }),
    setFocusedNodeId: (focusedNodeId) => set((state) => state.focusedNodeId === focusedNodeId
      ? state : { focusedNodeId }),
    setFocusedEdgeId: (focusedEdgeId) => set((state) => state.focusedEdgeId === focusedEdgeId
      ? state : { focusedEdgeId }),
    setEnteringNodeIds: (update) => set((state) => {
      const enteringNodeIds = typeof update === 'function' ? update(state.enteringNodeIds) : update
      return sameIds(state.enteringNodeIds, enteringNodeIds) ? state : { enteringNodeIds }
    }),
    setDepartingNodeIds: (update) => set((state) => {
      const departingNodeIds = typeof update === 'function' ? update(state.departingNodeIds) : update
      return sameIds(state.departingNodeIds, departingNodeIds) ? state : { departingNodeIds }
    }),
    setEnteringEdgeId: (enteringEdgeId) => set((state) => state.enteringEdgeId === enteringEdgeId
      ? state : { enteringEdgeId }),
  }))
}

export type GraphPresentationStore = ReturnType<typeof createGraphPresentationStore>
