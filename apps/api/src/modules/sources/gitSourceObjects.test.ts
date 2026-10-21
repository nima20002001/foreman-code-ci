import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { captureGitSource } from './capture.js'
import { importGitSourceObjects } from './gitSourceObjects.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { PrivateSourceSnapshotStore } from './store.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd, input, encoding: 'utf8', env: gitFixtureEnvironment(), maxBuffer: 8 * 1024 * 1024,
  }).trim()
}

async function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1', count = 2) {
  const root = await mkdtemp(join(tmpdir(), 'git-source-import-'))
  roots.push(root)
  const source = join(root, 'source')
  const destination = join(root, 'destination')
  const snapshots = join(root, 'snapshots')
  for (const directory of [source, destination, snapshots]) await mkdir(directory, { mode: 0o700 })
  git(source, ['init', '-q', `--object-format=${objectFormat}`])
  git(destination, ['init', '-q', '--bare', `--object-format=${objectFormat}`])
  await writeFile(join(source, 'ancestor.txt'), 'unapproved ancestor content\n')
  git(source, ['add', '.'])
  git(source, ['commit', '-qm', 'ancestor'])
  const ancestor = git(source, ['rev-parse', 'HEAD'])
  const ancestorBlob = git(source, ['rev-parse', 'HEAD:ancestor.txt'])
  await rm(join(source, 'ancestor.txt'))
  const paths: string[] = []
  for (let index = 0; index < count; index++) {
    const directory = `package-${index % 16}-${'segment-'.repeat(18)}/nested-${'segment-'.repeat(18)}`
    await mkdir(join(source, directory), { recursive: true })
    const path = `${directory}/source ${index}-${'é'.repeat(60)}-"quoted".txt`
    paths.push(path)
    await writeFile(join(source, path), `approved content ${index}\n`)
  }
  git(source, ['add', '-A'])
  git(source, ['commit', '-qm', 'approved'])
  const commit = git(source, ['rev-parse', 'HEAD'])
  const store = new PrivateSourceSnapshotStore(snapshots)
  const manifest = await captureGitSource({ root: source, commit, repository: 'fixture/project',
    approvedSourceId: randomUUID(), executablePolicy: 'strip', sink: store })
  const signal = AbortSignal.timeout(120_000)
  const system = systemGitWorktreePorts(gitFixtureEnvironment())
  const ports: GitWorktreePorts = { cloneDirectory: () => destination, git: system.git }
  const input = { ports, repository: 'fixture/project', manifest,
    metadata: await store.readGitMetadata(manifest, signal), signal,
    blobPath: async (path: string) => join(source, path) }
  return { input, source, destination, commit, ancestor, ancestorBlob }
}

it.each(['sha1', 'sha256'] as const)(
  'imports a large %s approved tree within a bounded Git process budget and excludes history',
  async objectFormat => {
    const f = await fixture(objectFormat, 3200)
    let commands = 0
    const ports: GitWorktreePorts = { ...f.input.ports, git: async (args, options) => {
      // Model a worker's finite launch budget without timing-sensitive assertions.
      if (++commands > 100 || args.reduce((bytes, arg) => bytes + Buffer.byteLength(arg) + 1, 0) > 36 * 1024) {
        return { code: 1, stdout: '', stderr: 'fatal: resource temporarily unavailable' }
      }
      return f.input.ports.git(args, options)
    } }
    expect(await importGitSourceObjects({ ...f.input, ports })).toBe(f.destination)
    expect(git(f.destination, ['rev-parse', `refs/foreman/sources/${f.input.manifest.snapshotId}`])).toBe(f.commit)
    const approvedObjects = git(f.source, ['rev-list', '--objects', '--no-object-names', `${f.commit}^{tree}`])
    const importedObjects = git(f.destination, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname)'])
    expect(new Set(importedObjects.split('\n'))).toEqual(new Set([f.commit, ...approvedObjects.split('\n')]))
    const requests = `${approvedObjects}\n${f.commit}\n`
    expect(git(f.destination, ['cat-file', '--batch'], requests)).toBe(git(f.source, ['cat-file', '--batch'], requests))
    for (const object of [f.ancestor, f.ancestorBlob]) {
      expect((await f.input.ports.git(['cat-file', '-e', object],
        { cwd: f.destination, signal: f.input.signal })).code).not.toBe(0)
    }
  }, 120_000,
)

