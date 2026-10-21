import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { deviceApplicationFailure, DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { qualifyApprovedRootAllowlist, createWorkspaceRootWorkerHandler } from './rootAttestation.js'
import { InstalledWorkspaceRootHosts } from './rootHosts.js'
import type { AuthorizedWorkspaceRoot } from './rootPolicyPorts.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function allowlist(hostRef: { kind: 'main'; mainId: string } | { kind: 'device'; mainId: string; deviceId: string }) {
  const root = await mkdtemp('/tmp/root-hosts-'); roots.push(root)
  const base = join(root, 'projects'), runtime = join(root, 'runtime'); await mkdir(base, { mode: 0o700 }); await mkdir(runtime, { mode: 0o700 })
  return qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef, applicationInstallationId: randomUUID(),
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-write'] }], managedRuntimeRoot: runtime })
}
function rootFor(list: Awaited<ReturnType<typeof allowlist>>) {
  return { allowlist: list, registration: list.hostRef.kind === 'device' ? { workerInstallationId: list.applicationInstallationId, keyRevision: 1, authorizationRevision: 1 } : null,
    selection: { workspaceId: 'workspace-real', hostRef: list.hostRef, allowedBaseId: list.bases[0]!.baseId, configurationRevision: '1',
      relativePath: 'not-created', accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 } } as unknown as AuthorizedWorkspaceRoot
}

it('tells the operator a selected folder is missing on Main or on a laptop instead of failing internally', async () => {
  const mainId = randomUUID(), main = await allowlist({ kind: 'main', mainId }), device = await allowlist({ kind: 'device', mainId, deviceId: randomUUID() })
  const worker = createWorkspaceRootWorkerHandler(async () => device, async () => {})
  // The Worker's real handler failure crosses the device channel as its public failure code only.
  const remote = { request: async (_host: unknown, _registration: unknown, request: unknown) => {
    try { return await worker(request) } catch (error) { throw new DeviceApplicationError(deviceApplicationFailure(error).code) }
  } }
  const hosts = new InstalledWorkspaceRootHosts(main, async () => null, remote)
  for (const root of [rootFor(main), rootFor(device)]) {
    await expect(hosts.attest(root)).rejects.toMatchObject({ code: 'ROOT_DIRECTORY_MISSING', status: 409 })
    await expect(hosts.browse(root, 'not-created')).rejects.toMatchObject({ code: 'ROOT_DIRECTORY_MISSING', status: 409 })
  }
})

it('returns correctable domain failures for invalid relative paths on Main and Worker', async () => {
  const mainId = randomUUID()
  const main = await allowlist({ kind: 'main', mainId })
  const device = await allowlist({ kind: 'device', mainId, deviceId: randomUUID() })
  const worker = createWorkspaceRootWorkerHandler(async () => device, async () => {})
  const hosts = new InstalledWorkspaceRootHosts(main, async () => null, {
    request: async (_host, _registration, request) => {
      try { return await worker(request) }
      catch (error) { throw new DeviceApplicationError(deviceApplicationFailure(error).code) }
    },
  })
  for (const root of [rootFor(main), rootFor(device)]) {
    root.selection.relativePath = 'project/'
    await expect(hosts.attest(root)).rejects.toMatchObject({ code: 'ROOT_RELATIVE_PATH_INVALID', status: 422 })
    await expect(hosts.browse(root, 'project/')).rejects.toMatchObject({ code: 'ROOT_RELATIVE_PATH_INVALID', status: 422 })
  }
})
