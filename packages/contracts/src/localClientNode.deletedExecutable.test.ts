import { beforeEach, describe, expect, it, vi } from 'vitest'
import { localHumanClient } from './localClientNode.js'

const proc = vi.hoisted(() => {
  const files = new Map<string, string | Error>()
  const browserPid = Math.max(process.pid, process.ppid) + 10
  return { files, browserPid, ancestorPid: browserPid + 1, agentPid: browserPid + 2 }
})

vi.mock('node:fs/promises', () => {
  const read = async (path: string) => {
    const value = proc.files.get(path)
    if (value instanceof Error) throw value
    if (value === undefined) throw new Error(`Unexpected process lookup: ${path}`)
    return value
  }
  return { readFile: read, readlink: read }
})

vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util')
  const execFile = Object.assign(vi.fn(), {
    [promisify.custom]: async () => ({
      stdout: `ESTAB cgroup:/browser users:(("chrome",pid=${proc.browserPid},fd=1))`,
      stderr: '',
    }),
  })
  return { execFile }
})

function addProcess(pid: number, parent: number, executable: string, environment: string | Error = '') {
  proc.files.set(`/proc/${pid}/stat`, `${pid} (process) S ${parent}`)
  proc.files.set(`/proc/${pid}/exe`, executable)
  proc.files.set(`/proc/${pid}/cmdline`, '')
  proc.files.set(`/proc/${pid}/environ`, environment)
}

function socket() {
  return { remoteAddress: '127.0.0.1', remotePort: 1234, localAddress: '127.0.0.1', localPort: 5678 }
}

beforeEach(() => {
  proc.files.clear()
  addProcess(process.ppid, 1, '/usr/bin/node')
  addProcess(proc.browserPid, proc.ancestorPid, '/opt/google/chrome/chrome (deleted)')
  const hiddenEnvironment = Object.assign(new Error('Permission denied'), { code: 'EACCES' })
  addProcess(proc.ancestorPid, 1, '/usr/lib/systemd/systemd', hiddenEnvironment)
  proc.files.set(`/proc/${proc.ancestorPid}/cmdline`, '/usr/lib/systemd/systemd\0--user\0')
})

describe.skipIf(process.platform !== 'linux')('local client executable replacement', () => {
  it.each(['/opt/google/chrome/chrome', '/opt/google/chrome/chrome (deleted)'])(
    'accepts browser executable %s with a hidden ancestor environment', async executable => {
      proc.files.set(`/proc/${proc.browserPid}/exe`, executable)
      await expect(localHumanClient(socket())).resolves.toBe(true)
    })

  it.each(['codex', 'claude'])('denies a deleted %s executable in browser ancestry', async executable => {
    addProcess(proc.browserPid, proc.agentPid, '/opt/google/chrome/chrome (deleted)')
    addProcess(proc.agentPid, proc.ancestorPid, `/usr/bin/${executable} (deleted)`)
    await expect(localHumanClient(socket())).resolves.toBe(false)
  })
})
