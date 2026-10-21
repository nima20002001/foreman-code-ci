import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

function bootIdentity() {
  if (process.platform !== 'linux') throw new Error('Disposable test recovery requires Linux process identities')
  return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid test process identity')
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const end = stat.lastIndexOf(') ')
    const fields = stat.slice(end + 2).trim().split(/\s+/)
    if (end < 0 || !/^\d+$/.test(fields[19])) throw new Error('Unconfirmed test process start time')
    return { pid, startTicks: fields[19], state: fields[0] }
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes(error.code)) return undefined
    throw error
  }
}

export function currentTestProcess() {
  const identity = processIdentity(process.pid)
  return { pid: identity.pid, startTicks: identity.startTicks, boot: bootIdentity() }
}

export function testProcessAlive(identity) {
  if (!identity || !/^\d+$/.test(identity.startTicks) || !/^[0-9a-f-]{36}$/.test(identity.boot)) {
    throw new Error('Test process ownership is unconfirmed')
  }
  if (identity.boot !== bootIdentity()) return false
  const current = processIdentity(identity.pid)
  return !!current && current.startTicks === identity.startTicks && !['Z', 'X'].includes(current.state)
}

function insideRoot(directory, path) {
  return path === directory || path.startsWith(`${directory}/`)
}

function processUsesRoot(pid, directory) {
  const proc = `/proc/${pid}`
  const environment = readFileSync(join(proc, 'environ'), 'utf8').split('\0')
  if (environment.some(entry => insideRoot(directory, entry.slice(entry.indexOf('=') + 1)))) return true
  if (insideRoot(directory, readlinkSync(join(proc, 'cwd')))) return true
  for (const fd of readdirSync(join(proc, 'fd'))) {
    try {
      if (insideRoot(directory, readlinkSync(join(proc, 'fd', fd)))) return true
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return false
}

export function testRootInUse(directory) {
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      if (lstatSync(`/proc/${entry}`).uid !== process.getuid()) continue
      const identity = processIdentity(Number(entry))
      if (!identity || ['Z', 'X'].includes(identity.state)) continue
      // Protected processes can retain a user-owned /proc directory with a root-owned environment.
      if (lstatSync(`/proc/${entry}/environ`).uid !== process.getuid()) continue
      if (processUsesRoot(Number(entry), directory)) return true
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code)) throw error
    }
  }
  return false
}
