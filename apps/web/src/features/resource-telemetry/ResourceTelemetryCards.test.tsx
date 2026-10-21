import { fireEvent, render, screen, within } from '@testing-library/react'
import { resourceTelemetryFixtures as fixtures } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { describe, expect, it } from 'vitest'
import { ComputerContextCard, ResourceTelemetryPanel } from './ResourceTelemetryCards'
import { formatBinaryBytes } from './telemetryView'

const panel = (name: keyof typeof fixtures, elapsedMs = 0, scope: 'computer' | 'owned' = 'owned') => {
  const result = fixtures[name]!
  const selectorKey = result.kind === 'sample' ? result.sample.selectorKey : result.selectorKey
  return render(<ResourceTelemetryPanel scope={scope} title="Execution" received={{ selectorKey, result, receivedMonoMs: 0, requestDurationMs: 0 }} elapsedMs={elapsedMs} />)
}

describe('ResourceTelemetryPanel', () => {
  it('shows a fresh true zero as 0.0% and 0 MiB, not as unavailable', () => {
    panel('freshZero')
    expect(screen.getByText('0.0%')).toBeInTheDocument()
    expect(screen.getByText('of whole computer capacity')).toBeInTheDocument()
    expect(screen.getByText('0 MiB')).toBeInTheDocument()
    expect(screen.getByText('Source: cgroup CPU usage')).toBeInTheDocument()
    expect(screen.getByText('Source: cgroup current')).toBeInTheDocument()
    expect(screen.queryByText('—')).toBeNull()
    expect(screen.queryByText('Only processes owned by this execution — not the whole computer.')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Execution' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Only processes owned by this execution — not the whole computer.')
  })

  it('labels whole-computer RAM as a host used estimate', () => {
    panel('computerZero', 0, 'computer')
    expect(screen.getByText('Source: Host used estimate (total − available)')).toBeInTheDocument()
    expect(screen.getByText('Source: Host active ticks')).toBeInTheDocument()
    expect(screen.queryByText('Whole computer — not any one Agent’s usage.')).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Execution' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Whole computer — not any one Agent’s usage.')
  })

  it('shows CPU warmup beside fresh RAM independently', () => {
    panel('warmup')
    const cpu = screen.getByRole('region', { name: 'CPU Warming up' })
    expect(within(cpu).getByText('—')).toBeInTheDocument()
    expect(within(cpu).getByText('Warming up (needs two samples)')).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: 'RAM Fresh' })).getByText('0 MiB')).toBeInTheDocument()
  })

  it('hides stale values, keeps the worker online and exposes last known separately', () => {
    panel('staleOnline', 0)
    expect(screen.getAllByText('Stale')).toHaveLength(2)
    expect(screen.getByText('Worker online')).toBeInTheDocument()
    expect(screen.queryByText('Fresh')).toBeNull()
    const last = screen.getByRole('region', { name: 'Last known' })
    expect(within(last).getByText('Last known · not current')).toBeInTheDocument()
    expect(last).toHaveTextContent('CPU 0.0% of whole computer capacity')
  })

  it('treats offline as presence with last known values, never as zero', () => {
    panel('offline')
    expect(screen.getByText('Worker offline')).toBeInTheDocument()
    expect(screen.queryByText('Offline is worker presence, not zero use or a finished execution.')).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About Worker offline' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Offline is worker presence, not zero use or a finished execution.')
    expect(screen.getByRole('region', { name: 'Last known' })).toBeInTheDocument()
  })

  it('advances age by elapsed time and stops presenting a value after the server deadline', () => {
    const { unmount } = panel('freshZero', 5000)
    expect(screen.getByText(/age ≤ 5\.0 s/)).toBeInTheDocument()
    expect(screen.getByText(/server freshness deadline in 1\.0 s/)).toBeInTheDocument()
    expect(screen.getByText('0.0%')).toBeInTheDocument()
    unmount()
    panel('freshZero', 6000)
    expect(screen.getAllByText('Freshness deadline passed')).toHaveLength(2)
    expect(screen.queryByText('0.0%')).toBeNull()
    expect(screen.getByText(/server freshness deadline passed/)).toBeInTheDocument()
  })

  it('labels shared and partial coverage independently', () => {
    const { unmount } = panel('partialRss')
    expect(screen.getByText('Partial')).toBeInTheDocument()
    expect(screen.queryByText('Shared')).toBeNull()
    expect(screen.getByText('Source: RSS sum (shared pages may be double counted)')).toBeInTheDocument()
    expect(screen.getByText('Shared pages may be double counted')).toBeInTheDocument()
    unmount()
    panel('shared')
    expect(screen.getByText('Shared')).toBeInTheDocument()
    expect(screen.getByText('Partial')).toBeInTheDocument()
  })
  it.each(['cgroup-current', 'rss-sum'] as const)('preserves retained %s qualifiers, limits and real zero independently of null current values', kind => {
    const fresh = fixtures.freshZero!, stale = fixtures.staleOnline!
    if (fresh.kind !== 'sample' || stale.kind !== 'sample' || fresh.sample.memory.state !== 'fresh') throw new Error('sample fixtures')
    const captured = { ...fresh.sample, coverage: { boundary: 'partial' as const, shared: true, reasons: ['limit', 'process-tree-partial'] as const },
      memory: { ...fresh.sample.memory, value: { ...fresh.sample.memory.value, kind, bytes: 0, sharedPagesMayDoubleCount: kind === 'rss-sum' } } }
    render(<ResourceTelemetryPanel scope="owned" title="Execution" received={{ selectorKey: stale.sample.selectorKey,
      result: { ...stale, lastKnown: { ...captured, coverage: { ...captured.coverage, reasons: [...captured.coverage.reasons] } } }, receivedMonoMs: 0, requestDurationMs: 0 }} elapsedMs={0} />)
    const last = screen.getByRole('region', { name: 'Last known' })
    expect(within(last).getByText('Shared')).toBeInTheDocument(); expect(within(last).getByText('Partial')).toBeInTheDocument()
    expect(last).toHaveTextContent('Server limit reached'); expect(last).toHaveTextContent('Process tree partially observed')
    expect(last).toHaveTextContent('CPU 0.0%'); expect(last).toHaveTextContent('RAM 0 MiB')
    expect(last).toHaveTextContent(kind === 'rss-sum' ? 'RSS sum (shared pages may be double counted)' : 'cgroup current')
    expect(within(screen.getByRole('region', { name: 'RAM Stale' })).getByText('—')).toBeInTheDocument()
  })

  it('distinguishes OS permission-denied from caller denial and shows no private values for denial', () => {
    const { unmount } = panel('permissionDenied')
    expect(screen.getAllByText('OS permission denied')).toHaveLength(2)
    unmount()
    panel('denied')
    expect(screen.getByText('Access denied')).toBeInTheDocument()
    expect(screen.queryByText('Last known · not current')).toBeNull()
    expect(screen.queryByText('0.0%')).toBeNull()
  })

  it('shows a rebooted/not-yet-sampled selection as no reading', () => {
    panel('reboot', 0, 'computer')
    expect(screen.getByText('Not sampled yet')).toBeInTheDocument()
  })

  it('marks an ended execution and keeps its values out of the current display', () => {
    panel('ended')
    expect(screen.getByText('Execution ended')).toBeInTheDocument()
    expect(screen.queryByText('Fresh')).toBeNull()
  })

  it('states that cloud inference is not measured', () => {
    panel('freshZero')
    expect(screen.queryByText(/cloud model inference is not measured/)).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About Resource usage' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Local processes only; cloud model inference is not measured.')
  })
})

describe('ComputerContextCard', () => {
  it.each([['configured', 'Configured for next Run'], ['accepted', 'Accepted on'], ['observed', 'Execution observed on']] as const)('labels %s placement', (phase, label) => {
    render(<ComputerContextCard context={{ phase, computerName: 'Laptop', computerId: '22222222-2222-4222-8222-222222222222', acceptedIdentity: 'binding-1' }} />)
    expect(screen.getByText(label)).toBeInTheDocument()
    expect(screen.getByText('Laptop')).toBeInTheDocument()
    expect(screen.getByText('binding-1')).toBeInTheDocument()
  })
})

describe('formatBinaryBytes', () => {
  it('uses binary MiB and GiB', () => {
    expect(formatBinaryBytes(0)).toBe('0 MiB')
    expect(formatBinaryBytes(1024 ** 2 * 512)).toBe('512.0 MiB')
    expect(formatBinaryBytes(1024 ** 3 * 1.5)).toBe('1.50 GiB')
    expect(formatBinaryBytes(4096)).toBe('<0.01 MiB')
  })
})
