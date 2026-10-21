import { ensureClone, ensureCommit, fetchRepositoryBranch, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { importAgentSnapshot } from '../sources/agentSnapshot.js'
import { publishCommit } from '../sources/githubPublisher.js'
import type { CiCommits } from './service.js'
import { ciRepositoryCapabilities } from './repository.js'
import { onlyCiInfrastructure } from './priority.js'
import { gitFailure } from '../sources/gitErrors.js'
import type { CiTestTree } from './resultCache.js'

/** Main's clone of the workspace repository: the requested commit, an Agent's files as a commit on its base, or the
 * default branch head; whatever GitHub lacks is pushed so build computers can fetch it. */
export class GitCiCommits implements CiCommits {
  private readonly published = new Map<string, Promise<string>>()

  constructor(private readonly git: GitWorktreePorts = systemGitWorktreePorts()) {}

  async infrastructureOnly(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const diff = await this.git.git(['diff-tree', '--root', '--no-commit-id', '--name-only',
      '--no-renames', '--first-parent', '-r', '-m', '-z', commit], { cwd: clone, signal })
    if (diff.code !== 0) throw new Error('Could not read the CI commit changes.')
    return onlyCiInfrastructure(diff.stdout.split('\0').filter(Boolean))
  }

  async branch(repository: string, defaultBranch: string, commit: string): Promise<string | null> {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const result = await this.git.git(['for-each-ref', '--contains', commit, '--format=%(refname)',
      'refs/remotes/origin/'], { cwd: clone, signal })
    if (result.code !== 0) throw gitFailure('SOURCE_WORKTREE_FAILED', 'for-each-ref')
    const branches = result.stdout.trim().split('\n')
      .filter(ref => ref.startsWith('refs/remotes/origin/'))
      .map(ref => ref.slice('refs/remotes/origin/'.length))
      .filter(branch => branch !== 'HEAD' && !branch.startsWith('foreman/ci/'))
    if (branches.includes(defaultBranch)) return defaultBranch
    return branches.length === 1 ? branches[0]! : null
  }

  async isAncestor(repository: string, ancestor: string, commit: string): Promise<boolean> {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    await ensureCommit(this.git, repository, ancestor, signal)
    const result = await this.git.git(['merge-base', '--is-ancestor', ancestor, commit], { cwd: clone, signal })
    if (result.code === 0) return true
    if (result.code === 1) return false
    throw gitFailure('SOURCE_WORKTREE_FAILED', 'merge-base')
  }

  async coverageAncestors(repository: string, commit: string, candidates: string[]): Promise<string[]> {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    // Date order keeps descendants ahead of parents, then orders independent branches by commit time.
    const result = await this.git.git(['rev-list', '--date-order', commit], { cwd: clone, signal })
    if (result.code !== 0) throw gitFailure('SOURCE_WORKTREE_FAILED', 'rev-list')
    const retained = new Set(candidates)
    return result.stdout.trim().split('\n').filter(ancestor => retained.has(ancestor))
  }

  async capabilities(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '--name-only', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI repository capabilities.')
    return ciRepositoryCapabilities(tree.stdout.trim().split('\n'))
  }

  async unitInventory(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const read = (args: string[]) => this.git.git(args, { cwd: clone, signal })
    const [tree, heavy] = await Promise.all([
      read(['ls-tree', '-r', '--name-only', commit]),
      read(['show', `${commit}:apps/web/heavy-tests.json`]),
    ])
    if (tree.code !== 0) throw new Error('Could not read the CI commit inventory.')
    const files = tree.stdout.trim().split('\n').filter(file => /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)
      && !/(?:^|\/)(?:node_modules|dist|\.git)\//.test(file)
      && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
      && (!file.startsWith('apps/web/') || /^apps\/web\/src\/.*\.(?:test|spec)\.tsx?$/.test(file)))
    return { files, durations: {},
      heavy: heavy.code === 0 ? (JSON.parse(heavy.stdout) as { files: string[] }).files : [] }
  }

  async integrationInventory(repository: string, commit: string) {
    const signal = AbortSignal.timeout(30_000)
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '--name-only', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI integration inventory.')
    return { files: tree.stdout.trim().split('\n').filter(file =>
      /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/.test(file)).sort(),
    durations: {} }
  }

  async testTree(repository: string, commit: string, signal = AbortSignal.timeout(30_000)): Promise<CiTestTree> {
    const clone = await ensureCommit(this.git, repository, commit, signal)
    const tree = await this.git.git(['ls-tree', '-r', '-z', commit], { cwd: clone, signal })
    if (tree.code !== 0) throw new Error('Could not read the CI commit tree.')
    const blobs = new Map<string, string>()
    for (const entry of tree.stdout.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t')
      const [mode, type, id] = entry.slice(0, tab).split(' ')
      // Submodules have no blob; a test reaching one has no key.
      if (type === 'blob') blobs.set(entry.slice(tab + 1), `${mode}:${id}`)
    }
    return { blobs, read: async (path, readSignal) => {
      const id = blobs.get(path)?.split(':')[1]
      if (!id) throw new Error(`The CI commit has no file ${path}.`)
      const blob = await this.git.git(['cat-file', 'blob', id], { cwd: clone,
        signal: AbortSignal.any([readSignal, AbortSignal.timeout(30_000)]) })
      if (blob.code !== 0) throw new Error(`Could not read ${path} from the CI commit.`)
      return blob.stdout
    } }
  }

  async resolve(repository: string, defaultBranch: string, commit: string | undefined,
    snapshot: { baseCommit: string; commit: string; bundle: Buffer | null } | null): Promise<string> {
    const knownCommit = commit ?? snapshot?.commit
    if (knownCommit) {
      return this.publish(repository, knownCommit, async signal => {
        if (!commit && snapshot) {
          const clone = await ensureCommit(this.git, repository, snapshot.baseCommit, signal)
          if (snapshot.bundle) {
            await importAgentSnapshot(this.git, clone, { commit: snapshot.commit, bundle: snapshot.bundle }, signal)
          }
        }
      })
    }
    const signal = AbortSignal.timeout(180_000)
    const clone = await ensureClone(this.git, repository, signal)
    const resolved = await fetchRepositoryBranch(this.git, clone, repository, defaultBranch, signal)
    return this.publish(repository, resolved)
  }

  private publish(repository: string, commit: string,
    prepare?: (signal: AbortSignal) => Promise<void>): Promise<string> {
    const key = `${repository}:${commit}`
    const cached = this.published.get(key)
    if (cached) return cached
    const publication: Promise<string> = (async () => {
      const signal = AbortSignal.timeout(180_000)
      await prepare?.(signal)
      await publishCommit(this.git, repository, commit, signal)
      return commit
    })().catch(error => {
      if (this.published.get(key) === publication) this.published.delete(key)
      throw error
    })
    this.published.set(key, publication)
    if (this.published.size > 256) this.published.delete(this.published.keys().next().value!)
    return publication
  }
}
