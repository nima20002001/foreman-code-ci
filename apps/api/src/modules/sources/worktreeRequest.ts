import type { MaterializationReceipt, SourceWorktreeRequest } from '@foreman-code/contracts/source-materialization'
import { assertWorktreeRequest, ensureWorktreeGitIdentity, systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { SourceError } from './manifest.js'
import { sourceWorkingTreePath } from './sourceTreePaths.js'

const branchSuffix = /-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u

export function generatedWorktreePrefix(workflowName: string, agentName: string): string {
  const slug = (value: string) => value.toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-+|-+$/gu, '').slice(0, 40) || 'agent'
  return `foreman/${slug(workflowName)}/${slug(agentName)}`
}

export function bindGeneratedWorktreeRun(prefix: string, runId: string): string {
  const run = runId.replace(/^run-/u, '').replace(/[^A-Za-z0-9]/gu, '').slice(0, 8)
  return `${prefix}-${run}`
}

export function assertWorktreeReceipt(receipt: MaterializationReceipt,
  request: SourceWorktreeRequest | undefined, baseCommit?: string): void {
  if (!request) {
    if (receipt.worktree) throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'An unrequested Agent worktree was returned.')
    return
  }
  assertWorktreeRequest(request)
  const actual = receipt.worktree
  const suffix = actual?.branch.match(branchSuffix)?.[0]
  const expectedPrefix = request.branch.slice(0, 'foreman/'.length + 200 - (suffix?.length ?? 0))
  if (!actual || !suffix || actual.repository !== request.repository
    || actual.branch !== `${expectedPrefix}${suffix}` || baseCommit && actual.commit !== baseCommit) {
    throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'The Agent worktree differs from its accepted repository, commit or branch prefix.')
  }
}

export async function verifyWorktreeBranch(receipt: MaterializationReceipt,
  options: { git?: GitWorktreePorts; signal?: AbortSignal | undefined } = {}): Promise<void> {
  if (!receipt.worktree) return
  const git = options.git ?? systemGitWorktreePorts()
  const signal = options.signal ?? AbortSignal.timeout(10_000)
  const result = await git.git(['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd: sourceWorkingTreePath(receipt), signal,
  })
  if (result.code !== 0 || result.stdout.trim() !== receipt.worktree.branch) {
    throw new SourceError('SOURCE_WORKTREE_CONFLICT', 'The retained Agent worktree is on another branch.')
  }
  await ensureWorktreeGitIdentity(git, sourceWorkingTreePath(receipt), signal)
}
