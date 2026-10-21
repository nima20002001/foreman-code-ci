import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { BrowserDeviceRequestSchema, type AgentSubject } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { DEVICE_APPLICATION_IN_FLIGHT } from '@foreman-code/contracts/device-application'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceRequestQueue } from '../devices/deviceRequestQueue.js'
import type { BrowserProfileRepository, BrowserProfileTransaction } from '../browser-profiles/types.js'
import { BrowserAuthority } from './browserAuthority.js'
import { browserConnectionBinding, type MainBrowserPairing } from './browserPairing.js'
import { createMainBrowserRemote } from './browserRemote.js'

it('finishes every remote preparation when all ordinary request slots are occupied by preparations', async () => {
  const pool = new pg.Pool()
  const queue = new DeviceRequestQueue()
  const fixture = makeCurrentWorkflowFixture('browser-capacity', 'single')
  const configuration = fixture.configurations[0]!
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, connectionEpoch: randomUUID() }
  const selected = browserConnectionBinding(binding)
  const repository: BrowserProfileRepository = {
    read: async work => work({ profile: async () => ({ profile: { id: 'profile' }, deleted: false }),
      replicaFacts: async () => ({ present: true, presenceRevision: 1, currentIntent: null }) } as unknown as BrowserProfileTransaction),
    transaction: async () => { throw new Error('Readiness does not mutate the profile catalog') },
  }
  const authority = new BrowserAuthority(pool, () => binding.mainId, () => repository, () => remote.ready(binding.deviceId))
  // Saved-node/database facts and the paired carrier are external ports in this transport test.
  const details = vi.spyOn(authority, 'details').mockImplementation(async subject => ({ subject, configuration,
    browser: { enabled: true, profileId: 'profile' }, workflowVersionId: fixture.version.id, computerId: binding.deviceId, active: true, readOnly: false, tools: [] }))
  let admitAll!: () => void
  const capacity = new Promise<void>(resolve => { admitAll = resolve })
  let admitted = 0
  let statusReads = 0
  const controller = new AbortController()
  const endpoint = { captureRequest: () => ({ binding, request: async (raw: unknown) => {
    const input = BrowserDeviceRequestSchema.parse(raw)
    const release = await queue.acquire({ priority: 'foreground', stop: false, signal: controller.signal, timeoutMs: 500 })
    try {
      if (input.operation === 'runtime-status') {
        statusReads++
        return { payload: { computerId: binding.deviceId, ready: true, phase: 'ready', reason: null } }
      }
      if (input.operation !== 'prepare') throw new Error('Unexpected browser operation')
      if (++admitted === DEVICE_APPLICATION_IN_FLIGHT) admitAll()
      await capacity
      await remote.handle({ operation: 'subject', subject: input.input.subject }, { binding, signal: controller.signal })
      return { payload: { kind: 'unavailable', reason: 'resource_pressure', retryable: true } }
    } finally { release() }
  } }) } as unknown as DeviceEndpoint
  const pairing = { current: async () => selected, assertCurrent: async () => undefined,
    assertInstallation: async () => undefined } as unknown as MainBrowserPairing
  const remote: ReturnType<typeof createMainBrowserRemote> = createMainBrowserRemote({ pool, pairing, authority, endpoint: () => endpoint,
    browser: () => { throw new Error('Preparation does not read viewer state') }, reportFailure: error => { throw error } })
  try {
    const calls = Array.from({ length: DEVICE_APPLICATION_IN_FLIGHT }, (_, index) => {
      const subject: AgentSubject = { kind: 'execution', agent: { workspaceId: configuration.workspaceId,
        workflowId: fixture.scope.workflowId, workflowNodeId: fixture.version.definition.nodes[0]!.id,
        agentId: configuration.agentId, productRole: 'coder', displayName: 'Worker', configurationVersionId: configuration.id },
      execution: { runId: fixture.run.id, workflowVersionId: fixture.version.id, executionId: `execution-${index}`, attempt: 1 } }
      return remote.prepare({ subject, browser: { enabled: true, profileId: 'profile' }, computerId: binding.deviceId, commandId: randomUUID() })
    })
    const settled = await Promise.allSettled(calls)
    expect(settled.map(result => result.status)).toEqual(Array(DEVICE_APPLICATION_IN_FLIGHT).fill('fulfilled'))
    expect(statusReads).toBe(0)
    expect(queue.snapshot()).toMatchObject({ active: 0, waiting: 0 })
  } finally { controller.abort(); queue.close(new Error('Fixture closed')); remote.close(); details.mockRestore(); await pool.end() }
})
