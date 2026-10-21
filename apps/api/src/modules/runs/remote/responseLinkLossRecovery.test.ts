import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { CODEX_APPROVAL_OPTIONS_FIXTURE, DEFAULT_HARNESS_DEFAULTS, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { RemoteOwnerControlSchema, type RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { deriveDispatch, freezePlacement } from '../../placement/binding.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../interactions/runtimePorts.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { RemoteOperationJournal } from './operationJournal.js'
import { RemoteNativeSessionManager } from './nativeManagerProxy.js'
import { RemoteExecutionHost, type RemoteExecutionHostPorts } from './executionHost.js'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function workerWithPendingApproval() {
  const root = await mkdtemp(join(tmpdir(), 'response-link-loss-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  const journal = await RemoteOperationJournal.open(join(root, 'journal'), { initializeNewInstallation: true })
  cleanups.push(() => journal.close())
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID(), digest = 'a'.repeat(64)
  const configuration: AgentConfigurationVersion = { id: 'configuration', agentId: 'agent', workspaceId: 'workspace',
    version: 1, prompt: { system: 'test' }, assignedSkills: [], harness: DEFAULT_HARNESS_DEFAULTS.codex,
    contentHash: 'sha256:test', createdAt: '2026-10-01T00:00:00.000Z' }
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId },
    registration: { workerInstallationId: installationId, keyRevision: 1, authorizationRevision: 1 },
    mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization', materializationDigest: digest },
    payload: { kind: 'agent', agentId: 'agent', agentConfigurationVersionId: 'configuration', driverId: 'codex',
      driverRevision: '1', instanceId: 'instance', instanceRevision: '1', harnessInstallationId: 'harness',
      installationFingerprint: digest, runtimeContractVersion: 1, protocolRevision: '1', credentialScopeRefs: [] } })
  const input = { value: 'accepted' }
  const inputDigest = `sha256:${createHash('sha256').update(canonicalGraphJson(input)).digest('hex')}`
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest, owner: { grantId: 'grant', epoch: '1' } })
  const request = { executionId: 'execution', runId: 'run', workspaceId: 'workspace', workflowNodeId: 'node',
    workingDirectory: '/project', runtimeDirectory: '/runtime/execution', configuration, input }
  const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'native-session' }
  const option = CODEX_APPROVAL_OPTIONS_FIXTURE[0]!
  const responses: string[] = []
  const question = { session, turn: { nativeTurnId: 'native-turn', nativeRequestId: 'question' },
    nativeRequestType: 'approval', request: {}, responseOptions: [option] }
  const manager: NativeHarnessSessionManager = {
    harness: 'codex', capabilities: async () => { throw new Error('unused') }, inspectMcp: async () => { throw new Error('unused') },
    createSession: async () => session, attachSession: async () => session,
    startTurn: async function* (_session, turn) {
      await turn.onSubmitted?.('native-turn')
      yield { sequence: 1, type: 'event', occurredAt: '2026-10-01T00:00:00.000Z', payload: {} }
    },
    pending: async () => responses.length ? undefined : question,
    respond: async (_session, requestId) => { responses.push(requestId) },
    cancel: async () => false,
    history: async () => ({ events: [], pendingInteractions: responses.length ? [] : [question] }),
    reconcile: async () => ({ events: [], pendingInteractions: responses.length ? [] : [question] }),
    reconcileResponse: async () => ({ events: [], pendingInteractions: responses.length ? [] : [question] }),
    close: async () => {},
  }
  const ports: RemoteExecutionHostPorts = { journal, connection: { mainId, deviceId, workerInstallationId: installationId,
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1 },
  incarnationId: randomUUID(), managers: new ExecutionScopedNativeSessionManagerResolver(() => manager),
  authorize: async () => {},
  attestRuntimeLeaf: async (intent, placement, request) => ({ executionId: intent.executionId, attemptId: intent.attemptId,
    operationId: intent.operationId, bindingHash: intent.bindingHash, canonicalRuntimeDirectory: request.runtimeDirectory,
    directoryIdentityHash: digest, materializationId: placement.source.materializationId!,
    materializationDigest: placement.source.materializationDigest! }),
  preflight: async () => undefined,
  nativeEvidence: async () => ({ sessionId: 'native-session', processIdentityDigest: digest }), settle: async () => null }
  const host = new RemoteExecutionHost(ports)
  cleanups.push(() => host.drain())
  const link = { dropNextControl: false, controls: 0 }
  let admitted: RemoteOwnerControl | undefined
  const retries: RemoteOwnerControl[] = []
  const proxy = new RemoteNativeSessionManager({
    intent, placement, harness: 'codex', configuration,
    transport: { request: async (method, frame) => {
      if (method === 'control') {
        link.controls++
        if (link.dropNextControl) {
          link.dropNextControl = false
          throw new Error('Worker link lost before the response reached the Worker')
        }
      }
      return host.handle(frame)
    } },
    observeReceipt: async () => {},
    controlFor: async () => {
      const status = await journal.status(intent.operationId)
      if (status.status !== 'known') throw new Error('Missing original receipt')
      admitted = RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId: 'original-response',
        operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId,
        bindingHash: intent.bindingHash, owner: intent.owner, native: status.receipt.native,
        action: { kind: 'respond', interactionId: 'interaction', interactionRevision: '1',
          nativeInteractionId: 'question', response: option } })
      return admitted
    },
    readResponseControl: async () => admitted,
    authorizeResponseRetry: async command => { retries.push(command) },
  })
  const created = await proxy.createSession({ request, correlationId: 'execution:execution' })
  await host.startTurn(intent.operationId, 'prompt', 'execution:execution')
  await host.drain()
  await proxy.history(created)
  return { proxy, session: created, journal, option, responses, link, retries, admitted: () => admitted }
}

it('retransmits the admitted response once when the Worker confirms it never reserved it after a link loss', async () => {
  const f = await workerWithPendingApproval()
  f.link.dropNextControl = true
  await expect(f.proxy.respond(f.session, 'question', f.option)).rejects.toThrow('Worker link lost')
  const command = f.admitted()!
  expect(await f.journal.controlDelivery(command)).toBeUndefined()
  expect(f.responses).toEqual([])

  const response = { nativeRequestId: 'question', nativeRequestType: 'approval', option: f.option }
  await f.proxy.reconcileResponse(f.session, response)
  await f.proxy.reconcileResponse(f.session, response)
  expect(f.responses).toEqual(['question'])
  expect(f.retries).toEqual([command])
  expect(f.link.controls).toBe(2)
  expect(await f.journal.controlDelivery(command)).toBe('acknowledged')
  const status = await f.journal.status(command.operationId)
  expect(status.status === 'known' && status.receipt.controls).toEqual([command])
})

it('only observes a response the Worker already entered after a lost acknowledgement', async () => {
  const f = await workerWithPendingApproval()
  await f.proxy.respond(f.session, 'question', f.option)
  const command = f.admitted()!
  expect(f.responses).toEqual(['question'])
  const response = { nativeRequestId: 'question', nativeRequestType: 'approval', option: f.option }
  await f.proxy.reconcileResponse(f.session, response)
  expect(f.responses).toEqual(['question'])
  expect(f.retries).toEqual([])
  expect(f.link.controls).toBe(1)
  expect(await f.journal.controlDelivery(command)).toBe('acknowledged')
})
