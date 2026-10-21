import { pathExists } from '../../shared/pathExists.js'
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import type { SourceManifest } from '@foreman-code/contracts/source-materialization'
import { captureGitSource, qualifiedGit } from '../sources/capture.js'
import { ensureClone, fetchMissingSourceObjects, fetchRepositoryBranch, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { SOURCE_LIMITS, verifySourceBytes, verifySourceManifest } from '../sources/manifest.js'
import { anchored, entryParent, identity, openChildDirectory, openPrivateRoot } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'
import { renameDirectory } from './renameDirectory.js'

type FilesystemIdentity = WorkspaceRootPolicy['filesystem']

export interface RepositoryPreparation {
  importId: string
  basePath: string
  baseIdentity: FilesystemIdentity
  directoryName: string
  containerIdentity?: FilesystemIdentity | undefined
  cloneIdentity?: FilesystemIdentity | undefined
  commit?: string | undefined
  manifest?: SourceManifest | undefined
}

function sameIdentity(left: FilesystemIdentity, right: FilesystemIdentity): boolean {
  return left.device === right.device && left.inode === right.inode && left.mountId === right.mountId
}


export function repositoryProjectPath(preparation: RepositoryPreparation): string {
  return join(preparation.basePath, preparation.directoryName, 'project')
}

/** Only the import's private reservation can supply a prepared repository. */
export class OwnedRepositoryPreparation {
  constructor(private readonly git: GitWorktreePorts) {}

  private async container(preparation: RepositoryPreparation,
    save: (value: RepositoryPreparation) => Promise<void>) {
    const base = await openPrivateRoot(preparation.basePath)
    try {
      if (!sameIdentity(await identity(base), preparation.baseIdentity)) {
        throw new DomainError('REPOSITORY_DIRECTORY_CHANGED', 'The approved Workspaces directory changed.', 409)
      }
      if (!preparation.containerIdentity) {
        // An unrecorded existing reservation has unknown ownership; preserve it for reconciliation.
        await mkdir(anchored(base, preparation.directoryName), { mode: 0o700 })
        const created = await openChildDirectory(base, preparation.directoryName)
        try {
          preparation.containerIdentity = await identity(created)
          await created.sync()
          await base.sync()
          await save(preparation)
        } finally {
          await created.close()
        }
      }
      const container = await openChildDirectory(base, preparation.directoryName)
      if (!sameIdentity(await identity(container), preparation.containerIdentity!)) {
        await container.close()
        throw new DomainError('REPOSITORY_DIRECTORY_CHANGED', 'The import directory changed. Start a new import.', 409)
      }
      return container
    } finally {
      await base.close()
    }
  }

  private async verifyOrigin(clone: string, repository: string): Promise<void> {
    let origin: string
    try {
      origin = (await qualifiedGit(clone, ['config', '--local', '--get-all', 'remote.origin.url'])).toString().trim()
    } catch (error) {
      if ((error as { code?: unknown }).code !== 1) throw error
      throw new DomainError('REPOSITORY_ORIGIN_CHANGED', 'The import clone no longer has its GitHub origin.', 409, undefined, { cause: error })
    }
    const root = (await qualifiedGit(clone, ['rev-parse', '--show-toplevel'])).toString().trim()
    if (origin !== `https://github.com/${repository}.git` || root !== clone) {
      throw new DomainError('REPOSITORY_ORIGIN_CHANGED', 'The import clone no longer belongs to this GitHub repository.', 409)
    }
  }

  async prepare(preparation: RepositoryPreparation, repository: string, branch: string,
    save: (value: RepositoryPreparation) => Promise<void>): Promise<void> {
    const container = await this.container(preparation, save)
    const signal = AbortSignal.timeout(SOURCE_LIMITS.preparationMs)
    const clone = join(preparation.basePath, preparation.directoryName, 'staging')
    try {
      if (await pathExists(repositoryProjectPath(preparation))) {
        await this.verifyPublished(preparation, repository)
        return
      }
      const ports: GitWorktreePorts = {
        cloneDirectory: () => clone,
        git: (args, options) => this.git.git(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], options),
      }
      if (await pathExists(clone)) {
        const existing = await openPrivateRoot(clone)
        try {
          if (preparation.cloneIdentity && !sameIdentity(await identity(existing), preparation.cloneIdentity)) {
            throw new DomainError('REPOSITORY_DIRECTORY_CHANGED', 'The import clone directory changed.', 409)
          }
          await this.verifyOrigin(clone, repository)
        } finally {
          await existing.close()
        }
      } else await ensureClone(ports, repository, signal)
      const directory = await openPrivateRoot(clone)
      try {
        const current = await identity(directory)
        if (preparation.cloneIdentity && !sameIdentity(current, preparation.cloneIdentity)) {
          throw new DomainError('REPOSITORY_DIRECTORY_CHANGED', 'The import clone directory changed.', 409)
        }
        await this.verifyOrigin(clone, repository)
        preparation.cloneIdentity = current
        await save(preparation)
        if (!preparation.commit) {
          preparation.commit = await fetchRepositoryBranch(ports, clone, repository, branch, signal,
            { recoveryRef: `refs/foreman/imports/${preparation.importId}` })
          await save(preparation)
        }
        await fetchMissingSourceObjects(ports, clone, preparation.commit, signal)
        preparation.manifest = await this.populate(directory, clone, preparation, repository)
        await save(preparation)
        await qualifiedGit(clone, ['read-tree', preparation.commit], 2 * 1024 * 1024, signal)
        await qualifiedGit(clone, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`], 2 * 1024 * 1024, signal)
        await qualifiedGit(clone, ['update-ref', `refs/heads/${branch}`, preparation.commit], 2 * 1024 * 1024, signal)
        await directory.sync()
      } finally {
        await directory.close()
      }
      const parent = `/proc/${process.pid}/fd/${container.fd}`
      signal.throwIfAborted()
      if (!await renameDirectory(`${parent}/staging`, `${parent}/project`)) {
        throw new DomainError('REPOSITORY_PUBLICATION_CONFLICT', 'The project destination already exists.', 409)
      }
      await container.sync()
      await this.verifyPublished(preparation, repository)
    } finally {
      await container.close()
    }
  }

  private async populate(directory: Awaited<ReturnType<typeof openPrivateRoot>>, clone: string,
    preparation: RepositoryPreparation, repository: string): Promise<SourceManifest> {
    const manifest = await captureGitSource({ root: clone, approvedSourceId: preparation.importId,
      snapshotId: preparation.importId, commit: preparation.commit!, repository,
      executablePolicy: 'preserve-approved', sink: {
        write: async (_snapshotId, entry, bytes) => {
          const { parent, leaf } = await entryParent(directory, entry.path, true)
          try {
            if (await pathExists(anchored(parent, leaf))) {
              const file = await open(anchored(parent, leaf), constants.O_RDONLY | constants.O_NOFOLLOW)
              try {
                verifySourceBytes(entry, await file.readFile())
                await file.chmod(entry.executable ? 0o700 : 0o600)
                await file.sync()
              } finally {
                await file.close()
              }
              return
            }
            const file = await open(anchored(parent, leaf),
              constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
            try {
              await file.writeFile(bytes)
              await file.chmod(entry.executable ? 0o700 : 0o600)
              await file.sync()
            } finally {
              await file.close()
            }
            await parent.sync()
          } finally {
            await parent.close()
          }
        },
        // Capture includes Git-object metadata in its transfer-budget check.
        writeGitMetadata: async () => {},
        commit: async value => { verifySourceManifest(value) },
        // Partial raw blobs remain in this owned reservation for the same pinned retry.
        abort: async () => {},
      } })
    return verifySourceManifest(manifest)
  }

  async verifyPublished(preparation: RepositoryPreparation, repository: string): Promise<void> {
    if (!preparation.containerIdentity || !preparation.cloneIdentity || !preparation.commit || !preparation.manifest) {
      throw new DomainError('REPOSITORY_PUBLICATION_UNCERTAIN', 'The project publication needs reconciliation.', 409)
    }
    const path = repositoryProjectPath(preparation)
    const container = await this.container(preparation, async () => {
      throw new DomainError('REPOSITORY_PUBLICATION_UNCERTAIN', 'The project directory needs reconciliation.', 409)
    })
    const directory = await openPrivateRoot(path).catch(async (error: unknown) => {
      await container.close()
      throw error
    })
    try {
      if (!sameIdentity(await identity(directory), preparation.cloneIdentity)) {
        throw new DomainError('REPOSITORY_DIRECTORY_CHANGED', 'The published project directory changed.', 409)
      }
      await this.verifyOrigin(path, repository)
      const commit = (await qualifiedGit(path, ['rev-parse', '--verify', 'HEAD^{commit}'])).toString().trim()
      if (commit !== preparation.commit) {
        throw new DomainError('REPOSITORY_COMMIT_CHANGED', 'The prepared project commit changed.', 409)
      }
    } finally {
      await directory.close()
      await container.close()
    }
  }
}
