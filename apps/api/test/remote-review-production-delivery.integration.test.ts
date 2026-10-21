import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { connect as connectTcp } from 'node:net'
import { connect } from 'node:tls'
import { afterAll, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest'
import { Client } from '@modelcontextprotocol/client'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { deliveredReview, receipts, reviewInProgress, useRemoteReviewFixture,
  waitForRemoteReview } from './helpers/remoteReviewProductionCases.js'
import { createRemoteReviewTransport } from './helpers/remoteReviewTransport.js'

let diagnosticOutput: MockInstance<typeof console.info>
beforeAll(() => {
  diagnosticOutput = vi.spyOn(console, 'info')
})
const withRemoteReviewFixture = useRemoteReviewFixture()
afterAll(() => diagnosticOutput.mockRestore())

describe('production remote review and native recovery through authenticated MCP', () => {
  it('closes the review transport with an accepted TLS connection that has not upgraded', async () => {
    await withRemoteReviewFixture(async fixture => {
      const certificateFile = join(fixture.directory, 'tls', 'certificate.pem')
      const transport = await createRemoteReviewTransport({
        certificateFile,
        privateKeyFile: join(fixture.directory, 'tls', 'private-key.pem'),
        endpoint: 'wss://127.0.0.1:1/device/connect',
        beforeAuthorization: async () => {},
      })
      const endpoint = new URL(transport.endpoint)
      const socket = connect({
        host: endpoint.hostname,
        port: Number(endpoint.port),
        ca: await readFile(certificateFile),
      })
      let closing: Promise<void> | undefined
      let timeout: ReturnType<typeof setTimeout> | undefined
      let closedBeforeDisconnect: boolean
      try {
        await once(socket, 'secureConnect')
        closing = transport.close()
        closedBeforeDisconnect = await Promise.race([
          closing.then(() => true),
          new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 2_000) }),
        ])
      } finally {
        clearTimeout(timeout)
        socket.destroy()
        await (closing ?? transport.close())
      }
      expect(closedBeforeDisconnect).toBe(true)
    })
  })

  it('persists a delivered remote decision and denies a read-only caller on the same product endpoint', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      const run = SavedRunDetailsSchema.parse(await fixture.value('run_get', {
        workspaceId: active.run.workspaceId, runId: active.run.id, detail: 'full',
      }))
      expect(run.executions.find(execution => execution.id === active.reviewer.id)).toMatchObject({
        state: 'completed', result: { outcome: 'succeeded' }, nativeSessionId: active.reviewer.nativeSessionId,
      })
      expect(run.executions.find(execution => execution.id === active.requester.id)).toMatchObject({
        state: 'waiting', nativeSessionId: active.interaction.nativeSessionId,
      })
      const reader = await fixture.access.issue({ name: 'Remote review reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 300_000), grants: [{ actions: ['interactions:read'],
          scope: { runIds: [active.run.id] } }] })
      const read = await fixture.call('interaction_get', { interactionId: active.interaction.id }, reader.token)
      expect(read.isError).not.toBe(true)
      const before = await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)
      const option = active.interaction.responseOptions.find(option => option.semantic === 'approve_once')!
      const denied = await fixture.call('interaction_respond', { interactionId: active.interaction.id,
        optionId: option.optionId, expectedRevision: active.interaction.revision }, reader.token)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)).toEqual(before)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(0)
      await fixture.provider.releaseReview()
      const delivered = await deliveredReview(fixture, active.interaction.id)
      const persisted = await new PostgresInteractionRepository(fixture.db.pool).get(active.interaction.id)
      expect(persisted).toEqual(delivered.interaction)
      expect((await fixture.provider.calls()).filter(call => 'approvalResponse' in call)).toHaveLength(1)
      expect(delivered.job.nativeSessionId).toBe(active.reviewer.nativeSessionId)
      const entry = (await receipts(fixture, active.run.id)).find(receipt => receipt.intent.executionId === active.reviewer.id)!
      expect(entry.native?.sessionId).toBe(active.reviewer.nativeSessionId)
      expect(entry.reviewTurns).toContainEqual(expect.objectContaining({
        assignment: expect.objectContaining({ jobId: active.job.id, correlationId: active.job.correlationId }),
        providerId: delivered.job.providerTurnOrMessageId, settled: true,
      }))
      // Phase reporting must stay bounded while the native workflow runs.
      const output = diagnosticOutput.mock.calls.map(arguments_ => JSON.stringify(arguments_)).join('\n')
      expect(Buffer.byteLength(output)).toBeLessThan(64 * 1024)
      const completed = await waitForRemoteReview(async () => {
        await fixture.reconcileReviews()
        return fixture.details(active.run.id)
      }, details => details.run.executionState === 'completed' && details.cleanupPending !== true,
      'completed Run and native cleanup after remote decision delivery', fixture.subscribeNativeChanges)
      expect(completed.run.outcome).toBe('succeeded')
    })
  }, 240_000)

  it('closes MCP clients while Main is available and completes fixture cleanup', async () => {
    await withRemoteReviewFixture(async fixture => {
      const origin = new URL(fixture.origin())
      const idle = connectTcp({ host: origin.hostname, port: Number(origin.port) })
      await once(idle, 'connect')
      const availability: boolean[] = []
      const closeClient = Client.prototype.close
      const closingClients = vi.spyOn(Client.prototype, 'close').mockImplementation(async function (this: Client) {
        try {
          const response = await fetch(`${fixture.origin()}/health/live`)
          await response.text()
          availability.push(response.ok)
        } catch {
          // Main being unavailable is the behavior this regression detects.
          availability.push(false)
        }
        await closeClient.call(this)
      })
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const closing = fixture.close()
        const repeated = fixture.close()
        expect(repeated).toBe(closing)
        await Promise.race([
          closing,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('Remote review fixture cleanup did not complete.')), 60_000)
          }),
        ])
        expect(availability.length).toBeGreaterThanOrEqual(2)
        expect(availability.every(available => available)).toBe(true)
      } finally {
        idle.destroy()
        clearTimeout(timeout)
        closingClients.mockRestore()
      }
    })
  }, 65_000)
})
