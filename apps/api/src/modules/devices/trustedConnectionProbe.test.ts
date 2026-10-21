import { describe, expect, it, vi } from 'vitest'
import { discoverTrustedConnectionHost, probeTrustedConnection, trustedSshArguments, type ReadinessRunner } from './trustedConnectionProbe.js'
const endpoint = { host: '100.64.0.20', port: 22, osUser: 'builder', transport: 'tailscale' as const }
const fingerprint = `SHA256:${'a'.repeat(43)}`
const good = { code: 0, stdout: 'GQL-USER\nbuilder\n1000\nlaptop\nGQL-SSH\nOpenSSH_9.6p1\nGQL-RSYNC\nrsync  version 3.2.7\nGQL-TAILSCALE\n1.102.4\n', stderr: `debug1: Server host key: ssh-ed25519 ${fingerprint}\n` }
describe('strict fixed SSH diagnostics', () => {
  it('observes authenticated selected user, host identity and tool versions', async () => {
    const run = vi.fn<ReadinessRunner>(async () => good)
    expect(await probeTrustedConnection(endpoint, run)).toMatchObject({ state: 'connected', uid: 1000, osUser: 'builder', hostKeyFingerprint: fingerprint, rsyncVersion: 'rsync  version 3.2.7' })
    const args = run.mock.calls[0]![1]
    expect(args).toContain('StrictHostKeyChecking=yes'); expect(args).toContain('UpdateHostKeys=no'); expect(args).toContain('ForwardAgent=no')
    expect(args.at(-1)).not.toContain(endpoint.host)
  })
  it.each(['-oProxyCommand=bad', 'a;touch /tmp/bad', 'a$(id)', 'bad\nuser', 'user@host', 'host/path'])('rejects unsafe endpoint %s before spawn', async host => {
    const run = vi.fn<ReadinessRunner>(async () => good)
    await expect(probeTrustedConnection({ ...endpoint, host }, run)).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })
  it('rejects username/port injection and accepts IPv6', () => {
    expect(() => trustedSshArguments({ ...endpoint, osUser: 'builder;id' })).toThrow()
    expect(() => trustedSshArguments({ ...endpoint, port: 0 })).toThrow()
    expect(trustedSshArguments({ ...endpoint, host: 'fd7a:115c:a1e0::1234' })).toContain('fd7a:115c:a1e0::1234')
  })
  it.each([
    ['REMOTE HOST IDENTIFICATION HAS CHANGED', 'host-key-mismatch'],
    ['Host key verification failed.', 'host-key-untrusted'],
    ['Permission denied (publickey).', 'authentication-required'],
    ['Connection refused', 'offline'],
    ['No route to host', 'offline'],
    ['Permission denied', 'permission-denied'],
    ['unexpected failure', 'unavailable'],
  ])('truthfully maps %s', async (stderr, state) => {
    expect((await probeTrustedConnection(endpoint, async () => ({ code: 255, stdout: '', stderr }))).state).toBe(state)
  })
  it('does not infer SSH authentication from a successful command without observed host identity', async () => {
    expect((await probeTrustedConnection(endpoint, async () => ({ ...good, stderr: '' }))).state).toBe('unavailable')
    expect((await probeTrustedConnection(endpoint, async () => ({ ...good, stdout: good.stdout.replace('builder', 'root') }))).state).toBe('permission-denied')
    expect((await probeTrustedConnection(endpoint, async () => ({ ...good, stdout: good.stdout.replace('rsync  version 3.2.7', '') }))).rsyncVersion).toBeNull()
  })
  it('returns only actual Tailscale self endpoints without peer data or auth URLs', async () => {
    const runner: ReadinessRunner = async (name, args) => args[0] === 'status' ? { code: 0, stdout: JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.22'], Self: { DNSName: 'main.example.ts.net.' }, Peer: { private: 'unrelated' }, AuthURL: 'secret' }), stderr: '' } : { code: 0, stdout: `${name}-version\n`, stderr: '' }
    const facts = await discoverTrustedConnectionHost(runner)
    expect(facts.tailscaleState).toBe('running'); expect(facts.tailscaleAddresses).toEqual(['100.64.0.22', 'main.example.ts.net'])
    expect(JSON.stringify(facts)).not.toMatch(/secret|unrelated/)
  })
  it.each(['NeedsLogin', 'NeedsMachineAuth'])('reports %s without presenting usable endpoints', async BackendState => {
    const facts = await discoverTrustedConnectionHost(async (name, args) => ({ code: 0, stdout: args[0] === 'status' ? JSON.stringify({ BackendState, TailscaleIPs: ['100.1.1.1'] }) : name, stderr: '' }))
    expect(facts.tailscaleState).toBe('authentication-required'); expect(facts.tailscaleAddresses).toEqual([])
  })
  it('keeps missing optional Tailscale distinct from unavailable socket or malformed status', async () => {
    const missing = await discoverTrustedConnectionHost(async () => ({ code: null, stdout: '', stderr: '', failure: 'missing' }))
    expect(missing.tailscaleState).toBe('missing'); expect(missing.executables.rsync.state).toBe('missing')
    const malformed = await discoverTrustedConnectionHost(async () => ({ code: 0, stdout: 'invalid JSON', stderr: '' }))
    expect(malformed.tailscaleState).toBe('unavailable')
  })
})
