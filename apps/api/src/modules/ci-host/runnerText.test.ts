import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { HostCiRunner } from './runner.js'

it('returns valid text from a finished host log while keeping source byte offsets', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-text-'))
  const runId = randomUUID()
  const directory = join(root, 'runs', runId)
  const log = Buffer.concat([Buffer.from('café 🚀\0'), Buffer.from([0xff]), Buffer.from('\n')])
  try {
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'meta.json'), JSON.stringify({
      runId, repository: 'example/project', commit: 'a'.repeat(40), suite: 'lint', state: 'passed',
      startedAt: '2026-10-12T00:00:01.000Z', finishedAt: '2026-10-12T00:01:00.000Z',
      exitCode: 0, message: 'Done.\0\ud800', cleaned: true,
    }))
    await writeFile(join(directory, 'log'), log)
    const result = await new HostCiRunner(root).handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 100 })
    expect(result).toMatchObject({ operation: 'read', run: { state: 'passed', message: 'Done.\ufffd', logBytes: log.length },
      text: 'café 🚀\ufffd\n', nextOffset: log.length })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
