import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { pnpmFetchRecord, pnpmInstall } from './warmSetup.js'
import { nativeProviderFixture } from '../../../../../scripts/fixtures/native-provider.mjs'

async function runWarmInstall(root: string, bin: string, environment: NodeJS.ProcessEnv) {
  const script = ['finish() { exit "$1"; }',
    ...await pnpmInstall(root, join(root, 'cache'), join(root, 'message'))].join('\n')
  return promisify(execFile)('/bin/bash', ['-c', script], {
    cwd: root, env: { ...environment, BASH_ENV: '', PATH: `${bin}:/usr/bin:/bin` },
  })
}

it.each([0, 34])('uses normal install for a repository hook and preserves its exit code (%i)', async installCode => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'prefetch-failure-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await writeFile(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}\n')
    await writeFile(join(root, 'pnpm-lock.yaml'), 'fixture lockfile\n')
    await mkdir(join(root, 'config'))
    await writeFile(join(root, 'config/hook.cjs'), 'module.exports = {}\n')
    await writeFile(join(root, '.pnpmfile.cjs'), 'module.exports = require("./config/hook.cjs")\n')
    await writeFile(join(bin, 'corepack'), '#!/bin/sh\n'
      + 'if [ "$2" = fetch ]; then echo "fetch unsupported" >&2; exit 21; fi\n'
      + `if [ "$2" = install ]; then echo "normal install attempted"; exit ${installCode}; fi\n`
      + 'exit 22\n', { mode: 0o700 })
    const result = runWarmInstall(root, bin, process.env)
    const diagnostic = expect.stringContaining('prefetch unsupported for this layout (.pnpmfile.cjs); using normal install')
    if (installCode === 0) {
      await expect(result).resolves.toMatchObject({
        stdout: expect.stringContaining('normal install attempted'), stderr: diagnostic,
      })
    } else {
      await expect(result).rejects.toMatchObject({ code: installCode, stderr: diagnostic })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each([
  [false, false], [true, false], [false, true], [true, true],
])(
  'installs warm dependencies with the refill lock occupied (runner shell startup: %s, repository hook: %s)',
  async (runnerShellStartup, repositoryHook) => {
    const base = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(base, { recursive: true })
    const root = await mkdtemp(join(base, 'warm-install-'))
    try {
      await mkdir(join(root, 'scripts'))
      await symlink(fileURLToPath(new URL('../../../../../scripts/ci-package-paths.mjs', import.meta.url)),
        join(root, 'scripts/ci-package-paths.mjs'))
      const bin = join(root, 'bin')
      await mkdir(bin)
      const calls = join(root, 'calls')
      await writeFile(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}\n')
      await writeFile(join(root, 'pnpm-lock.yaml'), 'fixture lockfile\n')
      if (repositoryHook) await writeFile(join(root, '.pnpmfile.cjs'), 'module.exports = {}\n')
      await writeFile(join(bin, 'corepack'), `#!${process.execPath}\n`
        + `require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`,
      { mode: 0o700 })
      const environment = { ...process.env }
      if (runnerShellStartup) {
        const runnerBin = join(root, 'runner-bin')
        await mkdir(runnerBin)
        await writeFile(join(runnerBin, 'corepack'), '#!/bin/sh\necho unexpected-runner-corepack >&2\nexit 23\n',
          { mode: 0o700 })
        const shellEnvironment = join(root, 'shell-environment')
        await writeFile(shellEnvironment, 'export PATH="$RUNNER_BIN:$PATH"\n')
        environment.BASH_ENV = shellEnvironment
        environment.RUNNER_BIN = runnerBin
      }
      await runWarmInstall(root, bin, environment)
      expect(JSON.parse(await readFile(join(root, '.logs/ci-package-paths.json'), 'utf8'))).toEqual({
        storeDir: join(root, 'cache/pnpm-store'), cacheDir: join(root, 'cache/pnpm-metadata'),
      })
      const commands = async () => (await readFile(calls, 'utf8')).trim().split('\n')
        .map(line => JSON.parse(line) as string[])
      expect(await commands()).toEqual(repositoryHook ? [
        expect.arrayContaining(['pnpm', 'install', '--offline', '--frozen-lockfile']),
      ] : [
        expect.arrayContaining(['pnpm', 'fetch', '--offline', '--frozen-lockfile']),
        expect.arrayContaining(['pnpm', 'install', '--offline', '--frozen-lockfile']),
      ])
      await writeFile(calls, '')
      await mkdir(join(root, 'cache/locks'), { recursive: true })
      const holder = spawn('/usr/bin/flock', ['--exclusive', join(root, 'cache/locks/install.lock'),
        '/bin/sh', '-c', 'printf "locked\\n"; read -r release'])
      const closed = once(holder, 'close')
      try {
        const [ready] = await once(holder.stdout, 'data')
        expect(String(ready)).toContain('locked')
        // Fail immediately if a warm checkout unexpectedly tries to acquire the occupied refill lock.
        await writeFile(join(bin, 'flock'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
        await runWarmInstall(root, bin, environment)
        expect(await commands()).toEqual([
          expect.arrayContaining(['pnpm', 'install', '--offline', '--frozen-lockfile']),
        ])
      } finally {
        holder.stdin.end('release\n')
        await closed
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)

it.each([false, true])('rejects an absent native payload without retaining a ready prefetch record (warm: %s)', async warm => {
  const base = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(join(base, 'native-install-'))
  try {
    const bin = join(root, 'bin')
    await mkdir(bin)
    await mkdir(join(root, 'scripts'))
    await symlink(fileURLToPath(new URL('../../../../../scripts/ci-native-payloads.mjs', import.meta.url)),
      join(root, 'scripts/ci-native-payloads.mjs'))
    await writeFile(join(root, 'package.json'), '{"packageManager":"pnpm@11.27.0"}')
    await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    await writeFile(join(bin, 'corepack'), '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const provider = nativeProviderFixture(root)
    if (warm) await runWarmInstall(root, bin, process.env)
    await rm(provider.payload)
    await expect(runWarmInstall(root, bin, process.env)).rejects.toMatchObject({
      code: 1, stderr: expect.stringContaining('CI_NATIVE_PAYLOAD_UNAVAILABLE'),
    })
    await expect(access(pnpmFetchRecord(join(root, 'cache')))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
