import { AGENT_SNAPSHOT_MAX_BYTES } from '@foreman-code/contracts/source-materialization'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceError } from './manifest.js'
import type { GitWorktreePorts } from './gitWorktree.js'
import { gitFailure } from './gitErrors.js'

const COMMIT = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u
const author = { GIT_AUTHOR_NAME: 'Foreman Code', GIT_AUTHOR_EMAIL: 'ci@foreman-code.invalid',
  GIT_COMMITTER_NAME: 'Foreman Code', GIT_COMMITTER_EMAIL: 'ci@foreman-code.invalid' }

/** Unchanged files reuse the base commit. Edited files become a bundle without moving the Agent's branch. */
export async function snapshotAgentWorktree(ports: Pick<GitWorktreePorts, 'git'>, input: { path: string; baseCommit: string },
  signal: AbortSignal): Promise<{ commit: string; bundle: Buffer | null }> {
  if (!COMMIT.test(input.baseCommit)) throw new SourceError('SOURCE_SNAPSHOT_INVALID', 'The base commit is invalid.')
  const scratch = await mkdtemp(join(tmpdir(), 'foreman-ci-snapshot-'))
  const git = async (args: string[], env: Record<string, string> = {}) => {
    const result = await ports.git(args, { cwd: input.path, signal, env })
    if (result.code !== 0) throw gitFailure('SOURCE_SNAPSHOT_FAILED', args[0])
    return result.stdout.trim()
  }
  try {
    if ((await ports.git(['merge-base', '--is-ancestor', input.baseCommit, 'HEAD'], { cwd: input.path, signal })).code !== 0) {
      throw new SourceError('SOURCE_SNAPSHOT_INVALID', 'This folder is not an Agent worktree of the approved base.')
    }
    const index = { GIT_INDEX_FILE: join(scratch, 'index') }
    await git(['read-tree', 'HEAD'], index)
    await git(['add', '-A'], index)
    const tree = await git(['write-tree'], index)
    const baseTree = await git(['rev-parse', `${input.baseCommit}^{tree}`])
    if (tree === baseTree) return { commit: input.baseCommit, bundle: null }
    const commit = await git(['commit-tree', tree, '-p', 'HEAD', '-m', 'Foreman Code CI snapshot'], author)
    const ref = `refs/foreman/ci/snapshots/${randomUUID()}`
    await git(['update-ref', ref, commit])
    try {
      await git(['bundle', 'create', join(scratch, 'snapshot.bundle'), ref, `^${input.baseCommit}`])
    } finally { await ports.git(['update-ref', '-d', ref], { cwd: input.path, signal }) }
    const bundlePath = join(scratch, 'snapshot.bundle')
    if ((await stat(bundlePath)).size > AGENT_SNAPSHOT_MAX_BYTES) {
      throw new SourceError('SOURCE_SNAPSHOT_TOO_LARGE', 'These changes are too large to send for CI; push the branch instead.')
    }
    const bundle = await readFile(bundlePath)
    return { commit, bundle }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}

/** Adds an Agent snapshot bundle to this computer's clone so the commit can be approved and checked out. */
export async function importAgentSnapshot(ports: Pick<GitWorktreePorts, 'git'>, clone: string,
  snapshot: { commit: string; bundle: Buffer | null }, signal: AbortSignal): Promise<void> {
  if (!COMMIT.test(snapshot.commit)) throw new SourceError('SOURCE_SNAPSHOT_INVALID', 'The snapshot commit is invalid.')
  if (snapshot.bundle === null) {
    const result = await ports.git(['cat-file', '-e', `${snapshot.commit}^{commit}`], { cwd: clone, signal })
    if (result.code !== 0) throw gitFailure('SOURCE_SNAPSHOT_FAILED', 'cat-file')
    return
  }
  const scratch = await mkdtemp(join(tmpdir(), 'foreman-ci-import-'))
  try {
    const file = join(scratch, 'snapshot.bundle')
    await writeFile(file, snapshot.bundle, { mode: 0o600 })
    const heads = await ports.git(['bundle', 'list-heads', file], { cwd: clone, signal })
    const [commit, bundledRef] = heads.stdout.trim().split(/\s+/u)
    if (heads.code !== 0 || commit !== snapshot.commit || !bundledRef
      || !/^refs\/foreman\/ci\/(?:[a-f0-9]{40}(?:[a-f0-9]{24})?|snapshots\/[a-f0-9-]{36})$/u.test(bundledRef)) {
      throw new SourceError('SOURCE_SNAPSHOT_FAILED', 'The Agent snapshot does not contain the expected commit.')
    }
    const ref = `refs/foreman/ci/${snapshot.commit}`
    const fetched = await ports.git(['fetch', '--no-tags', file, `${bundledRef}:${ref}`], { cwd: clone, signal })
    if (fetched.code !== 0) throw new SourceError('SOURCE_SNAPSHOT_FAILED', 'The Agent snapshot could not be added to the clone.')
    const head = await ports.git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: clone, signal })
    if (head.code !== 0 || head.stdout.trim() !== snapshot.commit) {
      throw new SourceError('SOURCE_SNAPSHOT_FAILED', 'The Agent snapshot does not contain the expected commit.')
    }
  } finally { await rm(scratch, { recursive: true, force: true }) }
}
