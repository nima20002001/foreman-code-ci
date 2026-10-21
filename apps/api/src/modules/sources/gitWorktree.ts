import { lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { SourceError } from './manifest.js'
import { DomainError } from '../errors.js'
import { gitAcquisitionFailure, gitFailure } from './gitErrors.js'
import { directoryFlags, withPrivateDirectoryLock } from './privateFilesystem.js'
import { runGitProcess } from './gitProcess.js'
import { runGitWithCacheStorage } from './gitCacheStorage.js'

export interface WorktreeRequest { repository: string; branch: string }
export interface GitWorktreePorts {
  /** One clone per repository on this computer, outside every approved root. */
  cloneDirectory(repository: string): string
  git(args: string[], options: { cwd?: string; signal: AbortSignal; env?: Record<string, string>;
    lifetimeLockFd?: number }): Promise<{ code: number; stdout: string; stderr: string }>
}

const REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/u
/** Git ref rules plus a fixed product prefix, so a branch can never name another ref or an option. */
export function assertWorktreeRequest(request: WorktreeRequest) {
  const [, name] = request.repository.split('/')
  if (!REPOSITORY.test(request.repository) || name === '.' || name === '..') {
    throw new SourceError('SOURCE_WORKTREE_INVALID', 'The workspace repository must be owner/name.')
  }
  if (!/^foreman\/[A-Za-z0-9._/-]{1,200}$/u.test(request.branch) || request.branch.includes('..') || request.branch.includes('//')
    || request.branch.endsWith('/') || request.branch.endsWith('.lock') || request.branch.endsWith('.')) {
    throw new SourceError('SOURCE_WORKTREE_INVALID', 'The agent branch name is invalid.')
  }
}

/** Fetches the approved commit into this computer's clone and adds a worktree on the agent's branch. */
export async function addGitWorktree(ports: GitWorktreePorts, request: WorktreeRequest, commit: string, path: string,
  signal: AbortSignal, options?: {
    checkout: 'deferred'
    beforeAllocate?(branch: string): Promise<void>
  }): Promise<{ branch: string; commit: string }> {
  assertWorktreeRequest(request)
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(commit)) throw new SourceError('SOURCE_WORKTREE_INVALID', 'The approved commit is invalid.')
  const clone = await ensureCommit(ports, request.repository, commit, signal)
  const run = async (args: string[], cwd?: string) => {
    const result = await ports.git(args, { ...(cwd ? { cwd } : {}), signal })
    if (result.code !== 0) throw gitFailure('SOURCE_WORKTREE_FAILED', args[0])
    return result.stdout
  }
  // Worktrees whose Run directory was retired leave stale entries; their branches and commits stay in the clone.
  await run(['worktree', 'prune'], clone)
  // Occurrences keep their branches; random suffixes also avoid allocation races.
  for (;;) {
    const suffix = `-${randomUUID()}`
    const branchLimit = 'foreman/'.length + 200
    const branch = `${request.branch.slice(0, branchLimit - suffix.length)}${suffix}`
    const existing = await ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: clone, signal })
    if (existing.code === 0) continue
    await options?.beforeAllocate?.(branch)
    await run(['worktree', 'add', ...(options?.checkout === 'deferred' ? ['--no-checkout'] : []),
      '-b', branch, path, commit], clone)
    if (options?.checkout === 'deferred') await run(['read-tree', commit], path)
    const head = (await run(['rev-parse', 'HEAD'], path)).trim()
    if (head !== commit) throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'The worktree is not at the approved commit.')
    await ensureWorktreeGitIdentity(ports, path, signal)
    return { branch, commit }
  }
}

/** Linked worktrees share repo-local configuration, so identity setup holds the common directory lock. */
export async function ensureWorktreeGitIdentity(ports: GitWorktreePorts, path: string, signal: AbortSignal): Promise<void> {
  const common = await runGit(ports, ['rev-parse', '--path-format=absolute', '--git-common-dir'], path, signal)
  const directory = await open(common.trim(), directoryFlags)
  try {
    await withPrivateDirectoryLock(directory, async () => {
      for (const [key, fallback] of [
        ['user.name', 'Foreman Code Agent'],
        ['user.email', 'agent@foreman-code.invalid'],
      ] as const) {
        const configured = await ports.git(['config', '--local', '--get', key], { cwd: path, signal })
        if (configured.code !== 0 && configured.code !== 1) throw gitFailure('SOURCE_WORKTREE_FAILED', 'config')
        if (configured.code === 0 && configured.stdout.trim()) continue
        await runGit(ports, ['config', '--local', key, fallback], path, signal)
      }
    }, { signal })
  } finally {
    await directory.close()
  }
}

/** This computer's clone of the repository, holding the commit (fetched from GitHub when missing). */
export async function ensureCommit(ports: GitWorktreePorts, repository: string, commit: string, signal: AbortSignal): Promise<string> {
  const clone = await ensureClone(ports, repository, signal)
  if ((await ports.git(['cat-file', '-e', `${commit}^{commit}`], { cwd: clone, signal })).code !== 0) {
    await runGit(ports, ['fetch', '--no-tags', 'origin', commit], clone, signal)
  }
  await fetchMissingSourceObjects(ports, clone, commit, signal)
  return clone
}

/** Shallow caches may lack the ancestry two commits share: deepen their histories in bounded steps until `connected`. */
export async function deepenUntilConnected(ports: GitWorktreePorts, clone: string, commits: string[],
  connected: () => Promise<boolean>, signal: AbortSignal): Promise<boolean> {
  for (const depth of [100, 1_000, 10_000]) {
    const fetched = await ports.git(['fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no',
      `--depth=${depth}`, 'origin', ...commits], { cwd: clone, signal })
    if (fetched.code !== 0) return false
    if (await connected()) return true
  }
  return false
}

