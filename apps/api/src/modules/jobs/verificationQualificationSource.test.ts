import { privateFixtureDirectory } from '../../../test/helpers/privateFixtureDirectory.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createSourceManifest, sourceSha256 } from '../sources/manifest.js'
import { prepareVerificationQualificationSource, restoreVerificationQualificationSource, resetVerificationQualificationWorkload, writeVerificationQualificationContext } from './verificationQualificationSource.js'

const roots: string[] = []
const run = promisify(execFile)
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(objectFormat: 'sha1' | 'sha256' = 'sha1') {
  const root = await privateFixtureDirectory('verification-snapshot-')
  roots.push(root)
  const directory = join(root, 'approved')
  const namespace = join(root, 'qualification')
  await mkdir(directory, { mode: 0o700 })
  await mkdir(namespace, { mode: 0o700 })
  await mkdir(join(directory, 'scripts'), { mode: 0o700 })
  const files = [
    { path: 'package.json', bytes: Buffer.from('{"name":"approved"}\n'), executable: false },
    { path: 'scripts/check', bytes: Buffer.from('#!/bin/sh\nexit 0\n'), executable: true },
  ]
  for (const file of files) await writeFile(join(directory, file.path), file.bytes,
    { mode: file.executable ? 0o700 : 0o600 })
  const manifest = createSourceManifest({ version: 1,
    approvedSourceId: '00000000-0000-4000-8000-000000000001',
    snapshotId: '00000000-0000-4000-8000-000000000002', capturePolicy: 'git-tree-v1',
    executablePolicy: 'preserve-approved', deletions: [],
    git: { commit: '2'.repeat(objectFormat === 'sha1' ? 40 : 64),
      tree: '3'.repeat(objectFormat === 'sha1' ? 40 : 64), objectFormat },
    entries: files.map(file => ({ path: file.path, kind: 'file', byteSize: file.bytes.length,
      sha256: sourceSha256(file.bytes), executable: file.executable })),
  })
  return { directory, namespace, manifest, signal: new AbortController().signal }
}

