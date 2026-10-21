import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type ExecutionResult } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { DomainError } from '../errors.js'
import type { RunOwnership } from '../runs/ownership.js'
import { repeatDigest } from '../runs/repeatResolution.js'
import { ApprovalExecutionCoordinator } from './execution.js'
import type { RepeatNativeObservationStore } from './repeatObservation.js'

it.each([
  { error: new Error('Connection terminated due to connection timeout'), code: 'EXECUTION_START_INTERRUPTED' },
  { error: new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Native creation is uncertain.', 503),
    code: 'NATIVE_SESSION_START_UNCERTAIN' },
])('records $code when native creation fails before a session is saved', async ({ error, code }) => {
  const f = makeCurrentWorkflowFixture('startup-failure', 'single')
  const configuration = f.configurations[0]!
  let execution = HarnessExecutionSchema.parse({
    id: 'startup-execution', runId: f.run.id, workflowNodeId: f.version.entryNodeId,
    agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
    attempt: 1, state: 'starting', input: {}, createdAt: f.createdAt,
    workingDirectory: '/project', runtimeDirectory: '/runtime',
  })
  const owner = { runId: f.run.id, assertOwned: vi.fn() } as unknown as RunOwnership
  let failure: ExecutionResult | undefined
  const recordExecutionFailure = vi.fn(async (_owner: RunOwnership, _id: string, result: ExecutionResult) => {
    failure = result
  })
  const store = {
    readExecution: async () => ({ execution, input: execution.input, inputDigest: repeatDigest(execution.input),
      accepted: false, ref: { nodeId: execution.workflowNodeId, occurrence: null }, slotId: 'startup-slot' }),
    assertExecutionAdmission: async () => {}, assertNativeBoundary: async () => {},
    authorizeNativeSubmission: vi.fn(async () => {}), consumeLaunch: () => true,
    settleNegativeExecution: vi.fn(async () => {
      execution = HarnessExecutionSchema.parse({ ...execution, state: 'completed', result: failure, finishedAt: f.createdAt })
    }),
  }
  const createSession = vi.fn(async () => { throw error })
  const dispose = vi.fn(async () => {})
  const requestCleanup = vi.fn(async () => {})
  type Args = ConstructorParameters<typeof ApprovalExecutionCoordinator>
  const coordinator = new ApprovalExecutionCoordinator({
    repeat: async () => store, recordExecutionFailure, requestCleanup,
  } as unknown as Args[0], {
    coordination: nativeLanes(),
  } as unknown as Args[1], {
    ensure: async () => {}, resume: async () => {}, remaining: async () => 60_000, stop: async () => {},
  } as unknown as Args[2], {
    resolve: () => ({ manager: { harness: configuration.harness.harness, createSession, dispose },
      processState: 'needs_start' }),
  } as unknown as Args[3], 60_000, undefined, undefined, {
    begin: async () => '1', recordUnbound: async () => ({ durableGeneration: '1' }),
  } as unknown as Args[7])

  await expect(coordinator.observeExact({
    execution, owner, workflowId: f.run.workflowId, graphThreadId: f.run.id,
    approval: f.run.approval, signal: new AbortController().signal,
    request: { executionId: execution.id, runId: f.run.id, workspaceId: f.run.workspaceId,
      workflowNodeId: execution.workflowNodeId, configuration, input: execution.input,
      workingDirectory: execution.workingDirectory!, runtimeDirectory: execution.runtimeDirectory! },
    store: store as unknown as RepeatNativeObservationStore,
  })).rejects.toThrow(error.message)

  expect(createSession).toHaveBeenCalledOnce()
  expect(recordExecutionFailure).toHaveBeenCalledWith(owner, execution.id, {
    outcome: 'failed', error: { code, message: error.message, retryable: true },
  })
  expect(execution.result).toMatchObject({ outcome: 'failed', error: { code, retryable: true } })
  expect(dispose).toHaveBeenCalledOnce()
  expect(store.settleNegativeExecution).toHaveBeenCalledWith(execution.id, false)
  expect(requestCleanup).not.toHaveBeenCalled()
})