export async function fetchMissingSourceObjects(ports: GitWorktreePorts, clone: string, commit: string, signal: AbortSignal) {
  const objects = await runGit(ports, ['rev-list', '--objects', '--no-object-names', '--missing=print',
    `${commit}^{tree}`], clone, signal)
  const missing = objects.split('\n').filter(line => /^\?(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(line))
    .map(line => line.slice(1))
  // The authenticated fetch fills partial clones before credential-free capture reads their objects.
  for (let offset = 0; offset < missing.length; offset += 128) {
    await runGit(ports, ['fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', '--no-filter',
      'origin', ...missing.slice(offset, offset + 128)], clone, signal)
  }
  if (missing.length) {
    await runGit(ports, ['rev-list', '--objects', '--no-object-names', '--missing=error', `${commit}^{tree}`],
      clone, signal)
  }
}

/** Resolve a fetched branch through a private ref instead of shared FETCH_HEAD. */
export async function fetchRepositoryBranch(ports: GitWorktreePorts, clone: string, repository: string,
  branch: string, signal: AbortSignal, options?: { recoveryRef: string }): Promise<string> {
  const ref = options?.recoveryRef ?? `refs/foreman/ci/fetch/${randomUUID()}`
  if (options) {
    if (!/^refs\/foreman\/imports\/[a-f0-9-]{36}$/u.test(ref)) {
      throw new DomainError('SOURCE_GIT_REF_INVALID', 'The import recovery reference is invalid.', 400)
    }
    const recovered = await ports.git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: clone, signal })
    if (recovered.code === 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(recovered.stdout.trim())) {
      return recovered.stdout.trim()
    }
    if (recovered.code !== 1) {
      throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE', 'The import commit reference cannot be recovered.', 409)
    }
  }
  let commit: string
  let cleanupFailed: boolean
  try {
    const fetched = await ports.git(['fetch', '--no-tags', '--no-write-fetch-head', '--recurse-submodules=no', 'origin',
      `refs/heads/${branch}:${ref}`], { cwd: clone, signal })
    if (fetched.code !== 0) {
      const branchRead = await ports.git(['ls-remote', '--exit-code', '--heads', 'origin', `refs/heads/${branch}`],
        { cwd: clone, signal })
      if (branchRead.code === 2) {
        throw new DomainError('SOURCE_REPOSITORY_BRANCH_NOT_FOUND',
          `The repository branch '${branch}' does not exist. Choose another branch.`, 409,
          { retryable: false, newCommandRequired: true })
      }
    }
    const head = fetched.code === 0
      ? await ports.git(['rev-parse', '--verify', `${ref}^{commit}`], { cwd: clone, signal }) : fetched
    if (head.code !== 0) {
      throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE',
        `Main could not fetch ${repository}@${branch}. Sign GitHub in on Main.`, 409)
    }
    commit = head.stdout.trim()
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
      throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE', 'The repository returned an invalid commit.', 409)
    }
  } finally {
    cleanupFailed = false
    if (!options) {
      const removed = await ports.git(['update-ref', '-d', ref], { cwd: clone, signal })
      cleanupFailed = removed.code !== 0
    }
  }
  if (cleanupFailed) {
    throw new DomainError('SOURCE_REPOSITORY_UNAVAILABLE', 'Main could not remove its temporary fetch ref.', 409)
  }
  return commit
}

export async function ensureClone(ports: GitWorktreePorts, repository: string, signal: AbortSignal): Promise<string> {
  assertWorktreeRequest({ repository, branch: 'foreman/source' })
  const clone = ports.cloneDirectory(repository)
  const present = await lstat(clone).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  const exists = present && await ports.git(['rev-parse', '--git-dir'], { cwd: clone, signal }).then(result => {
    if (result.code !== 0) throw gitFailure('SOURCE_WORKTREE_FAILED', 'rev-parse')
    return true
  })
  if (exists) return clone
  await mkdir(join(clone, '..'), { recursive: true, mode: 0o700 })
  const staging = `${clone}-${randomUUID()}`
  try {
    await runGit(ports, ['clone', '--no-checkout', '--template=', '--no-recurse-submodules',
      `https://github.com/${repository}.git`, staging], undefined, signal)
    try {
      await rename(staging, clone)
    } catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      await runGit(ports, ['rev-parse', '--git-dir'], clone, signal)
    }
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
  return clone
}
async function runGit(ports: GitWorktreePorts, args: string[], cwd: string | undefined, signal: AbortSignal) {
  const result = await ports.git(args, { ...(cwd ? { cwd } : {}), signal })
  signal.throwIfAborted()
  if (result.code !== 0 && (args[0] === 'clone' || args[0] === 'fetch')) {
    throw gitAcquisitionFailure(args[0], result.stderr)
  }
  if (result.code !== 0) throw gitFailure('SOURCE_WORKTREE_FAILED', args[0])
  return result.stdout
}

export function systemGitWorktreePorts(environment: NodeJS.ProcessEnv = process.env): GitWorktreePorts {
  const home = environment.HOME ?? homedir()
  const gitEnvironment = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')))
  return {
    cloneDirectory: repository => join(home, '.local', 'share', 'foreman-code', 'git', ...repository.split('/')),
    // GitHub CLI credentials supply authentication within the same bounded cache contract on every host.
    git: (args, options) => runGitWithCacheStorage(join(home, '.local', 'share', 'foreman-code', 'git'),
      args, options, (command, execution) => runGitProcess(command, execution, gitEnvironment)),
  }
}
