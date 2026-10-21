import { lstat, realpath } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, type CodexHarnessConfiguration } from '@foreman-code/contracts'
import { systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { DomainError } from '../errors.js'

/** Worktree commits write their index and the repository object/ref store, outside cwd. */
export async function worktreeSecurity(configuration: CodexHarnessConfiguration, cwd: string,
  signal: AbortSignal, ports: GitWorktreePorts = systemGitWorktreePorts()): Promise<CodexHarnessConfiguration> {
  if (configuration.sandbox !== 'workspace-write') return configuration
  let repository = cwd
  for (;;) {
    try {
      if (!(await lstat(join(repository, '.git'))).isFile()) return configuration
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(repository)
      if (parent === repository) return configuration
      repository = parent
    }
  }
  const directories = []
  for (const option of ['--git-common-dir', '--git-dir']) {
    const result = await ports.git(['rev-parse', '--path-format=absolute', option], { cwd, signal })
    if (result.code !== 0) throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The worktree Git metadata could not be resolved.', 409)
    directories.push(await realpath(result.stdout.trim()))
  }
  const [common, worktree] = directories
  if (!common || !worktree) throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The Git metadata paths are missing.', 409)
  const suffix = relative(join(common, 'worktrees'), worktree)
  if (!suffix || isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The Git metadata is not a linked worktree.', 409)
  }
  const advanced = configuration.advanced ?? DEFAULT_CODEX_ADVANCED_CONFIGURATION
  return { ...configuration, advanced: { ...advanced,
    additionalWritableDirectories: [...new Set([...advanced.additionalWritableDirectories, ...directories])],
  } }
}
