import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { readOperationalFailures } from '../diagnostics/operationalFailures.js'
import { fixture } from './cloud.testSupport.js'

const publication = (commit: string) => ({ repository: 'octo/site', mirror: 'octo/site-ci', commit })

async function retireSnapshotAfterAdvertisement(f: Awaited<ReturnType<typeof fixture>>, snapshot: string) {
  const hook = join(f.git.cloneDirectory('octo/site-ci'), '.git', 'hooks', 'pre-push')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const remote = `git --git-dir=${quote(join(f.root, 'mirror.git'))}`
  // pre-push runs after advertisement. Reclaiming the deleted refs' objects forces a real connectivity failure.
  await mkdir(dirname(hook), { recursive: true })
  await writeFile(hook, [
    '#!/bin/sh',
    'set -eu',
    'rm -- "$0"',
    'unset GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_INDEX_FILE',
    `${remote} update-ref -d refs/heads/ci/${f.commit}`,
    `${remote} update-ref -d refs/heads/ci-snapshot/${snapshot}`,
    `${remote} reflog expire --expire=now --all`,
    `${remote} gc --prune=now --quiet`,
    '',
  ].join('\n'))
  await chmod(hook, 0o700)
}

it('renegotiates once when an advertised snapshot disappears during publication of its cached child', async () => {
  const f = await fixture()
  const initial = f.mirrorGit('rev-parse', 'main')
  await f.cloud.publishMirror(publication(f.commit))
  const parent = f.mirrorGit('rev-parse', 'main')
  // Another publisher replaces main; only the old snapshot branches now retain the cached parent.
  f.mirrorGit('update-ref', 'refs/heads/main', initial)
  await f.write('README.md', 'child snapshot\n')
  f.run('add', '.')
  f.run('commit', '-qm', 'child')
  f.push('main')
  const commit = f.run('rev-parse', 'HEAD')
  await retireSnapshotAfterAdvertisement(f, parent)
  const pushes: { code: number; stderr: string }[] = []
  const git = f.git.git
  f.git.git = async (args, options) => {
    const result = await git(args, options)
    if (args[0] === 'push' && args.includes('--force')) pushes.push(result)
    return result
  }

  await expect(f.reopen().publishMirror(publication(commit))).resolves.toBeUndefined()
  expect(pushes).toHaveLength(2)
  expect(pushes[0]).toMatchObject({ code: 1, stderr: expect.stringContaining('(missing necessary objects)') })
  expect(pushes[1]?.code).toBe(0)
  expect(f.mirrorGit('rev-parse', 'main^')).toBe(parent)
  const snapshot = f.mirrorGit('rev-parse', `refs/heads/ci/${commit}`)
  expect(f.mirrorGit('rev-parse', `refs/heads/ci-snapshot/${snapshot}`)).toBe(snapshot)
  expect(f.mirrorGit('rev-parse', 'main^{tree}')).toBe(f.run('rev-parse', `${commit}^{tree}`))
  expect(f.mirrorGit('fsck', '--connectivity-only')).not.toContain('missing')
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'retry CI mirror push', attempt: 1,
  }))
})

it.each([
  { reason: 'missing necessary objects', attempts: 2 },
  { reason: 'hook declined', attempts: 1 },
  { reason: 'permission denied', attempts: 1 },
])('propagates a persistent $reason rejection after $attempts push attempts', async ({ reason, attempts }) => {
  const f = await fixture()
  const initial = f.mirrorGit('rev-parse', 'main')
  const git = f.git.git
  let pushes = 0
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes('--force')) {
      pushes++
      return { code: 1, stdout: '',
        stderr: ` ! [remote rejected] snapshot -> ci/child (${reason})\nerror: failed to push some refs` }
    }
    return git(args, options)
  }

  await expect(f.cloud.publishMirror(publication(f.commit))).rejects.toThrow(`(${reason})`)
  expect(pushes).toBe(attempts)
  expect(f.mirrorGit('rev-parse', 'main')).toBe(initial)
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/')).toBe('')
  expect(f.dispatched).toHaveLength(0)
})

it('renegotiates a CircleCI dispatch push when its advertised snapshot disappears', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const initial = f.mirrorGit('rev-parse', 'main')
  await f.cloud.publishMirror(publication(f.commit))
  const snapshot = f.mirrorGit('rev-parse', 'main')
  f.mirrorGit('update-ref', 'refs/heads/main', initial)
  f.advance(30_000)
  await retireSnapshotAfterAdvertisement(f, snapshot)
  const runId = randomUUID()
  const workflowRef = `ci/${f.commit}-${runId}`
  const pushes: { code: number; stderr: string }[] = []
  const git = f.git.git
  f.git.git = async (args, options) => {
    const result = await git(args, options)
    if (args[0] === 'push' && args.includes(`${snapshot}:refs/heads/${workflowRef}`)) pushes.push(result)
    return result
  }
  const failuresBefore = readOperationalFailures().find(failure => failure.operation === 'retry CI mirror push')
    ?.failureCount ?? 0

  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .resolves.toMatchObject({ run: { state: 'running', provenance: { workflowCommit: snapshot, workflowRef } } })
  expect(pushes).toHaveLength(2)
  expect(pushes[0]).toMatchObject({ code: 1, stderr: expect.stringContaining('(missing necessary objects)') })
  expect(pushes[1]?.code).toBe(0)
  expect(f.circle.triggered).toHaveLength(1)
  expect(f.mirrorGit('rev-parse', workflowRef)).toBe(snapshot)
  expect(f.mirrorGit('rev-parse', 'main')).toBe(initial)
  expect(f.mirrorGit('rev-parse', `${workflowRef}^{tree}`)).toBe(f.run('rev-parse', `${f.commit}^{tree}`))
  expect(f.mirrorGit('fsck', '--connectivity-only')).not.toContain('missing')
  expect(await f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
    .toMatchObject({ run: { state: 'running', provenance: { workflowCommit: snapshot, workflowRef } } })
  expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
    operation: 'retry CI mirror push', attempt: 1, failureCount: failuresBefore + 1,
  }))
})

