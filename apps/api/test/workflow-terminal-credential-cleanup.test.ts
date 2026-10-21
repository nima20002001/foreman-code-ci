import { expect, it, vi } from 'vitest'
import { HarnessExecutionRequestSchema } from '@foreman-code/contracts'
import { DEFAULT_WORKER_CREDENTIAL_TTL_MS } from '../src/modules/access/workerCredentials.js'
import { DomainError } from '../src/modules/errors.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

it('stops workflow credential maintenance once terminal publication commits, before native closure', async () => {
  vi.useFakeTimers()
  let terminalPublished = false
  let terminalChecks = 0
  const fixture = native2Fixture(false, async () => {
    if (terminalPublished) {
      terminalChecks += 1
      throw new DomainError('AUTH_REVOKED', 'Workflow credential authority ended.', 401)
    }
  })
  try {
    fixture.installResident()
    // A fresh credential is outside its renewal window, so the heartbeat has nothing to renew.
    fixture.internals.managerCredentials.set(fixture.manager, { principalId: 'principal-native2-captured',
      expiresAt: new Date(Date.now() + DEFAULT_WORKER_CREDENTIAL_TTL_MS).toISOString(), environment: { variables: {} } })
    fixture.internals.resolveManager = () => ({ manager: fixture.manager, processState: 'resident' })
    fixture.internals.prepareEnvironment = async () => undefined
    const reconcile = fixture.manager.reconcile
    fixture.manager.reconcile = async () => {
      await vi.advanceTimersByTimeAsync(1)
      return reconcile()
    }
    const updateExecution = fixture.runs.updateExecution
    fixture.runs.updateExecution = async execution => {
      await updateExecution(execution)
      terminalPublished = execution.state === 'completed'
    }
    // Renewal stays available until the terminal commits so a rolled-back result can be corrected.
    // Let the scheduled heartbeat run once the committed result is read back and awaits disposal.
    const readExecution = fixture.store.readExecution
    let heartbeatWindow = false
    fixture.store.readExecution = async id => {
      const stored = await readExecution(id)
      if (terminalPublished && !heartbeatWindow) {
        heartbeatWindow = true
        await vi.advanceTimersByTimeAsync(20_000)
      }
      return stored
    }
    const request = HarnessExecutionRequestSchema.parse({
      executionId: fixture.get().id, runId: fixture.run.id, workspaceId: fixture.run.workspaceId,
      workflowNodeId: fixture.get().workflowNodeId, workingDirectory: fixture.get().workingDirectory,
      runtimeDirectory: fixture.get().runtimeDirectory, configuration: fixture.configuration, input: fixture.get().input,
    })
    const observed = await fixture.coordinator.observeExact({
      execution: fixture.get(), request, approval: fixture.run.approval, store: fixture.store,
      owner: fixture.owner as never, workflowId: fixture.run.workflowId, graphThreadId: fixture.run.id,
      signal: new AbortController().signal,
    })
    expect(observed.state).toBe('completed')
    expect(terminalChecks).toBe(0)
    expect(fixture.getProof()?.session).toEqual(fixture.session)
    expect(fixture.calls).toContain('revoke:principal-native2-captured')
    expect(fixture.calls).toContain(`close:${fixture.session.nativeSessionId}`)
  } finally {
    await fixture.connection.close()
    vi.useRealTimers()
  }
})
