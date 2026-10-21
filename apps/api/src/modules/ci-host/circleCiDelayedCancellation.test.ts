import { expect, it } from 'vitest'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'

const run: CloudRun = { runId: 'ticket', repository: 'fixture/site', mirror: 'fixture/site-ci',
  commit: 'a'.repeat(40), suite: 'lint', startedAt: '2026-10-01T00:00:00Z',
  providerRunId: 'pipeline', state: 'starting', finishedAt: null, exitCode: null, message: null }

it.each([
  { phase: 'ended', current_outcome: 'not_run', workflows: [] },
  { phase: 'ended', outcome: 'not_run', workflows: [] },
  { phase: 'ended', current_outcome: 'unknown', workflows: [] },
  { phase: 'ended', workflows: [] },
  { phase: 'ended', state: 'created', current_outcome: 'succeeded', workflows: [] },
])('retries Stop until a delayed workflow accepts cancellation: %j', async placeholder => {
  let visible = false
  let cancellations = 0
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(),
    run: async (_file, args) => {
      if (args.includes('get')) return { code: 0, stderr: '', stdout: JSON.stringify(visible
        ? { phase: 'started', workflows: [{ phase: 'started' }] } : placeholder) }
      if (args.includes('cancel')) {
        cancellations++
        return visible ? { code: 0, stdout: '', stderr: '' }
          : { code: 1, stdout: '', stderr: 'no active workflows' }
      }
      throw new Error(`Unexpected CircleCI command: ${args.join(' ')}`)
    } }
  const provider = new CircleCiProvider(ports, { circleToken: async () => null })
  expect(await provider.cancel(run)).toBe(false)
  visible = true
  await expect(provider.cancel(run)).resolves.toBeUndefined()
  expect(cancellations).toBe(2)
})

it.each(['succeeded', 'failed', 'canceled'])('does not cancel an empty pipeline with terminal outcome %s', async outcome => {
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 2 ** 30, now: () => new Date(),
    run: async (_file, args) => {
      expect(args).toContain('get')
      return { code: 0, stderr: '', stdout: JSON.stringify({ phase: 'ended', current_outcome: outcome, workflows: [] }) }
    } }
  await expect(new CircleCiProvider(ports, { circleToken: async () => null }).cancel(run)).resolves.toBeUndefined()
})
