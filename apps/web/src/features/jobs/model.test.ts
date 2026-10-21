import { it, expect } from 'vitest'
import { loadedChunks, plainLog, processLabel, queueLabel } from './model'
import { execution, logPage, queueTicket } from './fixtures'

it('deduplicates reconnect chunks while retaining Unicode and stream labels', () => {
  expect(loadedChunks([logPage, logPage])).toEqual(logPage.chunks)
  expect(plainLog('\u001b[31mλ🙂<img src=x>\u001b[0m\u001b]0;unsafe\u0007\u0000')).toBe('λ🙂<img src=x>')
})
it('keeps cancellation intent separate from observed stop and transport', () => {
  const offline = { ...execution, transport: 'offline' as const, cancelRequestedAt: execution.createdAt, process: { ...execution.process, phase: 'running' as const, outcome: null, processStopped: false } }
  expect(processLabel(offline)).toBe('Cancellation requested · stop unconfirmed')
  expect(processLabel({ ...offline, process: { ...offline.process, phase: 'terminal', outcome: 'cancelled', processStopped: true } })).toBe('Cancellation confirmed')
})
it('nonzero observed exit remains build failure despite connection loss', () => {
  expect(processLabel({ ...execution, transport: 'offline' })).toBe('build failed')
})
it('preserves long unbroken Unicode text within the contract chunk bound', () => {
  const text = '🙂λ'.repeat(10000)
  expect(plainLog(text)).toBe(text)
  expect(loadedChunks([{ ...logPage, chunks: [{ ...logPage.chunks[0]!, text }] }])[0]?.text).toBe(text)
})

it('labels a retained source reservation as waiting for capacity', () => {
  expect(queueLabel({ ...queueTicket, state: 'waiting', reservationId: queueTicket.id, waitingReasons: ['busy'],
    sourceCapacityWait: { attempts: 1, waitedMs: 0, startedAt: queueTicket.enqueuedAt, retryAt: queueTicket.deadlineAt } }))
    .toBe('Waiting for source capacity')
})
