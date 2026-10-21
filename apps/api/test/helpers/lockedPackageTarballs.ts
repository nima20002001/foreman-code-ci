import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

export interface PackagingLockfile {
  importers: Record<string, { dependencies: Record<string, { version: string }> }>
  packages: Record<string, { resolution: { integrity: string } }>
  snapshots: Record<string, {
    dependencies?: Record<string, string>
    optionalDependencies?: Record<string, string>
  }>
}

const execute = promisify(execFile)

async function packInstalledPackage(source: string, archive: string, patch: string | undefined): Promise<string> {
  let packageDirectory = source
  const staging = `${archive}.unpacked`
  try {
    if (patch) {
      packageDirectory = join(staging, 'package')
      await cp(source, packageDirectory, {
        recursive: true, filter: path => path !== join(source, 'node_modules'),
      })
      // Deployment applies workspace patches, so the registry must serve the unpatched package.
      await execute('git', ['apply', '--reverse', patch], { cwd: packageDirectory })
    }
    // Hardlinked installs share inodes between identical files; pnpm extracts tar hardlink entries as empty files.
    await execute('tar', ['-cf', archive, '-I', 'gzip -1', '--hard-dereference', '--sort=name', '--mtime=@0',
      '--owner=0', '--group=0',
      '--numeric-owner', '--exclude=node_modules', '-C', dirname(packageDirectory), basename(packageDirectory)])
    return `sha512-${createHash('sha512').update(await readFile(archive)).digest('base64')}`
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

/** Repack installed runtime dependencies; a fixture registry cannot rely on a warm pnpm store. */
export async function lockedPackageTarballs(options: {
  lockfile: PackagingLockfile
  repository: string
  directory: string
  patches: Record<string, string>
}): Promise<Map<string, string>> {
  const { lockfile, repository, directory, patches } = options
  await mkdir(directory, { recursive: true })
  const pending = ['apps/api', 'packages/contracts'].flatMap(importer =>
    Object.entries(lockfile.importers[importer]!.dependencies).map(([name, { version }]) =>
      ({ name, version, optional: false, modules: join(repository, importer, 'node_modules') })))
  const visited = new Set<string>()
  const tarballs = new Map<string, string>()
  while (pending.length) {
    const { name, version, optional, modules } = pending.pop()!
    if (version.startsWith('link:')) continue
    // Aliased dependencies reference the real package name as well as its version.
    const reference = version.split('(')[0]!
    const snapshotKey = reference.includes('@') ? version : `${name}@${version}`
    if (visited.has(snapshotKey)) continue
    const key = snapshotKey.split('(')[0]!
    const packageName = key.slice(0, key.lastIndexOf('@'))
    let source: string
    try {
      source = await realpath(join(modules, name))
    } catch (error) {
      // pnpm does not install optional packages for other operating systems or architectures.
      if (optional && (error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw new Error(`Runtime fixture package is not installed: ${key}`, { cause: error })
    }
    visited.add(snapshotKey)
    if (!tarballs.has(key)) {
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as {
        name: string; version: string
      }
      if (`${manifest.name}@${manifest.version}` !== key) {
        throw new Error(`Installed runtime fixture package does not match the lockfile: ${key}`)
      }
      const archive = join(directory, `${key.replace('/', '+')}.tgz`)
      const integrity = await packInstalledPackage(source, archive, patches[key])
      // Repacking changes the archive bytes; retain checksum verification against the fixture's own tarball.
      lockfile.packages[key]!.resolution.integrity = integrity
      tarballs.set(key, archive)
    }
    const snapshot = lockfile.snapshots[snapshotKey]
    if (!snapshot) throw new Error(`Runtime fixture package has no locked dependencies: ${snapshotKey}`)
    const dependencyModules = packageName.startsWith('@') ? dirname(dirname(source)) : dirname(source)
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      pending.push({ name, version, optional: false, modules: dependencyModules })
    }
    for (const [name, version] of Object.entries(snapshot.optionalDependencies ?? {})) {
      pending.push({ name, version, optional: true, modules: dependencyModules })
    }
  }
  return tarballs
}
