import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createLocalProductionProject } from './helpers/localProductionProject.js'

const execute = promisify(execFile)

afterEach(() => vi.unstubAllEnvs())

it.each(['signer', 'hook'])('creates the committed CI project without invoking the host %s', async kind => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'production-project-'))
  try {
    const home = join(directory, 'home')
    const hooks = join(directory, 'hooks')
    await mkdir(home)
    await mkdir(hooks)
    const failure = '#!/bin/sh\necho "Host Git customization must not run in the fixture" >&2\nexit 71\n'
    const signer = join(directory, 'signer')
    await writeFile(signer, failure, { mode: 0o700 })
    await writeFile(join(hooks, 'pre-commit'), failure, { mode: 0o700 })
    const configuration = kind === 'signer'
      ? `[commit]\n  gpgsign = true\n[gpg]\n  program = "${signer}"\n`
      : `[core]\n  hooksPath = "${hooks}"\n`
    await writeFile(join(home, '.gitconfig'), configuration)
    vi.stubEnv('HOME', home)
    vi.stubEnv('XDG_CONFIG_HOME', join(home, '.config'))
    const project = join(directory, 'project')
    const { commit, environment } = await createLocalProductionProject(project)
    const { stdout } = await execute('git', ['show', `${commit}:pnpm-lock.yaml`], {
      cwd: project, env: environment, timeout: 10_000,
    })
    expect(stdout).toBe('lockfileVersion: 9\npackages: {}\n')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('names the missing Git executable and fixture operation', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'production-project-'))
  try {
    const bin = join(directory, 'bin')
    await mkdir(bin)
    vi.stubEnv('PATH', bin)
    await expect(createLocalProductionProject(join(directory, 'project')))
      .rejects.toThrow('Cannot create production CI fixture: Git executable "git" was not found in PATH (git init -q).')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('kills a stalled Git executable and reports the command that timed out', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const directory = await mkdtemp(join(cache, 'production-project-'))
  const pidFile = join(directory, 'git.pid')
  const bin = join(directory, 'bin')
  await mkdir(bin)
  await writeFile(join(bin, 'git'), [
    `#!${process.execPath}`,
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
    "process.on('SIGTERM', () => {});",
    'process.stdin.resume();',
  ].join('\n') + '\n', { mode: 0o700 })
  vi.stubEnv('PATH', bin)
  let settled = false
  const result = createLocalProductionProject(join(directory, 'project'))
    .catch(error => error)
    .finally(() => { settled = true })
  onTestFinished(async () => {
    // Join the blocked executable even when this regression fails on code without a command deadline.
    if (!settled) process.kill(Number(await readFile(pidFile, 'utf8')), 'SIGKILL')
    await result
    await rm(directory, { recursive: true, force: true })
  })
  await expect(result).resolves.toMatchObject({
    message: 'Cannot create production CI fixture: Git command exceeded 10000 ms and was killed (git init -q).',
    cause: { signal: 'SIGKILL' },
  })
})
