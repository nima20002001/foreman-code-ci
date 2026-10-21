import type { ComputerAccounts } from '@foreman-code/contracts/computer-accounts'
import type { ComputerConnections } from '@foreman-code/contracts/computer-maintenance'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { HarnessMcpList, ManagementPrincipal } from '@foreman-code/contracts/management'
import { isAuthorized } from '../access/policy.js'
import { logIgnoredError } from '../diagnostics/ignoredError.js'
import { fingerprint, managedStatus } from '../harnesses/nativeMcpCommon.js'

type Harness = 'codex' | 'claude'
type Preset = NonNullable<HarnessMcpList['presets']>['graphql'] | null
interface AccountsReader { read(target: DeviceProvisioningTarget, refresh: boolean): Promise<ComputerAccounts | null> }
interface McpReader {
  list(principal: ManagementPrincipal, harness: Harness, hostRef: DeviceProvisioningTarget['hostRef']): Promise<Pick<HarnessMcpList, 'presets'>>
  readMainClaudeServers?(): Promise<Record<string, unknown>>
}
const CACHE_MS = 30_000
const WAIT_MS = 10_000

/**
 * Sign-in and Foreman Code MCP state of one computer from the existing cached account probe and MCP detection.
 * A paired computer's MCP read is a remote call, so it is cached briefly and never holds the maintenance read longer
 * than WAIT_MS. Without harnesses:read the MCP state reads null, never a widened grant.
 */
export function computerConnectionsReader(accounts: AccountsReader, mcp: McpReader, now: () => number = Date.now) {
  const cache = new Map<string, { at: number; value: Promise<Preset> }>()
  const preset = (principal: ManagementPrincipal, harness: Harness, target: DeviceProvisioningTarget): Promise<Preset> => {
    if (!isAuthorized(principal, 'harnesses:read')) return Promise.resolve(null)
    const key = `${target.applicationInstallationId}:${target.authorizationRevision ?? 0}:${harness}`
    const cached = cache.get(key)
    if (cached && now() - cached.at < CACHE_MS) return cached.value
    const read: Promise<Preset> = harness === 'claude' && target.hostRef.kind === 'main' && mcp.readMainClaudeServers
      ? mcp.readMainClaudeServers().then(servers => managedStatus({ harness: 'claude', user: servers, effective: servers,
        revision: fingerprint(servers), userConfig: {}, version: '', file: '' }, 'graphql'))
      : mcp.list(principal, harness, target.hostRef).then(list => list.presets?.graphql ?? null)
    const value = read.catch(error => {
      logIgnoredError('lifecycle', 'read harness MCP state', error, { host: target.hostRef, harness })
      if (cache.get(key)?.value === value) cache.delete(key)
      return null
    })
    cache.set(key, { at: now(), value })
    return value
  }
  const bounded = <T>(value: Promise<T>, fallback: T) => Promise.race([value,
    new Promise<T>(resolve => { setTimeout(resolve, WAIT_MS, fallback).unref() })])
  return async (principal: ManagementPrincipal, target: DeviceProvisioningTarget): Promise<ComputerConnections> => {
    const [read, codex, claude] = await Promise.all([bounded(accounts.read(target, false), null),
      bounded(preset(principal, 'codex', target), null), bounded(preset(principal, 'claude', target), null)])
    return { accounts: read, mcp: { codex, claude } }
  }
}
