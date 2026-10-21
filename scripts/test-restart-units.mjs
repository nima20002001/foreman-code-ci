import { execFile } from 'node:child_process'
import { lstat, readFile, readdir, rm } from 'node:fs/promises'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { assertTestPath, assertTestRoot } from './test-resources.mjs'

const execute = promisify(execFile)
const user = userInfo()
const unitDirectory = join(user.homedir, '.config/systemd/user')
const restartUnitName = /^graphql-restart-[0-9a-f-]{36}\.service$/

function systemctl(args, timeout = 10_000) {
  return execute('systemctl', ['--user', ...args], { timeout, env: {
    ...process.env, XDG_RUNTIME_DIR: `/run/user/${user.uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${user.uid}/bus`,
  } })
}

export async function removeRestartUnit(unit) {
  if (!restartUnitName.test(unit)) throw new Error('Invalid restart fixture unit')
  const errors = []
  const attempt = async (args, timeout) => {
    try { await systemctl(args, timeout) }
    catch (error) {
      if (!/not running|not loaded|No such process|does not exist|not found/.test(String(error.stderr))) {
        errors.push(error)
      }
    }
  }
  // systemd owns these processes outside the test worker's process group.
  await attempt(['stop', unit], 70_000)
  await attempt(['kill', '--kill-whom=all', '--signal=SIGKILL', unit])
  await attempt(['disable', unit])
  await attempt(['reset-failed', unit])
  // Keep the ownership information available for a later sweep if cleanup failed.
  if (!errors.length) {
    try { await rm(join(unitDirectory, unit), { force: true }) }
    catch (error) { errors.push(error) }
  }
  await attempt(['daemon-reload'])
  if (errors.length) throw new AggregateError(errors, `Restart fixture unit cleanup failed: ${unit}`)
}

/** Only this invocation's private fixtures can authorize service cleanup. */
export async function sweepRestartUnits(resource, directory = join(resource.directory, 'private-fixtures')) {
  assertTestRoot(resource.directory, resource.token)
  const scope = assertTestPath(resource, directory)
  const privateRoot = join(resource.directory, 'private-fixtures')
  if (scope !== privateRoot && !scope.startsWith(`${privateRoot}/`)) {
    throw new Error('Restart unit cleanup requires an owned private fixture directory')
  }
  let units
  try { units = await readdir(unitDirectory) }
  catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  const errors = []
  for (const unit of units.filter(name => restartUnitName.test(name))) {
    try {
      const path = join(unitDirectory, unit)
      const stat = await lstat(path)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== user.uid || (stat.mode & 0o077) !== 0) continue
      const service = await readFile(path, 'utf8')
      const workingDirectory = /^WorkingDirectory=(\/[^\s%\\]+)$/m.exec(service)?.[1]
      if (!workingDirectory || (workingDirectory !== scope && !workingDirectory.startsWith(`${scope}/`))) continue
      assertTestPath(resource, workingDirectory)
      await removeRestartUnit(unit)
    } catch (error) {
      // A concurrent fixture close may have already removed its unit file.
      if (error.code !== 'ENOENT') errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Restart fixture unit sweep failed')
}