it.each([
  { reason: 'missing necessary objects', attempts: 2 },
  { reason: 'hook declined', attempts: 1 },
  { reason: 'permission denied', attempts: 1 },
])('propagates a persistent CircleCI dispatch $reason rejection after $attempts attempts', async ({ reason, attempts }) => {
  const f = await fixture({}, { provider: 'circleci' })
  await f.cloud.publishMirror(publication(f.commit))
  const snapshot = f.mirrorGit('rev-parse', 'main')
  const runId = randomUUID()
  const workflowRef = `ci/${f.commit}-${runId}`
  const git = f.git.git
  let pushes = 0
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes(`${snapshot}:refs/heads/${workflowRef}`)) {
      pushes++
      return { code: 1, stdout: '',
        stderr: ` ! [remote rejected] ${snapshot} -> ${workflowRef} (${reason})\nerror: failed to push some refs` }
    }
    return git(args, options)
  }

  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow(`(${reason})`)
  expect(pushes).toBe(attempts)
  expect(f.mirrorGit('for-each-ref', '--format=%(refname)', `refs/heads/${workflowRef}`)).toBe('')
  expect(f.circle.triggered).toHaveLength(0)
})

it('retains the only snapshot ref while pruning stale branches during a pending CircleCI dispatch', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const initial = f.mirrorGit('rev-parse', 'main')
  await f.cloud.publishMirror(publication(f.commit))
  const snapshot = f.mirrorGit('rev-parse', 'main')
  const snapshotRef = `refs/heads/ci-snapshot/${snapshot}`
  f.mirrorGit('update-ref', 'refs/heads/main', initial)
  f.mirrorGit('update-ref', '-d', `refs/heads/ci/${f.commit}`)
  f.mirrorGit('update-ref', 'refs/heads/ci/stale', initial)
  const runId = randomUUID()
  const workflowRef = `ci/${f.commit}-${runId}`
  let release!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  let entered!: () => void
  const pushing = new Promise<void>(resolve => { entered = resolve })
  const git = f.git.git
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes(`${snapshot}:refs/heads/${workflowRef}`)) {
      entered()
      await blocked
    }
    return git(args, options)
  }
  const start = f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  try {
    await pushing
    await f.cloud.waitForMirrorCleanup('octo/site', 'octo/site-ci')
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', '--contains', snapshot)).toBe(snapshotRef)
    expect(f.mirrorGit('for-each-ref', '--format=%(refname)', 'refs/heads/ci/stale')).toBe('')
    expect(f.circle.triggered).toHaveLength(0)
    release()
    await expect(start).resolves.toMatchObject({ run: { state: 'running' } })
    expect(f.mirrorGit('rev-parse', workflowRef)).toBe(snapshot)
    expect(f.circle.triggered).toHaveLength(1)
  } finally {
    release()
    await start
  }
})

it.each([
  { stderr: ' ! [remote rejected] SNAPSHOT -> REF (failed)\nerror: failed to push some refs' },
  { stderr: 'remote: fatal error in commit_refs\n ! [remote rejected] SNAPSHOT -> REF (failure)\nerror: failed to push some refs' },
])('retries a CircleCI dispatch push that GitHub rejects transiently while many parts push at once', async ({ stderr }) => {
  const f = await fixture({}, { provider: 'circleci' })
  await f.cloud.publishMirror(publication(f.commit))
  const snapshot = f.mirrorGit('rev-parse', 'main')
  const runId = randomUUID()
  const workflowRef = `ci/${f.commit}-${runId}`
  const git = f.git.git
  let pushes = 0
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes(`${snapshot}:refs/heads/${workflowRef}`) && ++pushes === 1) {
      return { code: 1, stdout: '', stderr: stderr.replace('SNAPSHOT', snapshot).replace('REF', workflowRef) }
    }
    return git(args, options)
  }

  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' }))
    .resolves.toMatchObject({ run: { state: 'running', provenance: { workflowCommit: snapshot, workflowRef } } })
  expect(pushes).toBe(2)
  expect(f.mirrorGit('rev-parse', workflowRef)).toBe(snapshot)
  expect(f.circle.triggered).toHaveLength(1)
})

it('stops retrying a CircleCI dispatch push that GitHub keeps failing', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  await f.cloud.publishMirror(publication(f.commit))
  const snapshot = f.mirrorGit('rev-parse', 'main')
  const runId = randomUUID()
  const workflowRef = `ci/${f.commit}-${runId}`
  const git = f.git.git
  let pushes = 0
  f.git.git = async (args, options) => {
    if (args[0] === 'push' && args.includes(`${snapshot}:refs/heads/${workflowRef}`)) {
      pushes++
      return { code: 1, stdout: '', stderr: ` ! [remote rejected] ${snapshot} -> ${workflowRef} (failed)\nerror: failed to push some refs` }
    }
    return git(args, options)
  }

  await expect(f.cloud.handle({ operation: 'start', runId, workspaceId: 'ci-workspace',
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })).rejects.toThrow('(failed)')
  expect(pushes).toBe(6)
  expect(f.circle.triggered).toHaveLength(0)
})
