import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'vitest'
import { assertCodexProtectedOutputPlacement, codexNativeOutputSandboxProbeCommand,
  codexNativeOutputSandboxProbeProgram,
  matchesCodexNativeProbeCommand, parseCodexNativeProbeOutput } from '../src/modules/harnesses/qualification/suites/codexNativeOutputSandbox.js'

// Probe construction is exercised without a native sandbox or a protected-store qualification.
const sandbox = { cwd: '/owned/work', writableRoots: ['/owned/extra'], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: '/owned/tmp' }
describe('Codex exact-binary native output protection check definitions', () => {
  it('requires canonical protected storage outside cwd and every effective writable root', () => {
    assert.doesNotThrow(() => assertCodexProtectedOutputPlacement('/protected/store', sandbox))
    for (const root of ['/owned/work/store', '/owned/extra/store', '/owned', 'relative-store']) {
      assert.throws(() => assertCodexProtectedOutputPlacement(root, sandbox))
    }
  })
  it('accounts for actual TMPDIR and slash-tmp according to measured exclusion policy', () => {
    assert.throws(() => assertCodexProtectedOutputPlacement('/owned/tmp/store', { ...sandbox, excludeTmpdirEnvVar: false }))
    assert.throws(() => assertCodexProtectedOutputPlacement('/tmp/store', { ...sandbox, excludeSlashTmp: false }))
    assert.throws(() => assertCodexProtectedOutputPlacement('/protected/store', { ...sandbox, excludeTmpdirEnvVar: false, tmpdir: 'relative' }))
    assert.doesNotThrow(() => assertCodexProtectedOutputPlacement('/tmp/store', sandbox))
  })
  it('records the direct actor, its descendant and the environment in the filesystem witness', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'native-probe-command-'))
    const paths = { directPath: join(directory, "direct'file"), descendantPath: join(directory, 'child'),
      witnessPath: join(directory, 'witness'), marker: 'recorded-marker' }
    try {
      const programPath = join(directory, "probe'program.py")
      await writeFile(programPath, codexNativeOutputSandboxProbeProgram(paths), { mode: 0o400 })
      const command = codexNativeOutputSandboxProbeCommand(programPath)
      const executed = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8',
        env: { ...process.env, TMPDIR: directory } })
      assert.equal(executed.status, 0, executed.stderr)
      const result = JSON.parse(executed.stdout)
      assert.deepEqual(result, JSON.parse(await readFile(paths.witnessPath, 'utf8')))
      assert.equal(result.marker, paths.marker)
      assert.equal(result.uid, process.getuid?.())
      assert.equal(result.tmpdir, directory)
      assert.deepEqual(result.direct, { denied: false, errno: null })
      assert.deepEqual(result.descendant, { denied: false, errno: null })
      assert.equal(result.descendantExitCode, 0)
      assert.deepEqual(parseCodexNativeProbeOutput(`Failed to load an unrelated shell profile\n${executed.stdout}`,
        paths.marker), result)
      assert.equal(parseCodexNativeProbeOutput(executed.stdout, 'another-marker'), undefined)
      assert.equal(parseCodexNativeProbeOutput(executed.stdout + executed.stdout, paths.marker), undefined)
      assert.equal(parseCodexNativeProbeOutput('Failed to execute the command', paths.marker), undefined)
      assert.equal(await readFile(paths.directPath, 'utf8'), paths.marker)
      assert.equal(await readFile(paths.descendantPath, 'utf8'), paths.marker)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })
  it('matches only the original payload in the selected shell wrapper', () => {
    const command = "printf '%s' \"quoted\\value\"\n# $literal `literal`"
    const singleQuoted = `'${command.replaceAll("'", "'\\''")}'`
    const doubleQuoted = `"${command.replace(/[\\"$`]/gu, '\\$&')}"`
    assert.equal(matchesCodexNativeProbeCommand(command, command, '/bin/bash'), true)
    for (const quoted of [singleQuoted, doubleQuoted]) {
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted}`, command, '/bin/bash'), true)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -c ${quoted}`, command, '/bin/bash'), true)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/sh -lc ${quoted}`, command, '/bin/bash'), false)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted}; echo extra`, command, '/bin/bash'), false)
      assert.equal(matchesCodexNativeProbeCommand(`/bin/bash -lc ${quoted} extra`, command, '/bin/bash'), false)
    }
    assert.equal(matchesCodexNativeProbeCommand('/bin/bash -lc "different script"', command, '/bin/bash'), false)
    assert.equal(matchesCodexNativeProbeCommand(null, command, '/bin/bash'), false)
  })
  it('preserves a quoted pathname in parseable Python', () => {
    const program = codexNativeOutputSandboxProbeProgram({ directPath: "/protected/store/quoted'path", descendantPath: '/protected/store/child',
      witnessPath: '/owned/work/witness', marker: 'recorded-marker' })
    const programPath = "/protected/store/probe'program.py"
    const command = codexNativeOutputSandboxProbeCommand(programPath)
    const parsed = spawnSync('/usr/bin/python3', ['-c', `import ast,shlex,sys
assert shlex.split(sys.argv[1]) == ['/usr/bin/python3',sys.argv[2]]
ast.parse(sys.argv[3])`, command, programPath, program], { encoding: 'utf8' })
    assert.equal(parsed.status, 0, parsed.stderr)
  })
})
