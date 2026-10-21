import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { expect, it, vi } from 'vitest'
import { AgentCiReportSchema, readAgentCiReport, readCiLog,
  requireCiStateOrder } from './helpers/crossComputerCiReadback.js'

function report() {
  return { suite: 'build', outcome: 'passed', repository: 'example/project',
    logLine: 'Build passed', observedStates: ['queued', 'running', 'passed'] }
}

it('reads a complete Agent report from a native text envelope', () => {
  const value = report()
  expect(readAgentCiReport({ text: JSON.stringify(value) })).toEqual(value)
  expect(readAgentCiReport(value)).toEqual(value)
  expect(readAgentCiReport({ text: JSON.stringify({ routing: { kind: 'finish' }, data: { latestDeliverable: value } }) }))
    .toEqual(value)
})

it('accepts judgments without copied identifiers and rejects empty observations or logs', () => {
  const value = report()
  expect(AgentCiReportSchema.safeParse(value).success).toBe(true)
  expect(AgentCiReportSchema.safeParse({ ...value, observedStates: [] }).success).toBe(false)
  expect(AgentCiReportSchema.safeParse({ ...value, logLine: ' ' }).success).toBe(false)
})

it('requires known CI states and a terminal result without inferring unobserved transitions', () => {
  expect(() => requireCiStateOrder(['queued', 'starting', 'running', 'passed'])).not.toThrow()
  expect(() => requireCiStateOrder(['starting', 'failed'])).not.toThrow()
  expect(() => requireCiStateOrder(['queued', 'running'])).toThrow()
  expect(() => requireCiStateOrder(['running', 'starting', 'passed'])).not.toThrow()
  expect(() => requireCiStateOrder(['unknown', 'passed'])).toThrow()
  expect(() => requireCiStateOrder(['failed', 'passed'])).toThrow()
})

it('reads the full ticket log by following byte offsets through public MCP', async () => {
  const callTool = vi.fn()
    .mockResolvedValueOnce({ content: [], structuredContent: { text: 'first\n', nextOffset: 6, logBytes: 11, maxBytes: 65_536 } })
    .mockResolvedValueOnce({ content: [], structuredContent: { text: 'last\n', nextOffset: 11, logBytes: 11, maxBytes: 65_536 } })
  const scope = { workspaceId: 'workspace', ticketId: randomUUID() }
  expect(await readCiLog({ callTool }, scope))
    .toEqual({ text: 'first\nlast\n', logBytes: 11 })
  expect(callTool.mock.calls.map(call => call[0])).toEqual([
    { name: 'ci_logs_read', arguments: { ...scope, afterOffset: 0, maxBytes: 65_536 } },
    { name: 'ci_logs_read', arguments: { ...scope, afterOffset: 6, maxBytes: 65_536 } },
  ])
})

it('fails when a log reader stops advancing before the log is complete', async () => {
  const callTool = vi.fn().mockResolvedValue({ content: [], structuredContent: { text: '', nextOffset: 0, logBytes: 11, maxBytes: 65_536 } })
  await expect(readCiLog({ callTool }, {
    workspaceId: 'workspace', ticketId: randomUUID(),
  })).rejects.toThrow('advance')
  expect(callTool).toHaveBeenCalledTimes(1)
})

it.each([
  ['queued', 'starting', 'running', 'queued', 'starting', 'running', 'passed'],
  ['running', 'queued', 'passed'],
  ['starting', 'queued', 'running', 'passed'],
])('accepts a recovered CI lifecycle: %j', (...states) => {
  expect(() => requireCiStateOrder(states)).not.toThrow()
})

it.each([
  ['passed', 'queued', 'passed'],
  ['failed', 'queued', 'passed'],
  ['canceled', 'running', 'passed'],
  ['lost', 'starting', 'passed'],
])('rejects changes after terminal CI state: %j', (...states) => {
  expect(() => requireCiStateOrder(states)).toThrow()
})

it('applies the collection deadline to a ticket log request', async () => {
  vi.useFakeTimers()
  try {
    const started = Date.now()
    const callTool = vi.fn<Client['callTool']>(async (_request, options) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve({ content: [], structuredContent: {
        text: 'complete', nextOffset: 8, logBytes: 8, maxBytes: 65_536,
      } }), 60_000)
      const signal = options?.signal
      signal?.addEventListener('abort', () => {
        clearTimeout(timer)
        reject(signal.reason)
      }, { once: true })
    }))
    const pending = expect(readCiLog({ callTool }, { workspaceId: 'workspace', ticketId: randomUUID() }, {
      deadline: started + 10_000,
    })).rejects.toThrow('Timed out')
    await Promise.all([pending, vi.runAllTimersAsync()])
    expect(Date.now() - started).toBe(10_000)
    expect(callTool).toHaveBeenCalledTimes(1)
  } finally {
    vi.useRealTimers()
  }
})
