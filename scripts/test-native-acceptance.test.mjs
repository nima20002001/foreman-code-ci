import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { nativeAcceptanceCommand } from './test-native-acceptance.mjs'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { archiveNativeAcceptanceEvidence, nativeAcceptanceConfiguration, nativeAcceptanceEnvironment, nativeAcceptanceFiles,
  nativeAcceptanceVitestArguments } from './test-native-acceptance.mjs'
import { createTestRoot, removeTestRoot } from './test-resources.mjs'

test('native results survive disposable cleanup without exporting provider authentication', async () => {
  const invocation = createTestRoot()
  const archive = createTestRoot(dirname(invocation.directory))
  const evidence = join(invocation.directory, 'evidence')
  try {
    await mkdir(join(evidence, 'database'), { recursive: true, mode: 0o700 })
    await mkdir(join(invocation.directory, 'home'), { mode: 0o700 })
    await writeFile(join(invocation.directory, 'home', 'auth.json'), 'private provider authentication', { mode: 0o600 })
    await writeFile(join(evidence, 'codex-failed.json'), '{"terminal":null}', { mode: 0o600 })
    await writeFile(join(evidence, 'database', 'database.json'), '{"removed":true}', { mode: 0o600 })
    const retained = await archiveNativeAcceptanceEvidence(invocation, evidence, archive.directory)
    removeTestRoot(invocation)
    assert.equal(await readFile(join(retained, 'codex-failed.json'), 'utf8'), '{"terminal":null}')
    assert.equal(await readFile(join(retained, 'database', 'database.json'), 'utf8'), '{"removed":true}')
    assert.deepEqual((await readdir(retained)).sort(), ['codex-failed.json', 'database'])
    assert.equal((await stat(retained)).mode & 0o077, 0)
    assert.equal((await stat(join(retained, 'codex-failed.json'))).mode & 0o077, 0)
  } finally {
    try { if (existsSync(invocation.directory)) removeTestRoot(invocation) }
    finally { removeTestRoot(archive) }
  }
})

test('native evidence rejects symlinks and an archive inside the disposable root', async () => {
  const invocation = createTestRoot()
  const archive = createTestRoot(dirname(invocation.directory))
  const evidence = join(invocation.directory, 'evidence')
  try {
    await mkdir(evidence, { mode: 0o700 })
    const authentication = join(invocation.directory, 'auth.json')
    await writeFile(authentication, 'private provider authentication', { mode: 0o600 })
    await symlink(authentication, join(evidence, 'auth.json'))
    const previousArchiveEntries = await readdir(archive.directory)
    await assert.rejects(archiveNativeAcceptanceEvidence(invocation, evidence, archive.directory), /symlink/)
    assert.deepEqual(await readdir(archive.directory), previousArchiveEntries)
    await assert.rejects(archiveNativeAcceptanceEvidence(invocation, evidence,
      join(invocation.directory, 'archive')), /survive disposable root cleanup/)
    assert.equal(await readFile(authentication, 'utf8'), 'private provider authentication')
  } finally {
    try { removeTestRoot(invocation) }
    finally { removeTestRoot(archive) }
  }
})

