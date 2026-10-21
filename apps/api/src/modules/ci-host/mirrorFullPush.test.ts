import { randomUUID } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'

it.each(['snapshot', 'execution ref'] as const)(
  'sends a complete public %s when the receiver repeatedly drops its advertised objects', async publication => {
    const f = await fixture({}, { provider: 'circleci' })
    const initial = f.mirrorGit('rev-parse', 'main')
    await f.cloud.publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit: f.commit })
    const parent = f.mirrorGit('rev-parse', 'main')
    const bundle = join(f.root, 'snapshot.bundle')
    f.mirrorGit('bundle', 'create', bundle, '--all')
    f.mirrorGit('update-ref', 'refs/heads/main', initial)
    const hook = join(f.git.cloneDirectory('octo/site-ci'), '.git', 'hooks', 'pre-push')
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
    const remote = `git --git-dir=${quote(join(f.root, 'mirror.git'))}`
    await mkdir(dirname(hook), { recursive: true })
    await writeFile(hook, [
      '#!/bin/sh', 'set -eu',
      'unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE GIT_EXEC_PATH',
      `${remote} update-ref -d refs/heads/ci/${f.commit}`,
      `${remote} update-ref -d refs/heads/ci-snapshot/${parent}`,
      `${remote} reflog expire --expire=now --all`,
      `${remote} gc --prune=now --quiet`, '',
    ].join('\n'))
    await chmod(hook, 0o700)
    let commit = f.commit
    if (publication === 'snapshot') {
      await f.write('README.md', 'Child public snapshot\n')
      f.run('add', '.')
      f.run('commit', '-qm', 'child snapshot')
      f.push('main')
      commit = f.run('rev-parse', 'HEAD')
    }
    const pushes: { code: number; stderr: string }[] = []
    const original = f.git.git
    f.git.git = async (args, options) => {
      if (args[0] !== 'push' || args.includes('--atomic')) return original(args, options)
      // Each connection advertises a complete parent, then the hook removes it before pack transfer.
      f.mirrorGit('fetch', '--quiet', bundle, `${parent}:refs/heads/ci/${f.commit}`,
        `${parent}:refs/heads/ci-snapshot/${parent}`)
      const result = await original(args, options)
      pushes.push(result)
      return result
    }
    const runId = randomUUID()
    const ref = publication === 'snapshot' ? 'main' : `ci/${commit}-${runId}`
    if (publication === 'snapshot') {
      await expect(f.reopen().publishMirror({ repository: 'octo/site', mirror: 'octo/site-ci', commit }))
        .resolves.toBeUndefined()
    } else {
      await expect(f.reopen().handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
        repository: 'octo/site', commit, suite: 'lint', scope: 'full' }))
        .resolves.toMatchObject({ run: { state: 'running', provenance: { workflowCommit: parent, workflowRef: ref } } })
    }
    expect(pushes).toHaveLength(2)
    expect(pushes[0]).toMatchObject({ code: 1, stderr: expect.stringContaining('(missing necessary objects)') })
    expect(pushes[1]?.code).toBe(0)
    expect(f.mirrorGit('rev-parse', `${ref}^{tree}`)).toBe(f.run('rev-parse', `${commit}^{tree}`))
    expect(f.mirrorGit('fsck', '--connectivity-only')).not.toContain('missing')
    expect(() => f.mirrorGit('cat-file', '-e', commit)).toThrow()
    expect(f.circle.triggered).toHaveLength(publication === 'snapshot' ? 0 : 1)
  },
)
