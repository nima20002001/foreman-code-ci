import { expect, it, vi } from 'vitest'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'
import { readNativeProjectionFacts } from './nativeProjectionFacts.js'

const current: CurrentNativeActivity = {
  key: { execution: { workflowNodeId: 'node', executionId: 'execution', attempt: 1,
    agentId: 'agent', agentConfigurationVersionId: 'configuration' }, workKind: 'workflow', workId: 'execution' },
  activity: { workflowNodeId: 'node', status: 'none' }, lastNativeSequence: '7',
}

it('returns no facts for already observable work without waiting for a public snapshot', async () => {
  const read = vi.fn(() => new Promise<never>(() => {}))
  expect(await readNativeProjectionFacts([current], [structuredClone(current)], read)).toEqual([])
  expect(read).not.toHaveBeenCalled()
})

it('reads both public projections when native activity changes', async () => {
  const next: CurrentNativeActivity = { ...current, activity: { workflowNodeId: 'node', status: 'unknown' } }
  const read = vi.fn(async () => [])
  expect(await readNativeProjectionFacts([current], [next], read)).toEqual([])
  expect(read.mock.calls).toEqual([[[current]], [[next]]])
})

it('preserves a public snapshot failure when the overlay changed', async () => {
  const failure = new Error('snapshot unavailable')
  const read = async () => { throw failure }
  const next: CurrentNativeActivity = { ...current, lastNativeSequence: '8' }
  await expect(readNativeProjectionFacts([current], [next], read)).rejects.toBe(failure)
})
