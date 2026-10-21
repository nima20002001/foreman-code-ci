import { act, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { memo } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { GraphRuntimeProvider } from './GraphRuntime'
import { useGraphNodeRuntime } from './useGraphNodeRuntime'
import { makeSyntheticRun } from './fixtures/scaleData'
import { shareRunResponseOrSelection } from '../../shared/api/runLiveCache'
import { queryKeys } from '../../shared/api/query'

const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }
const RuntimeLeaf = memo(function RuntimeLeaf({ index, rendered }: { index: number; rendered: (index: number) => void }) {
  const runtime = useGraphNodeRuntime(`synthetic-node-${index}`, `synthetic-agent-${index}`)
  rendered(index)
  return <output data-testid={`leaf-${index}`}>{runtime.unavailable ? 'Unavailable' : runtime.activity?.action?.label ?? runtime.activity?.state}</output>
})

describe('cache-only runtime leaves (functional render assertions, not browser timings)', () => {
  it('updates one leaf without rerendering 299 unaffected observers or starting any requests', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, structuralSharing: shareRunResponseOrSelection } } })
    const key = queryKeys.run(scope.workspaceId, scope.runId)
    client.setQueryData(key, makeSyntheticRun(300))
    const fetch = vi.spyOn(globalThis, 'fetch')
    const rendered = vi.fn()
    const mounted = render(<QueryClientProvider client={client}><GraphRuntimeProvider scope={scope}>
      {Array.from({ length: 300 }, (_, index) => <RuntimeLeaf key={index} index={index} rendered={rendered} />)}
    </GraphRuntimeProvider></QueryClientProvider>)
    try {
      expect(rendered).toHaveBeenCalledTimes(300)
      rendered.mockClear()
      const next = makeSyntheticRun(300, '2')
      next.liveActivity!.nodes[17] = { ...next.liveActivity!.nodes[17], state: 'working',
        action: { kind: 'reading_file', label: 'Reading file…' }, event: { id: 'event-2', sequence: '2' } }
      act(() => client.setQueryData(key, next))
      await waitFor(() => expect(screen.getByTestId('leaf-17')).toHaveTextContent('Reading file…'))
      expect(rendered.mock.calls.map(([index]) => index)).toEqual([17])
      expect(fetch).not.toHaveBeenCalled()
    } finally { mounted.unmount(); fetch.mockRestore(); client.clear() }
  })

  it('shows unavailable rather than idle when a scope becomes stale or a version mismatches', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(queryKeys.run(scope.workspaceId, scope.runId), makeSyntheticRun(1))
    const rendered = vi.fn()
    const view = (unavailable: boolean) => <QueryClientProvider client={client}>
      <GraphRuntimeProvider scope={{ ...scope, unavailable }}><RuntimeLeaf index={0} rendered={rendered} /></GraphRuntimeProvider>
    </QueryClientProvider>
    const mounted = render(view(false))
    expect(screen.getByTestId('leaf-0')).toHaveTextContent('idle')
    mounted.rerender(view(true))
    expect(screen.getByTestId('leaf-0')).toHaveTextContent('Unavailable')
    mounted.unmount(); client.clear()
  })
})
