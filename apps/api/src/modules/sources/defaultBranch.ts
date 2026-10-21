import type { GitWorktreePorts } from './gitWorktree.js'
import { DomainError } from '../errors.js'

export async function runWorkspaceGit(ports: GitWorktreePorts, args: string[], cwd: string, signal: AbortSignal): Promise<string> {
  const result = await ports.git(args, { cwd, signal })
  if (result.code !== 0) throw new DomainError('RUN_WORKTREE_UNAVAILABLE', `Git ${args[0]} failed for the Run worktree.`, 409)
  return result.stdout.trim()
}

export async function latestDefaultCommit(ports: GitWorktreePorts, root: string, signal: AbortSignal): Promise<string> {
  const remote = await ports.git(['remote', 'get-url', 'origin'], { cwd: root, signal })
  if (remote.code === 0) {
    const advertised = await runWorkspaceGit(ports, ['ls-remote', '--symref', 'origin', 'HEAD'], root, signal)
    const branch = advertised.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD$/mu)?.[1]
    if (!branch) throw new DomainError('RUN_DEFAULT_BRANCH_UNAVAILABLE', 'Origin did not advertise its default branch.', 409)
    await runWorkspaceGit(ports, ['fetch', '--no-tags', '--no-write-fetch-head', 'origin',
      `+${branch}:refs/remotes/origin/${branch.slice('refs/heads/'.length)}`], root, signal)
    return runWorkspaceGit(ports, ['rev-parse', '--verify', `refs/remotes/origin/${branch.slice('refs/heads/'.length)}^{commit}`], root, signal)
  }
  const remotes = await runWorkspaceGit(ports, ['remote'], root, signal)
  if (remotes) throw new DomainError('RUN_DEFAULT_BRANCH_UNAVAILABLE', 'The repository requires an origin remote to resolve its default branch.', 409)
  const configured = await ports.git(['config', '--get', 'init.defaultBranch'], { cwd: root, signal })
  const candidates = [...new Set([configured.stdout.trim(), 'main', 'master'].filter(Boolean))]
  for (const branch of candidates) {
    const found = await ports.git(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`], { cwd: root, signal })
    if (found.code === 0) return found.stdout.trim()
  }
  throw new DomainError('RUN_DEFAULT_BRANCH_UNAVAILABLE', 'The local repository requires a default branch (main or master).', 409)
}
