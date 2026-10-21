import { execFile } from 'node:child_process'
import { isIP } from 'node:net'
import { networkInterfaces, userInfo } from 'node:os'
import { z } from 'zod'

import { ConnectionProbeSchema, HostDiscoverySchema, TrustedEndpointSchema, type ConnectionProbe, type HostDiscovery, type TrustedEndpoint } from '@foreman-code/contracts/trusted-device-connection'
export { ConnectionProbeSchema, HostDiscoverySchema, TrustedEndpointSchema } from '@foreman-code/contracts/trusted-device-connection'
export type { ConnectionProbe, HostDiscovery, TrustedEndpoint } from '@foreman-code/contracts/trusted-device-connection'
const AddressSchema = z.string().max(253).refine(value => isIP(value) !== 0 || /^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(value))
export interface CommandResult { code: number | null; stdout: string; stderr: string; failure?: 'missing' | 'timeout' | 'unavailable' }
export type ReadinessRunner = (executable: string, args: string[]) => Promise<CommandResult>
/** No shell, stdin, agent forwarding, interactive authentication, or unbounded output. */
export const runReadinessCommand: ReadinessRunner = (executable, args) => new Promise(resolve => {
  execFile(executable, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout, stderr) => {
    resolve({ code: error ? typeof error.code === 'number' ? error.code : null : 0, stdout, stderr,
      ...(error ? { failure: error.code === 'ENOENT' ? 'missing' : error.killed ? 'timeout' : 'unavailable' } as const : {}) })
  })
})
async function executable(runner: ReadinessRunner, name: string, flag: string) {
  const result = await runner(name, [flag])
  const version = (result.stdout || result.stderr).split('\n')[0]?.trim().slice(0, 256) || null
  return { state: result.code === 0 && version ? 'installed' as const : result.failure === 'missing' ? 'missing' as const : 'unavailable' as const, version: result.code === 0 ? version : null }
}
export async function discoverTrustedConnectionHost(runner = runReadinessCommand): Promise<HostDiscovery> {
  const [ssh, rsync, tailscale] = await Promise.all([executable(runner, 'ssh', '-V'), executable(runner, 'rsync', '--version'), executable(runner, 'tailscale', 'version')])
  let tailscaleState: HostDiscovery['tailscaleState'] = tailscale.state === 'missing' ? 'missing' : 'unavailable'
  let tailscaleAddresses: string[] = []
  if (tailscale.state === 'installed') {
    const status = await runner('tailscale', ['status', '--json'])
    if (status.code === 0) {
      try {
        const parsed = z.object({ BackendState: z.string(), TailscaleIPs: z.array(z.string()).optional(), Self: z.object({ DNSName: z.string().optional() }).passthrough().optional() }).passthrough().parse(JSON.parse(status.stdout))
        tailscaleState = parsed.BackendState === 'Running' ? 'running' : ['NeedsLogin', 'NeedsMachineAuth', 'NoState'].includes(parsed.BackendState) ? 'authentication-required' : 'stopped'
        if (tailscaleState === 'running') tailscaleAddresses = [...(parsed.TailscaleIPs ?? []), ...(parsed.Self?.DNSName ? [parsed.Self.DNSName.replace(/\.$/, '')] : [])].filter(value => AddressSchema.safeParse(value).success)
      } catch { /* ignore: malformed status is unavailable, never authenticated. */ }
    }
  }
  const lanAddresses = Object.values(networkInterfaces()).flatMap(items => items ?? []).filter(item => !item.internal
    && (item.family === 'IPv4' ? /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(item.address) : /^(fc|fd)/i.test(item.address) && !item.address.startsWith('fd7a:115c:a1e0:'))).map(item => item.address)
  const user = userInfo()
  return HostDiscoverySchema.parse({ osUser: user.username, uid: user.uid, platform: process.platform, lanAddresses: [...new Set(lanAddresses)], tailscaleAddresses, tailscaleState, executables: { ssh, rsync, tailscale } })
}
// This is the only remote command here. Endpoint/user never enter its shell text.
const DIAGNOSTIC = 'printf "GQL-USER\\n"; id -un; id -u; hostname; printf "GQL-SSH\\n"; ssh -V 2>&1; printf "GQL-RSYNC\\n"; rsync --version 2>/dev/null | head -1; printf "GQL-TAILSCALE\\n"; tailscale version 2>/dev/null | head -1'
export function trustedSshArguments(raw: TrustedEndpoint): string[] {
  const endpoint = TrustedEndpointSchema.parse(raw)
  return ['-F', '/dev/null', '-v', '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no',
    '-o', 'ForwardAgent=no', '-o', 'ClearAllForwardings=yes', '-o', 'PermitLocalCommand=no', '-o', 'ConnectTimeout=5',
    '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=1', '-p', String(endpoint.port), '-l', endpoint.osUser, endpoint.host, DIAGNOSTIC]
}
export async function probeTrustedConnection(endpoint: TrustedEndpoint, runner = runReadinessCommand): Promise<ConnectionProbe> {
  const result = await runner('ssh', trustedSshArguments(endpoint))
  const fingerprint = result.stderr.match(/Server host key: \S+ (SHA256:[A-Za-z0-9+/]{43})(?:\s|$)/)?.[1] ?? null
  const empty = { hostKeyFingerprint: fingerprint, osUser: null, uid: null, hostname: null, sshVersion: null, rsyncVersion: null, tailscaleVersion: null }
  if (result.code !== 0) {
    const state: ConnectionProbe['state'] = /REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key/.test(result.stderr) ? 'host-key-mismatch'
      : /Host key verification failed|No .* host key is known/.test(result.stderr) ? 'host-key-untrusted'
      : /Permission denied \(/.test(result.stderr) ? 'authentication-required'
      : /Permission denied/.test(result.stderr) ? 'permission-denied'
      : /Connection refused|No route to host|Connection timed out|Could not resolve hostname|Network is unreachable|Connection closed|Connection reset/.test(result.stderr) || result.failure === 'timeout' ? 'offline' : 'unavailable'
    return ConnectionProbeSchema.parse({ state, ...empty })
  }
  const lines = result.stdout.trim().split(/\r?\n/)
  const uid = Number(lines[2])
  if (!fingerprint || lines[0] !== 'GQL-USER' || lines[1] !== endpoint.osUser || !/^\d+$/.test(lines[2] ?? '') || !Number.isSafeInteger(uid) || lines[4] !== 'GQL-SSH') {
    return ConnectionProbeSchema.parse({ state: lines[1] && lines[1] !== endpoint.osUser ? 'permission-denied' : 'unavailable', ...empty })
  }
  const section = (name: string) => result.stdout.split(`GQL-${name}\n`)[1]?.split('\n')[0]?.trim() ?? ''
  const sshVersion = section('SSH'), rsyncVersion = section('RSYNC'), tailscaleVersion = section('TAILSCALE')
  return ConnectionProbeSchema.parse({ state: 'connected', hostKeyFingerprint: fingerprint, osUser: lines[1], uid, hostname: lines[3],
    sshVersion: sshVersion.startsWith('OpenSSH_') ? sshVersion : null, rsyncVersion: rsyncVersion.startsWith('rsync ') ? rsyncVersion : null, tailscaleVersion: /^\d+\.\d+\.\d+/.test(tailscaleVersion) ? tailscaleVersion : null })
}
