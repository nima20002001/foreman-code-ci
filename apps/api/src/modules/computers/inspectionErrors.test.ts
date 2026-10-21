import { afterEach, expect, it, vi } from 'vitest'
import { ComputerMaintenance, systemMaintenancePorts } from './maintenance.js'
import { MainCodexSelection } from './installedCodexSelection.js'
import type { MaintenancePorts } from './maintenancePorts.js'
import * as fs from 'node:fs/promises'
import { probeComputerAccounts, probeGitHubAccount, type AccountProbePorts } from './accountProbe.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof fs>(),
  readdir: vi.fn(), access: vi.fn(), statfs: vi.fn(),
}))
afterEach(() => vi.restoreAllMocks())

function ports(): MaintenancePorts {
  return { environment: { HOME: '/fixture' }, find: async name => name, readText: async () => null,
    writePrivateText: async () => undefined, exists: async () => false, disk: async () => null,
    later: () => undefined, now: () => new Date(), run: async () => ({ code: 0, stdout: '1.2.3', stderr: '' }) }
}

it('preserves installation discovery permission failures', async () => {
  const failure = Object.assign(new Error('Installation inaccessible'), { code: 'EACCES' })
  vi.mocked(fs.readdir).mockRejectedValue(failure)
  const selection = new MainCodexSelection('codex', '/fixture/selection', ports())
  await expect(selection.selectInstalled(new AbortController().signal)).rejects.toBe(failure)
})

it.each(['version', 'latest', 'packages', 'sudo'])('reports a failed %s inspection instead of a clean unknown', async area => {
  const host = ports()
  host.run = async (binary, args) => {
    const failed = area === 'version' && args[0] === '--version'
      || area === 'latest' && binary === 'npm'
      || area === 'packages' && binary === 'apt-get'
      || area === 'sudo' && binary === 'sudo'
    return { code: failed ? 2 : 0,
      stdout: binary === 'apt-get' ? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' : '1.2.3', stderr: '' }
  }
  const maintenance = new ComputerMaintenance(host)
  await expect(maintenance.status(new AbortController().signal)).rejects.toThrow(/inspection|version|updates|sudo/i)
})

it('does not turn unreadable reboot and disk facts into absence', async () => {
  const failure = Object.assign(new Error('Storage inaccessible'), { code: 'EACCES' })
  vi.mocked(fs.access).mockRejectedValue(failure)
  vi.mocked(fs.statfs).mockRejectedValue(failure)
  const host = systemMaintenancePorts({ HOME: '/fixture', PATH: '' })
  await expect(host.exists('/fixture/reboot-required')).rejects.toBe(failure)
  await expect(host.disk('/fixture')).rejects.toBe(failure)
})

it('reports missing npm and retries latest-version discovery after it becomes available', async () => {
  const host = ports()
  let npmAvailable = false
  host.find = async name => name === 'npm' && !npmAvailable ? null : name
  host.run = async binary => ({ code: 0, stderr: '',
    stdout: binary === 'apt-get' ? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' : '1.2.3' })
  const maintenance = new ComputerMaintenance(host)
  await expect(maintenance.status(new AbortController().signal)).rejects.toThrow(/npm.*not installed/i)
  npmAvailable = true
  expect(await maintenance.status(new AbortController().signal)).toMatchObject({
    harnesses: [expect.objectContaining({ latest: '1.2.3' }), expect.objectContaining({ latest: '1.2.3' })],
  })
})

it('does not infer installation after account discovery fails', async () => {
  const failure = Object.assign(new Error('Discovery unavailable'), { code: 'EIO' })
  const host: AccountProbePorts = { environment: {}, find: async () => { throw failure },
    run: async () => ({ code: 0, stdout: '', stderr: '' }), readText: async () => null }
  await expect(probeComputerAccounts(host)).rejects.toMatchObject({
    code: 'COMPUTER_ACCOUNT_UNAVAILABLE', status: 502, details: { tool: 'codex', retryable: true }, cause: failure })
})

it('does not hide malformed native account JSON', async () => {
  const host: AccountProbePorts = { environment: {}, find: async name => name === 'claude' ? name : null,
    run: async () => ({ code: 0, stdout: 'invalid-json', stderr: '' }), readText: async () => null }
  await expect(probeComputerAccounts(host)).rejects.toMatchObject({
    code: 'COMPUTER_ACCOUNT_UNAVAILABLE', details: { tool: 'claude', retryable: true },
    cause: expect.objectContaining({ message: 'Unreadable Claude sign-in status.' }) })
})

it('does not turn an unexpected account command failure into an ordinary unknown', async () => {
  const host: AccountProbePorts = { environment: {}, find: async name => name,
    run: async () => ({ code: 2, stdout: '', stderr: 'Command failed' }), readText: async () => null }
  await expect(probeGitHubAccount(host)).rejects.toThrow(/GitHub.*inspection/i)
})

it('returns retained operational failures on computer status reads', async () => {
  const host = ports()
  host.run = async binary => ({ code: 0, stderr: '',
    stdout: binary === 'apt-get' ? '0 upgraded, 0 newly installed, 0 to remove and 0 not upgraded.' : '1.2.3' })
  logIgnoredError('devices', 'repair managed MCP mount', Object.assign(new Error('Unavailable'), { code: 'EIO' }))
  const maintenance = new ComputerMaintenance(host)
  for (let read = 0; read < 2; read++) {
    const status = await maintenance.status(new AbortController().signal)
    expect(status).toMatchObject({ operationalFailures: expect.arrayContaining([
      expect.objectContaining({ operation: 'repair managed MCP mount', lastError: 'EIO', failureCount: 1 }),
    ]) })
  }
})