it('reports the failing subcommand with bounded diagnostics and redacts arbitrary stderr tokens', async () => {
  const f = await fixture()
  const stderr = `\u001b[31mfatal: unable to open ${f.source}: Permission denied\u001b[0m\n`
    + `password=synthetic-secret synthetic-identity ${'untrusted-output '.repeat(200)}`
  const ports: GitWorktreePorts = { ...f.input.ports, git: async (args, options) => args.includes('hash-object')
    ? { code: 128, stdout: '', stderr } : f.input.ports.git(args, options) }
  const failure = await importGitSourceObjects({ ...f.input, ports }).catch((error: unknown) => error)
  expect(failure).toMatchObject({
    code: 'SOURCE_GIT_OBJECT_UNAVAILABLE',
    message: expect.stringMatching(/^git hash-object failed \(exit 128\).*fatal: unable to open \[redacted\]: Permission denied/),
  })
  const message = (failure as Error).message
  expect(message.length).toBeLessThan(650)
  for (const secret of [f.source, 'synthetic-secret', 'synthetic-identity', 'untrusted-output', '\u001b']) {
    expect(message).not.toContain(secret)
  }
})

it('joins concurrent snapshot imports, validates each metadata pin and isolates caller cancellation', async () => {
  const f = await fixture()
  let release!: () => void
  let entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  const controller = new AbortController()
  const reason = new Error('Caller canceled')
  const first = importGitSourceObjects({ ...f.input, signal: controller.signal,
    blobPath: async path => { entered(); await gate; return f.input.blobPath(path) } })
  const observed = first.catch((error: unknown) => error)
  await started
  const second = importGitSourceObjects({ ...f.input,
    blobPath: async () => { throw new Error('The joined import must use the original verified carrier') } })
  const invalid = importGitSourceObjects({ ...f.input, metadata: Buffer.from('changed metadata') })
  await expect(invalid).rejects.toMatchObject({ code: 'SOURCE_BYTES_INVALID' })
  controller.abort(reason)
  release()
  expect(await observed).toBe(reason)
  expect(await second).toBe(f.destination)
  expect(git(f.destination, ['rev-parse', `refs/foreman/sources/${f.input.manifest.snapshotId}`])).toBe(f.commit)
  const objects = git(f.source, ['rev-list', '--objects', '--no-object-names', `${f.commit}^{tree}`])
  expect(git(f.destination, ['cat-file', '--batch'], `${objects}\n${f.commit}\n`))
    .toBe(git(f.source, ['cat-file', '--batch'], `${objects}\n${f.commit}\n`))
})

it('rejects a destination object format mismatch before publishing the approved ref', async () => {
  const f = await fixture('sha256')
  await rm(f.destination, { recursive: true })
  await mkdir(f.destination, { mode: 0o700 })
  git(f.destination, ['init', '-q', '--bare', '--object-format=sha1'])
  await expect(importGitSourceObjects(f.input)).rejects.toMatchObject({ code: 'SOURCE_GIT_OBJECT_CORRUPT' })
  expect(git(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('')
})

it('rejects missing approved blobs without publishing the source ref', async () => {
  const f = await fixture()
  const replacement = join(f.source, 'replacement.txt')
  await writeFile(replacement, 'different bytes\n')
  await expect(importGitSourceObjects({ ...f.input, blobPath: async () => replacement })).rejects.toMatchObject({
    code: 'SOURCE_GIT_OBJECT_UNAVAILABLE', message: expect.stringContaining('git rev-list failed'),
  })
  expect(git(f.destination, ['for-each-ref', '--format=%(refname)'])).toBe('')
})
