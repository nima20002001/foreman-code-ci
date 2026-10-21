import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, rm, writeFile } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect } from 'vitest'
import { publishRestartUnit } from './installedRestartService.js'

const execute = promisify(execFile)
const user = userInfo()
export const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], { env: {
  ...process.env, XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
  DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${user.uid}/bus`,
}, timeout: 15_000 })

export async function restartUnit(directory: string, state: 'active' | 'failed') {
  const unit = `graphql-restart-${randomUUID()}.service`
  const unitPath = join(user.homedir, '.config/systemd/user', unit)
  const script = join(directory, 'service.mjs')
  await writeFile(script, state === 'failed' ? 'process.exit(1)' : 'setInterval(() => {}, 1000)')
  await publishRestartUnit(unitPath, `[Service]
Type=exec
WorkingDirectory=${directory}
ExecStart=${process.execPath} ${script}
Restart=no
KillMode=process
[Install]
WantedBy=default.target
`)
  return { unit, unitPath }
}

export async function removeRestartUnit(unit: string, unitPath: string) {
  const errors: unknown[] = []
  for (const operation of ['stop', 'disable', 'reset-failed']) {
    try { await systemctl(operation, unit) }
    catch (error) {
      const stderr = String((error as { stderr?: string }).stderr)
      if (!/not loaded|does not exist|not found/.test(stderr)) errors.push(error)
    }
  }
  await rm(unitPath, { force: true })
  await systemctl('daemon-reload')
  if (errors.length) throw new AggregateError(errors, 'Regression fixture unit cleanup failed.')
}

export async function expectRemovedUnit(unit: string, unitPath: string, pid: number) {
  const state = await systemctl('show', unit, '--property=ActiveState', '--property=LoadState', '--property=MainPID')
  expect(state.stdout).toContain('ActiveState=inactive')
  expect(state.stdout).toContain('LoadState=not-found')
  expect(state.stdout).toContain('MainPID=0')
  await expect(systemctl('is-enabled', unit)).rejects.toBeDefined()
  await expect(access(unitPath)).rejects.toMatchObject({ code: 'ENOENT' })
  if (pid > 0) expect(() => process.kill(pid, 0)).toThrow()
}
