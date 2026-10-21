import { act, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { resourceTelemetryFixtures } from '@foreman-code/contracts/resource-telemetry-fixtures'
import { telemetrySelectorKey, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { ComputerUtilization } from './ComputerUtilization'
import { computersFixture, mainTarget } from './computersTestFixture'

it('displays fresh zero CPU and memory as values instead of unavailable metrics', async () => {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample') throw new Error('Expected a sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.lastKnown = null
  sample.sample.storage = { totalBytes: 500 * 1024 ** 3, availableBytes: 125 * 1024 ** 3 }
  computersFixture(<ComputerUtilization target={mainTarget} online />, [
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(sample))])
  expect(await screen.findAllByText('0%')).toHaveLength(2)
  expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuenow', '0')
  expect(screen.getByText('125G free')).toBeVisible()
  expect(screen.getByRole('meter', { name: 'Disk' })).toHaveAttribute('aria-valuenow', '75')
  expect(screen.getByRole('meter', { name: 'Disk' })).toHaveAttribute('aria-valuetext', '125G free of 500G')
})
it('does not request or present retained utilization for an offline computer', async () => {
  computersFixture(<ComputerUtilization target={mainTarget} online={false} />)
  expect(screen.getAllByText('—')).toHaveLength(3)
  expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuetext', 'Unavailable')
  expect(screen.getByRole('meter', { name: 'CPU' })).not.toHaveAttribute('aria-valuenow')
})
it('keeps the last current reading, marked as last known, while a refresh brings no current value', async () => {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample') throw new Error('Expected a sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.lastKnown = null
  const stale = structuredClone(sample)
  stale.sample.cpu = { state: 'stale', value: null, reason: 'stale', sampledAtUnixMs: null, freshUntilUnixMs: null }
  stale.sample.memory = { state: 'stale', value: null, reason: 'stale', sampledAtUnixMs: null, freshUntilUnixMs: null }
  let reading = sample
  const f = computersFixture(<ComputerUtilization target={mainTarget} online />, [
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(reading))])
  expect(await screen.findAllByText('0%')).toHaveLength(2)
  reading = stale
  await act(() => f.client.refetchQueries({ queryKey: ['computer-utilization'] }))

  await waitFor(() => expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuetext', 'Last known 0%'))
  expect(screen.getAllByText('0%')).toHaveLength(2)
  expect(screen.getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuetext', 'Last known 0%')
})
it('keeps the last CPU reading while memory is current and CPU is warming up', async () => {
  const sample = structuredClone(resourceTelemetryFixtures.computerZero!)
  if (sample.kind !== 'sample') throw new Error('Expected a sample fixture')
  const selector: TelemetrySelector = { ...sample.sample.selector, host: { ...sample.sample.selector.host,
    applicationInstallationId: mainTarget.applicationInstallationId } }
  sample.sample.selector = selector
  sample.sample.identity.host = selector.host
  sample.sample.selectorKey = telemetrySelectorKey(selector)
  sample.lastKnown = null
  const warming = structuredClone(sample)
  warming.sample.cpu = { state: 'stale', value: null, reason: 'stale', sampledAtUnixMs: null, freshUntilUnixMs: null }
  let reading = sample
  const f = computersFixture(<ComputerUtilization target={mainTarget} online />, [
    http.post('*/api/management/resource-telemetry/selector', () => HttpResponse.json({ kind: 'selector', selector })),
    http.post('*/api/management/resource-telemetry/read', () => HttpResponse.json(reading))])
  expect(await screen.findAllByText('0%')).toHaveLength(2)
  reading = warming
  await act(() => f.client.refetchQueries({ queryKey: ['computer-utilization'] }))

  await waitFor(() => expect(screen.getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuetext', 'Last known 0%'))
  expect(screen.getByRole('meter', { name: 'Memory' })).not.toHaveAttribute('aria-valuetext', 'Last known 0%')
  expect(screen.getAllByText('0%')).toHaveLength(2)
})