test('native launchers retain the running Node interpreter when HOME is isolated', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-acceptance-runtime-'))
  const launcher = join(directory, 'launcher')
  try {
    await writeFile(join(directory, 'node'), '#!/bin/sh\nexit 81\n', { mode: 0o700 })
    const program = [
      '#!/usr/bin/env node',
      'console.log(JSON.stringify({runtime:process.execPath,home:process.env.HOME,',
      'credential:process.env.NATIVE_TEST_CREDENTIAL}))',
      '',
    ].join('\n')
    await writeFile(launcher, program, { mode: 0o700 })
    const source = { ...process.env, PATH: [directory, process.env.PATH].join(delimiter),
      HOME: directory, NATIVE_TEST_CREDENTIAL: 'fixture-credential' }
    const original = { ...source }
    const environment = nativeAcceptanceEnvironment(source)
    const output = execFileSync(launcher, { env: environment, encoding: 'utf8', timeout: 5_000 })
    assert.deepEqual(JSON.parse(output), {
      runtime: process.execPath, home: directory, credential: 'fixture-credential',
    })
    assert.deepEqual(source, original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('acceptance keeps its caller-selected database and evidence', () => {
  const environment = {
    TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/general_test',
    ENG03_A_TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/native_test',
    ENG03_A_EVIDENCE_DIR: '/tmp/retained-native-evidence',
  }
  const original = { ...environment }
  assert.deepEqual(nativeAcceptanceConfiguration(environment), {
    databaseUrl: environment.ENG03_A_TEST_DATABASE_URL,
    evidenceRoot: environment.ENG03_A_EVIDENCE_DIR,
  })
  assert.deepEqual(environment, original)
})

test('acceptance retains the general test database fallback when no native database is selected', () => {
  const environment = { TEST_DATABASE_URL: 'postgresql://fixture@127.0.0.1:5432/general_test' }
  const configuration = nativeAcceptanceConfiguration(environment)
  assert.equal(configuration.databaseUrl, environment.TEST_DATABASE_URL)
})

test('the native gate includes local-human isolation and production recovery by default', () => {
  assert.deepEqual(nativeAcceptanceFiles([]), [
    'test/eng03-c-native.acceptance.test.ts',
    'test/local-human-native.acceptance.test.ts',
    'test/local-human-native-recovery.acceptance.test.ts',
  ])
})

test('an explicit native gate selects only its requested files', () => {
  const file = 'test/local-human-native-recovery.acceptance.test.ts'
  assert.deepEqual(nativeAcceptanceFiles(['--files', file, `apps/api/${file}`]), [file])
})

test('native selection rejects empty, unknown and non-acceptance inputs', () => {
  for (const arguments_ of [
    ['--files'], ['--start-at', 'test/local-human-native.acceptance.test.ts'],
    ['--files', 'apps/api/test/../test/local-human-native.acceptance.test.ts'],
    ['--files', 'apps/api/test/local-human.integration.test.ts'],
    ['--files', 'apps/api/test/missing.acceptance.test.ts'],
  ]) assert.throws(() => nativeAcceptanceFiles(arguments_))
})

test('acceptance selects explicit API qualification files', () => {
  const file = 'test/claude-native-profile.acceptance.test.ts'
  assert.deepEqual(nativeAcceptanceFiles(['--files', file, file]), [file])
})

test('acceptance runs a selected case and leaves the complete gate as its default', () => {
  const files = ['test/eng03-c-native.acceptance.test.ts']
  const pattern = 'E03-A01 isolates a native approval wait from its progressing sibling'
  assert.deepEqual(nativeAcceptanceVitestArguments(files, { ENG03_A_TEST_NAME_PATTERN: pattern }),
    ['run', ...files, '--no-file-parallelism', '--testNamePattern', pattern])
  assert.deepEqual(nativeAcceptanceVitestArguments(files, {}), ['run', ...files, '--no-file-parallelism'])
})

test('acceptance rejects empty selections, broad filters and paths outside API tests', () => {
  for (const args of [['--files'], ['--files', 'codex'], ['--files', '../test/codex.acceptance.test.ts'],
    ['--files', 'test/../codex.acceptance.test.ts'], ['--testNamePattern', 'qualification']]) {
    assert.throws(() => nativeAcceptanceFiles(args))
  }
})

test('the root acceptance command forwards file selection and rejects invalid paths before native execution', () => {
  const result = spawnSync('corepack', ['pnpm', 'test:acceptance', '--files', '../outside.acceptance.test.ts'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8', timeout: 10_000,
  })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stdout + result.stderr, /Invalid acceptance test file:/)
})

test('physical transfer and provider cases are selected explicitly as acceptance suites', () => {
  const files = ['src/modules/byte-transfer/rsync.physical.acceptance.test.ts',
    'test/codex-app-server.acceptance.test.ts']
  assert.deepEqual(nativeAcceptanceFiles(['--files', ...files]), files)
})

test('native execution uses installed Vitest after the data directory changes without installing dependencies', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'native-acceptance-dependencies-'))
  const bin = join(directory, 'bin')
  try {
    await mkdir(bin)
    await writeFile(join(bin, 'corepack'), '#!/bin/sh\nexit 82\n', { mode: 0o700 })
    const environment = { ...process.env, HOME: directory,
      XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'),
      PATH: [bin, process.env.PATH].join(delimiter) }
    const command = nativeAcceptanceCommand(['--version'])
    const result = await promisify(execFile)(command.executable, command.arguments, {
      cwd: command.directory, env: environment, timeout: 30000,
    })
    assert.match(result.stdout, /vitest\//)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
