import { act, render } from '@testing-library/react'
import { memo, useLayoutEffect } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GraphPresentationProvider } from './GraphPresentation'
import { createGraphPresentationStore, type GraphPresentationStore } from './presentationStore'
import { useGraphPresentation, useGraphPresentationStore } from './useGraphPresentation'

const Leaf = memo(function Leaf({ id, rendered }: { id: string; rendered: (id: string) => void }) {
  const selected = useGraphPresentation((state) => state.selectedNodeIds.has(id))
  const menu = useGraphPresentation((state) => state.openMenuNodeId === id)
  rendered(id)
  return <output>{id}:{String(selected)}:{String(menu)}</output>
})
function Capture({ capture }: { capture: (store: GraphPresentationStore) => void }) {
  const store = useGraphPresentationStore()
  useLayoutEffect(() => capture(store), [store, capture])
  return null
}

describe('graph-scoped presentation', () => {
  it('notifies only affected selectors and never shares presentation across graph instances', () => {
    let first!: GraphPresentationStore
    let second!: GraphPresentationStore
    const firstRender = vi.fn(), secondRender = vi.fn()
    render(<>
      <GraphPresentationProvider><Capture capture={(store) => { first = store }} />
        <Leaf id="one" rendered={firstRender} /><Leaf id="two" rendered={firstRender} />
      </GraphPresentationProvider>
      <GraphPresentationProvider><Capture capture={(store) => { second = store }} />
        <Leaf id="one" rendered={secondRender} />
      </GraphPresentationProvider>
    </>)
    firstRender.mockClear(); secondRender.mockClear()
    act(() => first.getState().setSelectedNodeIds(new Set(['one'])))
    expect(firstRender.mock.calls.map(([id]) => id)).toEqual(['one'])
    expect(secondRender).not.toHaveBeenCalled()
    firstRender.mockClear()
    act(() => first.getState().setOpenMenuNodeId('two'))
    expect(firstRender.mock.calls.map(([id]) => id)).toEqual(['two'])
    expect(second.getState().openMenuNodeId).toBeUndefined()
    expect(second.getState().selectedNodeIds.size).toBe(0)
  })

  it('retains no-op set references and resets disposable cues without any runtime fields', () => {
    const store = createGraphPresentationStore()
    store.getState().setSelectedNodeIds(new Set(['one']))
    const selected = store.getState().selectedNodeIds
    store.getState().setSelectedNodeIds(new Set(['one']))
    expect(store.getState().selectedNodeIds).toBe(selected)
    store.getState().setEnteringNodeIds(new Set(['one']))
    store.getState().setDepartingNodeIds(new Set(['two']))
    store.getState().setEnteringEdgeId('edge')
    store.getState().resetPresentation()
    expect(store.getState().epoch).toBe(1)
    expect(store.getState().enteringNodeIds.size).toBe(0)
    expect(store.getState().departingNodeIds.size).toBe(0)
    expect(store.getState().enteringEdgeId).toBeUndefined()
    expect(store.getState()).not.toHaveProperty('run')
    expect(store.getState()).not.toHaveProperty('cursor')
    expect(store.getState()).not.toHaveProperty('workflow')
  })
})
