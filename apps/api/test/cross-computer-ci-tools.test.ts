import { expect, it, vi } from 'vitest'
import { listCiToolNames } from './helpers/crossComputerCiTools.js'
import { callCiTool } from './helpers/crossComputerCiSetup.js'

it('discovers CI tools from every public catalog page', async () => {
  const listTools = vi.fn()
    .mockResolvedValueOnce({ tools: [{ name: 'workspace_get' }], nextCursor: 'second-page' })
    .mockResolvedValueOnce({ tools: [{ name: 'ci_run' }, { name: 'ci_get' }], nextCursor: 'third-page' })
    .mockResolvedValueOnce({ tools: [{ name: 'run_start' }] })
  expect(await listCiToolNames({ listTools })).toEqual(['workspace_get', 'ci_run', 'ci_get', 'run_start'])
  expect(listTools.mock.calls).toEqual([[{}], [{ cursor: 'second-page' }], [{ cursor: 'third-page' }]])
})

it('fails if the server repeats a catalog cursor instead of looping indefinitely', async () => {
  const listTools = vi.fn().mockResolvedValue({ tools: [], nextCursor: 'same-page' })
  await expect(listCiToolNames({ listTools })).rejects.toThrow('repeated a pagination cursor')
  expect(listTools).toHaveBeenCalledTimes(2)
})

it('refreshes a torn activity read using the same public request', async () => {
  const callTool = vi.fn().mockResolvedValueOnce({ isError: true, content: [{ type: 'text',
    text: JSON.stringify({ error: { code: 'ACTIVITY_SNAPSHOT_CONFLICT', message: 'Refresh this Run.' } }) }] })
    .mockResolvedValueOnce({ content: [], structuredContent: { run: { id: 'run' } } })
  expect(await callCiTool({ callTool }, 'run_get', { workspaceId: 'workspace', runId: 'run' }))
    .toEqual({ run: { id: 'run' } })
  expect(callTool).toHaveBeenCalledTimes(2)
  expect(callTool.mock.calls[0]?.[0]).toEqual({ name: 'run_get',
    arguments: { workspaceId: 'workspace', runId: 'run' } })
  expect(callTool.mock.calls[0]?.[0]).toEqual(callTool.mock.calls[1]?.[0])
  const signals = callTool.mock.calls.map(([, options]) => {
    expect(options).toMatchObject({ timeout: 180_000, signal: expect.any(AbortSignal) })
    expect(options.signal.aborted).toBe(false)
    return options.signal
  })
  expect(signals[0]).not.toBe(signals[1])
})

it('does not retry a mutation or an unrelated read failure', async () => {
  for (const [name, code] of [['run_start', 'ACTIVITY_SNAPSHOT_CONFLICT'], ['run_get', 'ACCESS_DENIED']]) {
    const callTool = vi.fn().mockResolvedValue({ isError: true, content: [{ type: 'text',
      text: JSON.stringify({ error: { code, message: 'Rejected.' } }) }] })
    await expect(callCiTool({ callTool }, name!, {})).rejects.toThrow(code)
    expect(callTool).toHaveBeenCalledTimes(1)
  }
})
