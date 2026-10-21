import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { PostgresSourceService } from '../../src/modules/sources/service.js'
import { PrivateSourceSnapshotStore } from '../../src/modules/sources/store.js'
import { InstalledWorkspaceRootHosts } from '../../src/modules/sources/rootHosts.js'
import { PostgresWorkspaceRootPolicies } from '../../src/modules/sources/rootPolicies.js'
import { RegisteredWorkspaceSourceRoots } from '../../src/modules/sources/registeredSourceRoots.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { sourceSha256 } from '../../src/modules/sources/manifest.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from '../../src/modules/sources/gitWorktree.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import { registerWorkspaceRootRoutes } from '../../src/modules/workspace-roots/transports.js'
import { WorkspaceRepositoryService } from '../../src/modules/workspaces/repositoryService.js'
import { registerWorkspaceRepositoryRoutes } from '../../src/routes/workspaceRepository.js'
import { workspaceMcpFixture } from './workspaceMcp.js'
import { gitFixtureEnvironment } from './gitFixture.js'

export const fixtureRepository = { provider: 'github' as const, owner: 'octo', name: 'site', defaultBranch: 'main' }
export const fixtureGit = (cwd: string, ...args: string[]) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim()

/** Real management/source/root services and authenticated endpoints; only GitHub transport uses a local repository. */
export async function workspaceRepositoryFixture() {
  let sources!: PostgresSourceService
  let repositories!: WorkspaceRepositoryService
  let roots!: WorkspaceBoundLocationService
  let policies!: PostgresWorkspaceRootPolicies
  let allowlist!: ApprovedRootAllowlist
  let origin!: string
  let storage!: string
  let runtime!: string
  let commit!: string
  let recreate!: () => WorkspaceRepositoryService
  const gitCalls: string[][] = []
  const f = await workspaceMcpFixture({ configure: async ({ pool, commands, services, parentPath, app }) => {
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    storage = join(parentPath, 'projects')
    runtime = join(parentPath, 'runtime')
    origin = join(parentPath, 'origin')
    const sourceStore = join(parentPath, 'source-store')
    for (const path of [storage, runtime, origin, sourceStore]) await mkdir(path, { mode: 0o700 })
    fixtureGit(origin, 'init', '--template=', '-q', '-b', 'main')
    await writeFile(join(origin, 'content.txt'), 'approved raw bytes\n')
    await writeFile(join(origin, '.gitattributes'), '*.txt filter=unsafe\n')
    await writeFile(join(origin, 'run.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    fixtureGit(origin, 'add', '.')
    fixtureGit(origin, 'commit', '-qm', 'project')
    commit = fixtureGit(origin, 'rev-parse', 'HEAD')
    allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'main', mainId },
      applicationInstallationId: mainId, configurationRevision: '1',
      bases: [{ baseId: randomUUID(), canonicalPath: storage, accessModes: ['read-only', 'read-write'] }],
      managedRuntimeRoot: runtime })
    const unavailable = async (): Promise<never> => { throw new Error('Repository onboarding cannot invoke execution.') }
    const hosts = new InstalledWorkspaceRootHosts(allowlist, async (sql, _principal, host, installationId) => {
      const main = (await sql.query<{ id: string }>('select id from application_installation where singleton=true for share')).rows[0]
      if (host.kind !== 'main' || host.mainId !== main?.id || installationId !== main.id) {
        throw new Error('Repository import attempted another computer.')
      }
      return null
    }, { request: unavailable })
    policies = new PostgresWorkspaceRootPolicies(mainId, hosts)
    const sql = await pool.connect()
    try {
      await sql.query('begin')
      await policies.publishApprovedHostConfiguration(sql, allowlist, { mainId, hostRef: allowlist.hostRef,
        applicationInstallationId: mainId, configurationRevision: allowlist.configurationRevision,
        configurationDigest: sourceSha256(Buffer.from(JSON.stringify(allowlist))) })
      await sql.query('commit')
    } catch (error) {
      await sql.query('rollback')
      throw error
    } finally {
      sql.release()
    }
    services.locations.setRootPolicies(policies)
    roots = new WorkspaceBoundLocationService(pool, commands, policies)
    const sourceRoots = new RegisteredWorkspaceSourceRoots(policies, hosts)
    const system = systemGitWorktreePorts(gitFixtureEnvironment())
    const git: GitWorktreePorts = { cloneDirectory: () => join(parentPath, 'unused-cache'),
      git: async (args, options) => {
        gitCalls.push(args)
        const routed = ['-c', `url.${origin}.insteadOf=https://github.com/octo/site.git`, ...args]
        const result = await system.git(routed, options)
        if (args.includes('clone') && result.code === 0) {
          const clone = args.at(-1)!
          await system.git(['config', '--local', 'remote.origin.url', 'https://github.com/octo/site.git'],
            { cwd: clone, signal: options.signal })
          await system.git(['config', '--local', 'filter.unsafe.smudge', 'sh -c "exit 71"'],
            { cwd: clone, signal: options.signal })
        }
        return result
      },
    }
    const createSources = () => {
      const service = new PostgresSourceService(pool, commands, services.locations,
        new PrivateSourceSnapshotStore(sourceStore), mainId, sourceRoots,
        { authorize: unavailable, prepare: unavailable, verifyWorkingDirectory: unavailable,
          verify: unavailable, releaseClaim: unavailable, authorizeFinal: unavailable }, { confirmedClosed: unavailable })
      service.git = git
      return service
    }
    sources = createSources()
    repositories = new WorkspaceRepositoryService(pool, commands, services.workspaces, roots,
      policies, sources, mainId, storage)
    recreate = () => new WorkspaceRepositoryService(pool, commands, services.workspaces,
      new WorkspaceBoundLocationService(pool, commands, policies), policies, createSources(), mainId, storage)
    services.workspaceRoots = roots
    services.workspaceRepositories = repositories
    services.sources = sources
    registerWorkspaceRootRoutes(app, roots)
    registerWorkspaceRepositoryRoutes(app, repositories)
  } })
  return { ...f, sources, repositories, roots, policies, allowlist, origin, storage, runtime, commit, recreate, gitCalls }
}
