import { expect, it } from 'vitest'
import { cloudCiLookupFixture } from '../../../test/helpers/cloudCiLookupFixture.js'
import { expectCliRunMessage } from './cloudAssertions.testSupport.js'

it.each(['starting', 'running'] as const)('cancels a known CircleCI pipeline after denied lookup and confirms termination from %s', async state => {
  const errors = ['permission denied', 'authentication required', 'HTTP 401 Unauthorized', 'HTTP 403 Forbidden']
  for (const error of errors) {
    const f = await cloudCiLookupFixture(state)
    try {
      f.control.operation = 'run'
      f.control.error = error
      const request = { operation: 'cancel', runId: f.run.runId }
      await expect(f.reopen().handle(request)).rejects.toMatchObject({ code: 'CI_CLOUD_RUN_UNREADABLE' })
      expect(f.control.canceled).toEqual(['pipeline-1'])
      f.advance(75_001)
      expect(await f.reopen().handle({ operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }))
        .toMatchObject({ run: { state, finishedAt: null } })
      f.control.error = ''
      f.control.outcome = 'canceled'
      const canceled = await f.reopen().handle(request)
      expect(canceled).toMatchObject({ run: { state: 'canceled', finishedAt: expect.any(String) } })
      if (canceled.operation !== 'cancel') throw new Error('Expected a cancel reply')
      expectCliRunMessage(canceled.run, 'Canceled.')
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'canceled' } })
      f.advance(4_001)
      const read = await f.reopen().handle({ operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 })
      expect(read).toMatchObject({ run: { state: 'canceled' } })
      if (read.operation !== 'read') throw new Error('Expected a read reply')
      expectCliRunMessage(read.run, 'Canceled.')
      expect(f.control.canceled).toEqual(['pipeline-1'])
    } finally {
      await f.close()
    }
  }
})

it.each(['starting', 'running'] as const)('requeues permanent CircleCI lookup failures from %s', async state => {
  const f = await cloudCiLookupFixture(state)
  try {
    f.control.error = 'permission denied'
    const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
    for (let attempt = 0; attempt < 3; attempt++) {
      f.advance(4_001)
      await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null,
        message: expect.stringContaining('permission denied') } })
    }
    const reads = f.control.reads
    f.advance(75_000)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null } })
    f.control.error = ''
    f.control.outcome = 'canceled'
    f.advance(75_001)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued',
      message: expect.stringContaining('queued for another computer') } })
    expect(f.control.reads).toBeGreaterThan(reads)
    expect(f.control.canceled).toEqual(['pipeline-1'])
  } finally { await f.close() }
})

it.each(['starting', 'running'] as const)('keeps an unreadable CircleCI pipeline owned until its cancellation succeeds from %s', async state => {
  const f = await cloudCiLookupFixture(state)
  try {
    f.control.error = 'permission denied'
    f.control.cancelError = 'service unavailable'
    const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
    f.advance(4_001)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state,
      message: expect.stringContaining('could not be reconciled') } })
    f.advance(75_000)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state,
      message: expect.stringContaining('Cancellation could not be confirmed') } })
    f.advance(4_001)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state } })
    f.control.cancelError = ''
    f.advance(4_001)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state, finishedAt: null } })
    f.control.error = ''
    f.control.outcome = 'canceled'
    f.advance(75_001)
    await expect(f.reopen().handle(request)).resolves.toMatchObject({ run: { state: 'queued',
      message: expect.stringContaining('queued for another computer') } })
    expect(f.control.canceled.length).toBeGreaterThanOrEqual(3)
  } finally { await f.close() }
})

it.each(['permission denied', 'authentication required', 'HTTP 401 Unauthorized', 'HTTP 403 Forbidden'])(
  'recovers a lookup after %s without dispatching another pipeline', async error => {
    const f = await cloudCiLookupFixture('running')
    try {
      f.control.error = error
      const request = { operation: 'read', runId: f.run.runId, afterOffset: 0, maxBytes: 1 }
      await expect(f.cloud.handle(request)).resolves.toMatchObject({ run: { state: 'running',
        message: expect.stringContaining('could not be reconciled') } })
      f.control.error = ''
      f.advance(4_001)
      const read = await f.reopen().handle(request)
      expect(read).toMatchObject({ run: { state: 'running' } })
      if (read.operation !== 'read') throw new Error('Expected a read reply')
      expectCliRunMessage(read.run, null)
      expect(f.control.canceled).toEqual([])
    } finally { await f.close() }
  },
)
