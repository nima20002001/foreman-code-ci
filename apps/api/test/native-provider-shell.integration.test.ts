import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'

it('runs the requested native shell command while retaining workspace write boundaries', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'native-provider-shell-'))
  const cwd = join(directory, 'workspace')
  const sandboxHome = join(directory, 'provider-home')
  await mkdir(cwd)
  await mkdir(sandboxHome)
  const { runNativeShell } = await import(new URL('./fixtures/remote-review-shell.mjs', import.meta.url).href)
  const policy = { cwd, sandbox: { type: 'workspaceWrite', writableRoots: [],
    networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true } }
  const settings = { sandboxHome, sandboxLauncher: createRequire(import.meta.url).resolve('@openai/codex/bin/codex.js') }
  try {
    const result = await runNativeShell('printf "native-shell-ok\\n" > result.txt && cat result.txt', policy, settings)
    expect(result).toEqual({ exitCode: 0, output: 'native-shell-ok\n' })
    expect(await readFile(join(cwd, 'result.txt'), 'utf8')).toBe('native-shell-ok\n')
    const denied = await runNativeShell('sh -c "printf forbidden > ../protected.txt"', policy, settings)
    expect(denied.exitCode).not.toBe(0)
    await expect(readFile(join(directory, 'protected.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)