describe('approved verification snapshot and private Git preparation', () => {
  it('atomically replaces a previous read-only context and refuses a substituted symlink', async () => {
    const input = await fixture()
    const directory = join(input.namespace, 'inputs')
    await mkdir(directory, { mode: 0o700 })
    const path = join(directory, 'qualification-context.json')
    await writeVerificationQualificationContext(directory, '{"attempt":"install"}')
    const first = await stat(path)
    expect(first.mode & 0o777).toBe(0o444)
    await writeVerificationQualificationContext(directory, '{"attempt":"timed_out"}')
    expect(await readFile(path, 'utf8')).toBe('{"attempt":"timed_out"}')
    expect((await stat(path)).mode & 0o777).toBe(0o444)
    expect((await stat(path)).ino).not.toBe(first.ino)
    expect(await readdir(directory)).toEqual(['qualification-context.json'])
    await rm(path)
    await symlink(join(input.directory, 'package.json'), path)
    await expect(writeVerificationQualificationContext(directory, 'changed')).rejects.toThrow('private regular file')
    expect(await readFile(join(input.directory, 'package.json'), 'utf8')).toBe('{"name":"approved"}\n')
  })
  it('recreates a finalized cache before the next cold diagnostic and keeps only approved source', async () => {
    const input = await fixture()
    const source = await prepareVerificationQualificationSource(input)
    const scratch = join(input.namespace, 'job-scratch')
    await mkdir(scratch, { mode: 0o700 })
    await writeFile(join(scratch, 'cache'), 'closed workload cache')
    await rm(scratch, { recursive: true })
    await writeFile(join(source.sourceRoot, 'untracked-result'), 'previous diagnostic')
    const paths = input.manifest.entries.map(file => file.path)
    await resetVerificationQualificationWorkload(source.sourceRoot, scratch, paths)
    expect((await stat(scratch)).mode & 0o777).toBe(0o700)
    expect(await readdir(scratch)).toEqual([])
    expect(await readFile(join(source.sourceRoot, 'package.json'), 'utf8')).toBe('{"name":"approved"}\n')
    await expect(readFile(join(source.sourceRoot, 'untracked-result'))).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(join(scratch, 'new-cache'), 'another closed workload')
    await resetVerificationQualificationWorkload(source.sourceRoot, scratch, paths)
    expect(await readdir(scratch)).toEqual([])
    await rm(scratch, { recursive: true })
    await symlink(input.directory, scratch)
    await expect(resetVerificationQualificationWorkload(source.sourceRoot, scratch, paths)).rejects.toThrow()
    expect(await readFile(join(input.directory, 'package.json'), 'utf8')).toBe('{"name":"approved"}\n')
  })
  it.each(['sha1', 'sha256'] as const)('builds a readable clean %s Git view from only the complete approved bytes', async format => {
    const input = await fixture(format)
    const result = await prepareVerificationQualificationSource(input)
    const options = { cwd: result.sourceRoot, env: { PATH: process.env.PATH,
      GIT_DIR: result.gitDirectory, GIT_WORK_TREE: result.sourceRoot, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1' } }
    const head = (await run('git', ['rev-parse', 'HEAD'], options)).stdout.trim()
    expect(head).toBe(result.privateGit.generatedCommit)
    expect(result.privateGit.sourceCommit).toBe(input.manifest.git!.commit)
    expect((await run('git', ['status', '--porcelain'], options)).stdout).toBe('')
    expect((await run('git', ['show', 'HEAD:package.json'], options)).stdout).toBe('{"name":"approved"}\n')
    expect((await run('git', ['ls-tree', 'HEAD:scripts'], options)).stdout).toMatch(/^100755 blob .*\tcheck\n$/)
    expect(await readFile(join(result.sourceRoot, 'scripts/check'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
  })

  it('restores approved tracked bytes and modes before another cold-cache suite', async () => {
    const input = await fixture()
    const source = await prepareVerificationQualificationSource(input)
    await writeFile(join(source.sourceRoot, 'package.json'), '{"name":"changed"}')
    await rm(join(source.sourceRoot, 'scripts/check'))
    const restored = await restoreVerificationQualificationSource({ ...input, sourceRoot: source.sourceRoot })
    expect(await readFile(join(source.sourceRoot, 'package.json'), 'utf8')).toBe('{"name":"approved"}\n')
    expect(await readFile(join(source.sourceRoot, 'scripts/check'), 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    expect((await run(join(source.sourceRoot, 'scripts/check'))).stdout).toBe('')
    expect(Number(restored.filesystem.inode)).toBeGreaterThan(0)
    expect(Date.parse(restored.verifiedAt)).toBeLessThanOrEqual(Date.now())
  })

  it('rejects a symlink substituted for a tracked qualification file', async () => {
    const input = await fixture()
    const source = await prepareVerificationQualificationSource(input)
    await rm(join(source.sourceRoot, 'package.json'))
    await symlink(join(input.directory, 'package.json'), join(source.sourceRoot, 'package.json'))
    await expect(restoreVerificationQualificationSource({ ...input, sourceRoot: source.sourceRoot })).rejects.toThrow()
    expect(await readFile(join(input.directory, 'package.json'), 'utf8')).toBe('{"name":"approved"}\n')
  })

  it.each(['changed', 'extra', 'symlink'] as const)('rejects a %s protected snapshot before treating it as qualification input', async fault => {
    const input = await fixture()
    if (fault === 'changed') await writeFile(join(input.directory, 'package.json'), '{}')
    if (fault === 'extra') await writeFile(join(input.directory, 'unapproved.json'), '{}')
    if (fault === 'symlink') {
      await rm(join(input.directory, 'package.json'))
      await symlink('/etc/hosts', join(input.directory, 'package.json'))
    }
    await expect(prepareVerificationQualificationSource(input)).rejects.toThrow()
  })
})
