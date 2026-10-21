import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createRequire } from 'node:module'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { PostgresDeviceAccessService, pairingProof } from '../../src/modules/devices/access.js'
import { inspectInstalledCodex } from '../../src/modules/harnesses/installedCodexInspection.js'
import { AgentPlacementProducer } from '../../src/modules/placement/agentProducer.js'
import { WorkerExecutionPolicy } from '../../src/modules/settings/workerExecution.js'
import { createWorkspaceRootWorkerHandler } from '../../src/modules/sources/rootAttestation.js'
import { sourceSha256 } from '../../src/modules/sources/manifest.js'
import { WorkspaceBoundLocationService } from '../../src/modules/workspace-roots/service.js'
import type { Sch11Fixture } from './sch11Fixture.js'
import type { schedulePlacementFixture } from './schedulePlacementFixture.js'
import { agentWorkflowVersion } from './agentWorkflowFixture.js'

/** Real pairing, root attestation, source binding and installed launcher discovery on the test host. */
export async function scheduleDevicePlacementFixture(f: Sch11Fixture,
  placement: Awaited<ReturnType<typeof schedulePlacementFixture>>) {
  const pool = f.database.pool
  const mainId = placement.policy.hostRef.mainId
  const devices = new PostgresDeviceAccessService(pool, mainId)
  const admin = await f.access.issue({ name: 'Device placement owner', audience: 'operator',
    expiresAt: new Date(Date.now() + 3_600_000),
    grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
  const keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const grant = await devices.createPairingGrant(admin.principal, { commandId: randomUUID(),
    workerInstallationId: randomUUID(), publicKey, expectedFingerprint: publicKeyFingerprint(publicKey),
    scopes: ['connect', 'heartbeat'] })
  const pairing = { mainId, workerInstallationId: grant.registration.workerInstallationId,
    publicKey, grant: grant.grant, requestId: randomUUID() }
  const paired = await devices.pair({ ...pairing,
    signature: sign(null, Buffer.from(pairingProof(pairing)), keys.privateKey).toString('base64url') })
  const devicePrincipal = await devices.authenticateDevice(paired.credential, 'connect')
  const hostRef = { kind: 'device' as const, mainId, deviceId: paired.registration.deviceId }
  const allowlist = { ...placement.allowlist, hostRef,
    applicationInstallationId: paired.registration.workerInstallationId }
  const worker = createWorkspaceRootWorkerHandler(async () => allowlist, async () => {
    await devices.revalidateDevice(devicePrincipal, 'connect')
  })
  placement.connectRootWorker({ request: async (host, registration, request) => {
    const expectedRegistration = { workerInstallationId: devicePrincipal.workerInstallationId,
      keyRevision: devicePrincipal.keyRevision, authorizationRevision: devicePrincipal.authorizationRevision }
    if (!sameWorkflowValue(host, hostRef) || !sameWorkflowValue(registration, expectedRegistration)) {
      throw new Error('Root request belongs to another paired device.')
    }
    return worker(request)
  } })
  await withTransaction(pool, async sql => {
    await placement.policies.publishApprovedHostConfiguration(sql, allowlist, { mainId, hostRef,
      applicationInstallationId: allowlist.applicationInstallationId, configurationRevision: '1',
      configurationDigest: sourceSha256(Buffer.from(JSON.stringify(allowlist))) })
  })
  const locations = new WorkspaceBoundLocationService(pool, f.commands, placement.policies, 'local')
  const bound = (await locations.set(placement.writer.principal, 'http', { workspaceId: f.scope.workspaceId,
    commandId: randomUUID(), hostRef, allowedBaseId: allowlist.bases[0]!.baseId, configurationRevision: '1',
    relativePath: '', accessMode: 'read-write', expectedLocationRevision: Number(placement.policy.locationRevision),
    expectedRootPolicyRevision: 0 })).value
  if (bound.evidence !== 'bound') throw new Error('Expected a persisted device root policy.')
  const policy = bound.binding
  const selection = { hostRef, rootPolicyId: policy.rootPolicyId,
    rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }
  const root = (await placement.sources.bindRoot(placement.writer.principal, 'http', {
    workspaceId: f.scope.workspaceId, commandId: randomUUID(), source: placement.source, selection,
    expectedBindingRevision: 0, accessMode: 'exclusive-write',
  })).value
  const binding: DeviceSessionBinding = { mainId, deviceId: hostRef.deviceId,
    workerInstallationId: devicePrincipal.workerInstallationId, keyRevision: devicePrincipal.keyRevision,
    authorizationRevision: devicePrincipal.authorizationRevision, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const configurationPath = join(f.database.directory, `installed-workflow-${randomUUID()}.json`)
  const localRequire = createRequire(import.meta.url)
  const packageBytes = await readFile(localRequire.resolve('@openai/codex/package.json'), 'utf8')
  const codexPackage = JSON.parse(packageBytes) as { version: string }
  await writeFile(configurationPath, JSON.stringify({ schemaVersion: 1,
    codexBinary: localRequire.resolve('@openai/codex/bin/codex.js'),
    appMcpLauncher: process.execPath, expectedVersion: codexPackage.version, payloadPaths: [],
  }), { mode: 0o600 })
  const inspected = await inspectInstalledCodex({ binding, configuration: {
    path: configurationPath, ownerUid: process.getuid!(),
  }, environment: process.env, cwd: f.database.directory, signal: new AbortController().signal })
  if (!inspected.currentTarget) throw new Error('Expected a discovered installed device launcher.')
  const workflow = await f.workflows.current.read(placement.writer.principal, f.scope)
  const graph = structuredClone(agentWorkflowVersion(workflow.version).definition)
  for (const node of graph.nodes) {
    const configuration = f.fixture.configurations.find(item => item.agentId === node.agentId)!
    const instance = (await placement.harness.service.save(placement.writer.principal, 'http', {
      commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, enabled: true,
      presetId: 'local-default:codex', configuration: SupportedHarnessConfigurationSchema.parse(configuration.harness), target: inspected.currentTarget.target,
    })).value
    node.placement = { schemaVersion: 1, ...selection, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: instance.instanceId,
      instanceRevision: instance.instanceRevision, harnessInstallationId: instance.target.harnessInstallationId,
      source: placement.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } }
  }
  await f.workflows.current.save(placement.writer.principal, 'http', { ...f.scope, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: workflow.revision,
    expectedWorkflowVersionId: workflow.currentVersionId,
    expectedAgentConfigurationVersionIds: workflow.version.agentConfigurationVersionIds, graph })
  const workerExecution = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
  return { ...placement, policy, root, workerExecution,
    get sources() { return placement.sources },
    get producer() { return new AgentPlacementProducer(pool, mainId, placement.sources, placement.policies,
      placement.harness.registry, placement.harness.suites, workerExecution) },
    revoke: () => devices.revoke(admin.principal, hostRef.deviceId, paired.registration.authorizationRevision, randomUUID()),
  }
}
