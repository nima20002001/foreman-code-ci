import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it.each(['rejected', 'nonzero', 'malformed', 'incomplete'] as const)(
  'refuses public mirror publication when fleet inventory is %s', async failure => {
    const f = await fixture()
    const head = f.mirrorGit('rev-parse', 'main')
    const original = f.ports.run.bind(f.ports)
    vi.spyOn(f.ports, 'run').mockImplementation(async (file, args, options) => {
      if (file !== 'tailscale') return original(file, args, options)
      if (failure === 'rejected') throw new Error('private diagnostic must be redacted')
      return { code: failure === 'nonzero' ? 1 : 0,
        stdout: failure === 'malformed' ? '{' : '{}', stderr: 'private diagnostic must be redacted' }
    })
    const runId = randomUUID()
    await f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
      repository: 'octo/site', commit: f.commit, suite: 'lint', deferMirror: true })
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    const response = await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
    expect(response).toMatchObject({ run: { state: 'failed', mirrorPublication: { state: 'failed' },
      message: expect.stringContaining('fleet identity inventory') } })
    expect(response.operation).toBe('read')
    if (response.operation !== 'read') throw new Error('Expected a CI read reply')
    expect(response.run.message).not.toContain('private diagnostic')
    expect(f.mirrorGit('rev-parse', 'main')).toBe(head)
    expect(f.dispatched).toHaveLength(0)
  })
