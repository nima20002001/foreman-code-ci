import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type pg from 'pg'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { TransferIntentSchema, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import type { TrustedConnectionConsent } from '@foreman-code/contracts/trusted-device-connection'
import { PostgresTrustedConnectionSetup } from '../devices/trustedConnectionSetup.js'
import { transferContextForBinding } from './carrier.js'
import { InstalledRsyncSelectionSchema, createInstalledRsyncSelectionProvider, readProtectedInstalledRsyncSelection,
  readProtectedInstalledRsyncWriterSelection, type InstalledRsyncSelection } from './installedRsyncSelection.js'
import type { RsyncCommand } from './rsync.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); vi.restoreAllMocks() })
async function fixture() {
  const root = await mkdtemp('/tmp/graphql-rsync-selection-'); roots.push(root)
  const localBinary = join(root, '.local/share/graphql-tools/rsync/3.5.1/bin/rsync')
  await mkdir(dirname(localBinary), { recursive: true, mode: 0o700 }); await writeFile(localBinary, 'fixture app-private rsync bytes', { mode: 0o500 })
  let binding: DeviceSessionBinding | undefined = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const original = structuredClone(binding)
  let registration: DeviceRegistration = { mainId: original.mainId, deviceId: original.deviceId, workerInstallationId: original.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  let consent: TrustedConnectionConsent = { mainId: original.mainId, deviceId: original.deviceId, workerInstallationId: original.workerInstallationId,
    keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), revision: 1, endpoint: { transport: 'tailscale', host: '100.64.0.20', port: 22, osUser: 'builder' },
    hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true,
    privilege: 'selected-os-user', automaticSudo: false, grantsAgentPermissions: false }
  const intent = TransferIntentSchema.parse({ ...transferContextForBinding(original), version: 1, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(), attemptId: randomUUID(),
    placementHash: 'a'.repeat(64), rootId: randomUUID(), rootBindingRevision: 1, direction: 'to-worker', byteClass: 'source', sha256: 'c'.repeat(64),
    byteSize: 2, manifestDigest: 'd'.repeat(64), chunkBytes: 2, expiresAt: new Date(Date.now() + 120000).toISOString() })
  let selected: InstalledRsyncSelection | undefined = { formatVersion: 1, backend: 'rsync', registration: structuredClone(registration), consentRevision: 1,
    endpoint: { user: 'builder', host: '100.64.0.20', localRoot: join(root, 'main-stage'), remoteRoot: '/home/builder/.local/state/graphql-worker/rsync-stage' },
    localBinary: { path: localBinary, sha256: createHash('sha256').update('fixture app-private rsync bytes').digest('hex'), version: '3.5.1' },
    remoteBinary: { path: '/home/builder/.local/share/graphql-tools/rsync/3.5.1/bin/rsync', sha256: 'e'.repeat(64), version: '3.5.1' },
    nodeBinary: { path: '/home/builder/.local/share/graphql-worker/node/bin/node', sha256: '2'.repeat(64) },
    entryPoint: { path: '/home/builder/.local/share/graphql-worker/src/rsync-writer.mjs', sha256: '3'.repeat(64) },
    sourceProvenance: { sourceSha256: 'f'.repeat(64), releaseSignerFingerprint: 'A'.repeat(40) } }
  const file = join(root, 'installed-selection.json')
  await writeFile(file, JSON.stringify(selected), { mode: 0o600 })
  let grantDenied = false, version = '3.5.1', remoteDigest = selected.remoteBinary.sha256
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('device_registrations') ? [{ record: registration }] : sql.includes('management_command_receipts') ? [{ result: consent }] : [], rowCount: 1 }))
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const probe = vi.fn(async () => ({ state: 'connected' as const, hostKeyFingerprint: consent.hostKeyFingerprint, osUser: consent.endpoint.osUser, uid: 1000, hostname: 'worker',
    sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync  version 3.2.7', tailscaleVersion: '1.102.4' }))
  const setup = new PostgresTrustedConnectionSetup(pool, original.mainId, { probe })
  const accepted = { intent: vi.fn(async (id: string) => { if (id !== intent.transferId) throw new Error('unknown original intent'); return intent }),
    authorize: vi.fn(async (candidate: TransferIntent) => { if (grantDenied) throw new Error('original accepted grant denied'); if (JSON.stringify(candidate) !== JSON.stringify(intent)) throw new Error('changed intent') }) }
  const baseRun = async (command: RsyncCommand) => command.executable === localBinary ? `rsync  version ${version}  protocol version 33\n`
    : command.args.at(-1)?.includes(selected!.nodeBinary.path) ? `${selected!.nodeBinary.sha256}  ${selected!.nodeBinary.path}\n${selected!.entryPoint.sha256}  ${selected!.entryPoint.path}\n`
    : command.args.at(-1)?.startsWith('/usr/bin/sha256sum') ? `${remoteDigest}  ${selected!.remoteBinary.path}\n`
    : `rsync  version ${version}  protocol version 33\n${remoteDigest}  ${selected!.remoteBinary.path}\n`
  const executor = { run: vi.fn(baseRun) }
  const installed = vi.fn(async () => selected)
  const provider = createInstalledRsyncSelectionProvider({ installed, setup, accepted, capture: () => binding, executor })
  return { root, file, localBinary, intent, setup, accepted, query, probe, executor, installed, provider, baseRun,
    get selected() { return selected! }, updateSelection: (update: Partial<InstalledRsyncSelection>) => { selected = { ...selected!, ...update } },
    removeSelection: () => { selected = undefined }, updateConsent: (update: Partial<TrustedConnectionConsent>) => { consent = { ...consent, ...update } },
    updateRegistration: (update: Partial<DeviceRegistration>) => { registration = { ...registration, ...update } },
    deny: () => { grantDenied = true }, move: () => { binding = { ...binding!, connectionEpoch: randomUUID(), connectionGeneration: 2 } }, disconnect: () => { binding = undefined },
    version: (value: string) => { version = value }, remoteDigest: (value: string) => { remoteDigest = value } }
}
describe('protected explicit installed rsync selection', () => {
  it('rechecks transfer permission and consent without repeating SSH qualification for each byte operation', async () => {
    const f = await fixture()
    const selected = await f.provider.selection(f.intent, new AbortController().signal)
    f.executor.run.mockClear()
    f.probe.mockClear()
    f.accepted.authorize.mockClear()
    for (let index = 0; index < 4; index++) await selected.revalidate!(new AbortController().signal)
    expect(f.executor.run).not.toHaveBeenCalled()
    expect(f.probe).not.toHaveBeenCalled()
    expect(f.accepted.authorize).toHaveBeenCalled()
    await f.provider.selection(f.intent, new AbortController().signal)
    expect(f.executor.run).toHaveBeenCalled()
    expect(f.probe).toHaveBeenCalled()
  })

  it.each(['consent', 'registration', 'selection', 'grant', 'connection'] as const)('rejects a changed %s during a selected transfer', async change => {
    const f = await fixture()
    const selected = await f.provider.selection(f.intent, new AbortController().signal)
    if (change === 'consent') f.updateConsent({ allowOwnerCommands: false })
    if (change === 'registration') f.updateRegistration({ authorizationRevision: 2 })
    if (change === 'selection') f.removeSelection()
    if (change === 'grant') f.deny()
    if (change === 'connection') f.move()
    await expect(selected.revalidate!(new AbortController().signal)).rejects.toThrow()
  })

  it('reads only private explicit installation config; absence is not selected', async () => {
    const f = await fixture(), signal = new AbortController().signal
    expect(await readProtectedInstalledRsyncSelection(f.file, signal)).toEqual(f.selected)
    expect(await readProtectedInstalledRsyncSelection(join(f.root, 'absent.json'), signal)).toBeUndefined()
    await chmod(f.file, 0o644)
    await expect(readProtectedInstalledRsyncSelection(f.file, signal)).rejects.toThrow('private owner file')
  })
  it('rejects symlinks, writable ancestors, oversized data and an implicit backend', async () => {
    const f = await fixture(), signal = new AbortController().signal, link = join(f.root, 'link.json')
    await symlink(f.file, link); await expect(readProtectedInstalledRsyncSelection(link, signal)).rejects.toThrow()
    await chmod(f.root, 0o777); await expect(readProtectedInstalledRsyncSelection(f.file, signal)).rejects.toThrow('unsafe ancestors'); await chmod(f.root, 0o700)
    await writeFile(f.file, 'x'.repeat(32769)); await expect(readProtectedInstalledRsyncSelection(f.file, signal)).rejects.toThrow('bounded')
    await writeFile(f.file, JSON.stringify({ ...f.selected, backend: 'auto' })); await expect(readProtectedInstalledRsyncSelection(f.file, signal)).rejects.toThrow()
  })
  it('combines genuine setup/accepted readback with exact freshly verified private pins, independent of old PATH diagnostics', async () => {
    const f = await fixture(), selection = await f.provider.selection(f.intent, new AbortController().signal)
    expect(selection.backend).toBe('rsync'); expect(selection.check.state).toBe('ready')
    expect(selection.check.probe?.rsyncVersion).toContain('3.2.7')
    expect(selection.endpoint.localBinary).toBe(f.selected.localBinary.path); expect(selection.endpoint.remoteBinarySha256).toBe(f.selected.remoteBinary.sha256)
    expect(selection).toMatchObject({ nodeBinary: f.selected.nodeBinary.path, entryPoint: f.selected.entryPoint.path })
    expect(f.executor.run.mock.calls[0]![0].args.at(-1)).toBe(`/usr/bin/sha256sum -- ${f.selected.remoteBinary.path}`)
    expect(f.executor.run.mock.calls.some(([command]) => command.executable === '/usr/bin/rsync')).toBe(false)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('management_principals'))).toBe(false)
    expect(f.accepted.authorize).toHaveBeenCalled(); expect(f.installed.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
  it('requires explicit pinned writer installation facts and rejects relative or shell paths', async () => {
    const f = await fixture()
    for (const field of ['nodeBinary', 'entryPoint'] as const) {
      expect(InstalledRsyncSelectionSchema.safeParse({ ...f.selected, [field]: undefined }).success).toBe(false)
      for (const path of ['node', '/tmp/../caller', '/tmp/node;id', '/tmp/$(id)', '/tmp/space path']) {
        expect(InstalledRsyncSelectionSchema.safeParse({ ...f.selected, [field]: { ...f.selected[field], path } }).success).toBe(false)
      }
      expect(InstalledRsyncSelectionSchema.safeParse({ ...f.selected, [field]: { ...f.selected[field], sha256: undefined } }).success).toBe(false)
    }
  })
  it('reads worker rsync and writer package pins only from protected original installation facts', async () => {
    const f = await fixture(), signal = new AbortController().signal
    const node = join(f.root, 'node'), script = join(f.root, 'rsync-writer.mjs')
    const digest = (value: string) => createHash('sha256').update(value).digest('hex')
    await writeFile(node, 'node bytes', { mode: 0o500 }); await writeFile(script, 'script bytes', { mode: 0o400 })
    f.updateSelection({ remoteBinary: f.selected.localBinary, nodeBinary: { path: node, sha256: digest('node bytes') },
      entryPoint: { path: script, sha256: digest('script bytes') } })
    await writeFile(f.file, JSON.stringify(f.selected))
    expect(await readProtectedInstalledRsyncWriterSelection(f.file, f.selected.registration, signal)).toEqual({
      stagingRoot: f.selected.endpoint.remoteRoot, binary: { executable: f.localBinary, sha256: f.selected.localBinary.sha256 },
      nodeBinary: node, entryPoint: script })
    expect(await readProtectedInstalledRsyncWriterSelection(join(f.root, 'absent.json'), f.selected.registration, signal)).toBeUndefined()
    await expect(readProtectedInstalledRsyncWriterSelection(f.file, { ...f.selected.registration, keyRevision: 2 }, signal)).rejects.toThrow('paired identity')
    await chmod(script, 0o600); await writeFile(script, 'changed script')
    await expect(readProtectedInstalledRsyncWriterSelection(f.file, f.selected.registration, signal)).rejects.toThrow('changed before verification')
  })
  it('denies changed remote writer bytes and changed installation pins during verification', async () => {
    const f = await fixture()
    f.executor.run.mockImplementation(async command => command.args.at(-1)?.includes(f.selected.nodeBinary.path) ? 'changed writer bytes\n' : f.baseRun(command))
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('writer installation changed')
    const g = await fixture()
    g.executor.run.mockImplementation(async command => {
      const result = await g.baseRun(command)
      if (command.args.at(-1)?.includes(g.selected.nodeBinary.path)) g.updateSelection({ entryPoint: { ...g.selected.entryPoint, sha256: '4'.repeat(64) } })
      return result
    })
    await expect(g.provider.selection(g.intent, new AbortController().signal)).rejects.toThrow()
  })
  it('does not activate from consent alone and never auto-selects a backend', async () => {
    const f = await fixture(); f.removeSelection()
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('not explicitly selected')
    expect(f.probe).not.toHaveBeenCalled(); expect(f.executor.run).not.toHaveBeenCalled()
  })
  it.each(['consent-revision', 'registration', 'host', 'os-user', 'port', 'revoked'])('denies stale protected selection %s', async change => {
    const f = await fixture()
    if (change === 'consent-revision') f.updateConsent({ revision: 2 })
    if (change === 'registration') f.updateRegistration({ keyRevision: 2 })
    if (change === 'host') f.updateSelection({ endpoint: { ...f.selected.endpoint, host: 'different.example' } })
    if (change === 'os-user') f.updateSelection({ endpoint: { ...f.selected.endpoint, user: 'root' } })
    if (change === 'port') f.updateConsent({ endpoint: { transport: 'tailscale', host: '100.64.0.20', osUser: 'builder', port: 2222 } })
    if (change === 'revoked') f.updateConsent({ allowOwnerCommands: false })
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow()
    expect(f.executor.run).not.toHaveBeenCalled()
  })
  it('rejects system PATH binary substitution and local changed bytes before invoking any binary', async () => {
    const f = await fixture(); f.updateSelection({ localBinary: { ...f.selected.localBinary, path: '/usr/bin/rsync' } })
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('app-private')
    const g = await fixture(); await chmod(g.localBinary, 0o700); await writeFile(g.localBinary, 'changed bytes'); await chmod(g.localBinary, 0o500)
    await expect(g.provider.selection(g.intent, new AbortController().signal)).rejects.toThrow('changed before verification')
    expect(g.executor.run).not.toHaveBeenCalled()
  })
  it('rejects installed selection changes during the final trusted probe', async () => {
    const f = await fixture()
    f.probe.mockImplementationOnce(async () => ({ state: 'connected', hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, osUser: 'builder', uid: 1000, hostname: 'worker', sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync version 3.2.7', tailscaleVersion: '1.102.4' }))
    f.probe.mockImplementationOnce(async () => { f.updateSelection({ consentRevision: 2 }); return { state: 'connected', hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, osUser: 'builder', uid: 1000, hostname: 'worker', sshVersion: 'OpenSSH_9.6p1', rsyncVersion: 'rsync version 3.2.7', tailscaleVersion: '1.102.4' } })
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('during final trusted check')
  })
  it('checks remote bytes before remote version and rejects changed digest or unqualified version', async () => {
    const f = await fixture(); f.remoteDigest('a'.repeat(64))
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('remote app-private binary changed')
    expect(f.executor.run).toHaveBeenCalledTimes(1)
    const g = await fixture(); g.version('3.2.7'); await expect(g.provider.selection(g.intent, new AbortController().signal)).rejects.toThrow('security qualification')
    const h = await fixture(); h.version('3.5.0'); await expect(h.provider.selection(h.intent, new AbortController().signal)).rejects.toThrow('approved rsync3.5.1')
  })
  it.each(['binding', 'grant', 'selection', 'consent'])('fences changes during executor await: %s', async change => {
    const f = await fixture()
    f.executor.run.mockImplementationOnce(async command => {
      const output = await f.baseRun(command)
      if (change === 'binding') f.move()
      if (change === 'grant') f.deny()
      if (change === 'selection') f.updateSelection({ consentRevision: 9 })
      if (change === 'consent') f.updateConsent({ allowOwnerCommands: false })
      return output
    })
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow()
  })
  it('denies unavailable outgoing capture, altered accepted intent and cancellation', async () => {
    const f = await fixture(); f.disconnect()
    await expect(f.provider.selection(f.intent, new AbortController().signal)).rejects.toThrow('client capture')
    const g = await fixture(); await expect(g.provider.selection({ ...g.intent, byteSize: 8 }, new AbortController().signal)).rejects.toThrow('original accepted transfer')
    const h = await fixture(), controller = new AbortController(); controller.abort(new Error('cancelled'))
    await expect(h.provider.selection(h.intent, controller.signal)).rejects.toThrow('cancelled'); expect(h.executor.run).not.toHaveBeenCalled()
  })
})
