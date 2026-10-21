import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { CloudCi } from './cloud.js'
import type { CloudProvider, CloudRun } from './cloudProviders.js'
import type { HostCiPorts } from './runner.js'
import type { GitWorktreePorts } from '../sources/gitWorktree.js'

it.each(['github', 'circleci'] as const)('cleans selected terminal %s directories while retaining active ones', async provider => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'cloud-cleanup-'))
  const ports: HostCiPorts = { cpus: 4, memoryBytes: 8 * 2 ** 30, now: () => new Date(),
    run: async () => ({ code: 0, stdout: '', stderr: '' }) }
  const git: GitWorktreePorts = { cloneDirectory: () => root,
    git: async () => ({ code: 0, stdout: '', stderr: '' }) }
  const cloud = new CloudCi('fixture-main', { id: provider, cpus: ports.cpus, memoryBytes: ports.memoryBytes,
    userSystemd: { supported: false, reason: 'Fixture provider' }, ready: async () => true } as CloudProvider, async () => null, root, ports, git)
  const ids = [randomUUID(), randomUUID(), randomUUID()]
  try {
    for (const [index, runId] of ids.entries()) {
      const run: CloudRun = { runId, repository: 'fixture/site', mirror: 'fixture/mirror',
        commit: 'a'.repeat(40), suite: 'lint', state: index === 1 ? 'running' : 'passed',
        startedAt: index === 1 ? new Date().toISOString() : '2026-10-01T00:00:00Z', finishedAt: '2026-10-01T00:01:00Z',
        providerRunId: null, exitCode: 0, message: null }
      const directory = join(root, 'runs', runId)
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, 'meta.json'), JSON.stringify(run))
    }
    await expect(cloud.handle({ operation: 'status', cleanupRunIds: ids.slice(0, 2) }))
      .resolves.toMatchObject({ operation: 'status', removedRunIds: [ids[0]] })
    await expect(access(join(root, 'runs', ids[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
    for (const id of ids.slice(1)) await expect(access(join(root, 'runs', id))).resolves.toBeUndefined()
  } finally {
    await cloud.waitForMirrorCleanup('fixture/site', 'fixture/mirror')
    await rm(root, { recursive: true, force: true })
  }
})
