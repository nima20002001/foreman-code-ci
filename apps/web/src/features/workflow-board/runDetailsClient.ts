import { AgentVersionResultSchema } from '@foreman-code/contracts/management'
import { CurrentRunVersionSnapshotSchema, RepeatGraphScopeV3Schema, canonicalGraphJson,
  RunVersionDetailSchema, RunExecutionsListInputSchema, RunExecutionsPageSchema, RunExecutionGetInputSchema,
  RunExecutionDetailSchema, RunExecutionBindingsListInputSchema, RunExecutionBindingsPageSchema,
  GraphExecutionIdentitySchema, RUN_INSPECTION_LIMITS,
  type RunExecutionDetail, type RunExecutionSummary, type RunExecutionsListInput, type WorkflowVersionV3,
  sameWorkflowValue, type RepeatGraphScopeV3, type RepeatGraphCurrentV3, type CurrentRunDetails } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type RequestOptions } from '../../shared/api/client'
import { readBoardRun, scopeForBoardRun } from './client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
const part = encodeURIComponent
const invalid = (message: string) => new ApiError({ code: 'INVALID_RESPONSE', message })

export async function readPinnedRun(scope: RepeatGraphScopeV3, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  const detail = await readBoardRun(scope.workspaceId, scope.workflowId, scope.runId, options)
  if (!sameWorkflowValue(scopeForBoardRun(detail.run), scope)) throw invalid('Run details changed the selected immutable version pins.')
  return detail
}
export async function readPinnedRunVersion(scope: RepeatGraphScopeV3, detail: CurrentRunDetails, options?: RequestOptions) {
  assertInspectionScope(scope, scopeForBoardRun(detail.run))
  const { version } = await readRunInspectionVersion(scope, options)
  CurrentRunVersionSnapshotSchema.parse({ run: detail.run, version })
  const configurations = await Promise.all(Object.entries(version.agentConfigurationVersionIds).map(([agentId, versionId]) =>
    readPinnedAgentVersion(scope.workspaceId, agentId, versionId, options)))
  return { version, configurations }
}
export async function readPinnedAgentVersion(workspaceId: string, agentId: string, versionId: string, options?: RequestOptions) {
  const result = await apiClient.request(`/api/management/workspaces/${part(workspaceId)}/agents/${part(agentId)}/versions/${part(versionId)}`,
    AgentVersionResultSchema, options)
  if (result.version.id !== versionId || result.version.agentId !== agentId || result.version.workspaceId !== workspaceId) throw invalid('Configuration detail returned a different immutable Agent pin.')
  return result.version
}
export async function digestCurrentValue(value: unknown, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const input = new TextEncoder().encode(canonicalGraphJson(value, maxBytes))
  const digest = await crypto.subtle.digest('SHA-256', input)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}
/** Private details can be read after a newer cut. Match exact identities and immutable
 * input/result digests; never substitute those mutable lifecycle fields for the cut. */
export async function verifyRunExecutionDetails(snapshot: RepeatGraphCurrentV3, detail: CurrentRunDetails) {
  if (!sameWorkflowValue(scopeForBoardRun(detail.run), snapshot.scope)) throw invalid('Run evidence is out of scope.')
  const byId = new Map(detail.executions.map((execution) => [execution.id, execution]))
  return Promise.all(snapshot.state.executions.map(async (fact) => {
    if(fact.identity.kind==='job')return {fact,execution:undefined,acceptedResult:undefined}
    const execution = byId.get(fact.identity.executionId)
    if (!execution) return { fact, execution: undefined, acceptedResult: undefined }
    if (execution.workflowNodeId !== fact.identity.workflowNodeId || execution.agentId !== fact.identity.agentId
      || execution.agentConfigurationVersionId !== fact.identity.agentConfigurationVersionId || execution.attempt !== fact.identity.attempt
      || await digestCurrentValue(execution.input) !== fact.inputDigest) throw invalid('Execution detail does not match its exact occurrence, attempt, configuration or input digest.')
    const accepted = snapshot.state.results.find((result) => result.execution.executionId === execution.id)
    if (accepted && (!sameWorkflowValue(accepted.execution, fact.identity) || !execution.result
      || await digestCurrentValue(execution.result, 64 * 1024) !== accepted.resultDigest)) throw invalid('Accepted result detail does not match its exact canonical result digest.')
    return { fact, execution, acceptedResult: accepted ? execution.result : undefined }
  }))
}

/** Inspectors use the authenticated, bounded history service, not the compact
 * current graph cut. A retired execution may be absent from that cut. */
const runPath = (scope: RepeatGraphScopeV3) =>
  `/api/management/workspaces/${part(scope.workspaceId)}/runs/${part(scope.runId)}`
export function assertInspectionScope(scope: RepeatGraphScopeV3, actual: RepeatGraphScopeV3) {
  if (scope.workspaceId !== actual.workspaceId || scope.workflowId !== actual.workflowId
    || scope.runId !== actual.runId || scope.workflowVersionId !== actual.workflowVersionId
    || scope.executionSemanticsVersion !== 3 || actual.executionSemanticsVersion !== 3) throw invalid('Inspection returned different immutable Run pins.')
}
export async function readRunInspectionVersion(scope: RepeatGraphScopeV3, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  const generation = sessionGeneration()
  const result = await apiClient.request(`${runPath(scope)}/version`, RunVersionDetailSchema, options)
  assertInspectionScope(scope, result.scope)
  if (result.version.id !== scope.workflowVersionId || result.version.workflowId !== scope.workflowId
    || result.version.workspaceId !== scope.workspaceId || result.version.executionSemanticsVersion !== 3) {
    throw invalid('The selected Run version is unavailable; the current draft is not a substitute.')
  }
  assertSession(generation)
  return result
}
export type ExecutionFilters = Pick<RunExecutionsListInput, 'workflowNodeId' | 'occurrenceId'>
export async function readRunExecutions(scope: RepeatGraphScopeV3, filters: ExecutionFilters = {}, cursor: string | null = null, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  const input = RunExecutionsListInputSchema.parse({ workspaceId: scope.workspaceId, runId: scope.runId, ...filters,
    ...(cursor !== null ? { cursor } : {}), limit: 25 })
  const query = new URLSearchParams({ limit: String(input.limit) })
  if (input.workflowNodeId) query.set('workflowNodeId', input.workflowNodeId)
  if (input.occurrenceId) query.set('occurrenceId', input.occurrenceId)
  if (input.cursor) query.set('cursor', input.cursor)
  const generation = sessionGeneration()
  const result = await apiClient.request(`${runPath(scope)}/executions?${query}`, RunExecutionsPageSchema, options)
  assertInspectionScope(scope, result.run)
  const ids = new Set<string>()
  for (const execution of result.items) {
    if (ids.has(execution.executionId) || input.workflowNodeId && execution.workflowNodeId !== input.workflowNodeId
      || input.occurrenceId && execution.occurrence?.occurrenceId !== input.occurrenceId) {
      throw invalid('Execution page does not match the selected node/occurrence filter.')
    }
    ids.add(execution.executionId)
    if (execution.occurrence) assertInspectionScope(scope, execution.occurrence.scope)
  }
  if (cursor !== null && result.pageInfo.nextCursor === cursor) throw invalid('Execution pagination did not advance.')
  assertSession(generation)
  return result
}
export async function readRunExecution(scope: RepeatGraphScopeV3, executionId: string, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  RunExecutionGetInputSchema.parse({ workspaceId: scope.workspaceId, runId: scope.runId, executionId })
  const generation = sessionGeneration()
  const result = await apiClient.request(`${runPath(scope)}/executions/${part(executionId)}`, RunExecutionDetailSchema, options)
  assertInspectionScope(scope, result.run)
  if (result.execution.executionId !== executionId) throw invalid('Execution detail changed the requested execution identity.')
  if (result.execution.occurrence) assertInspectionScope(scope, result.execution.occurrence.scope)
  if (!sameWorkflowValue(result.execution.occurrence ?? null, result.acceptedInput.value.occurrence?.identity ?? null)
    || await digestCurrentValue(result.acceptedInput.value, RUN_INSPECTION_LIMITS.inputBytes) !== result.acceptedInput.digest) {
    throw invalid('Accepted input does not match the exact occurrence or digest.')
  }
  for (const source of [...result.acceptedInput.value.predecessors, ...(result.acceptedInput.value.entry?.external ?? [])]) {
    if (source.occurrence) assertInspectionScope(scope, source.occurrence.scope)
    if (await digestCurrentValue(source.acceptedResult, RUN_INSPECTION_LIMITS.resultBytes) !== source.acceptedResultDigest) {
      throw invalid('Accepted input contains a different predecessor result digest.')
    }
  }
  const carry = result.acceptedInput.value.entry?.carry
  if (carry) {
    assertInspectionScope(scope, carry.execution.occurrence.scope)
    if (await digestCurrentValue(carry.acceptedResult, RUN_INSPECTION_LIMITS.resultBytes) !== carry.acceptedResultDigest) {
      throw invalid('Accepted input contains a different carried result digest.')
    }
  }
  if (result.execution.acceptedResultAvailable !== (result.acceptedResult.status === 'accepted')) {
    throw invalid('Execution metadata disagrees with its accepted result availability.')
  }
  if (result.acceptedResult.status === 'accepted'
    && await digestCurrentValue(result.acceptedResult.value, RUN_INSPECTION_LIMITS.resultBytes) !== result.acceptedResult.digest) {
    throw invalid('Accepted result does not match its exact digest.')
  }
  assertSession(generation)
  return result
}
/** Schema validation is not enough to prove that an execution belongs to this
 * saved node and configuration. Never label a current draft Agent as historical. */
export function assertExecutionVersion(version: WorkflowVersionV3, execution: RunExecutionSummary) {
  const node = version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
  const occurrence = execution.occurrence
  const block = version.definition.repeat?.blocks.find((item) => item.nodeIds.includes(execution.workflowNodeId))
  const pins=execution.kind==='job'?node?.kind==='job'&&node.jobDefinitionId===execution.jobDefinitionId&&node.jobDefinitionVersionId===execution.jobDefinitionVersionId:node&&node.kind!=='job'&&node.agentId===execution.agentId&&version.agentConfigurationVersionIds[execution.agentId]===execution.agentConfigurationVersionId
  if (!pins
    || (!!block !== !!occurrence)
    || block && (!occurrence || occurrence.blockId !== block.id || occurrence.occurrenceIndex > block.maxOccurrences)) {
    throw invalid('Execution node, configuration or occurrence is not in this immutable version.')
  }
}
export async function readRunExecutionBindings(scope: RepeatGraphScopeV3, detail: RunExecutionDetail, cursor: string | null = null, options?: RequestOptions) {
  RepeatGraphScopeV3Schema.parse(scope)
  assertInspectionScope(scope, detail.run)
  const input = RunExecutionBindingsListInputSchema.parse({ workspaceId: scope.workspaceId, runId: scope.runId,
    executionId: detail.execution.executionId, ...(cursor !== null ? { cursor } : {}), limit: 10 })
  const query = new URLSearchParams({ limit: String(input.limit) })
  if (input.cursor) query.set('cursor', input.cursor)
  const generation = sessionGeneration()
  const page = await apiClient.request(`${runPath(scope)}/executions/${part(input.executionId)}/bindings?${query}`, RunExecutionBindingsPageSchema, options)
  assertInspectionScope(scope, page.scope)
  if (page.executionId !== input.executionId || page.inputDigest !== detail.acceptedInput.digest) {
    throw invalid('Bindings returned a different execution/input identity.')
  }
  const recipient = GraphExecutionIdentitySchema.parse({
    workflowNodeId: detail.execution.workflowNodeId, executionId: detail.execution.executionId,
    ...(detail.execution.kind==='job'?{kind:'job',jobDefinitionId:detail.execution.jobDefinitionId,jobDefinitionVersionId:detail.execution.jobDefinitionVersionId}:{agentId:detail.execution.agentId,agentConfigurationVersionId:detail.execution.agentConfigurationVersionId}),
    attempt: detail.execution.attempt,
  })
  const ids = new Set<string>()
  const accepted = detail.acceptedInput.value
  const sources = {
    predecessor: new Set(accepted.predecessors.map((source) => canonicalGraphJson(source, RUN_INSPECTION_LIMITS.inputBytes))),
    external: new Set((accepted.entry?.external ?? []).map((source) => canonicalGraphJson(source, RUN_INSPECTION_LIMITS.inputBytes))),
    carry: new Set(accepted.entry?.carry ? [canonicalGraphJson(accepted.entry.carry, RUN_INSPECTION_LIMITS.inputBytes)] : []),
  }
  let ordinal = -1
  for (const binding of page.items) {
    if (ids.has(binding.bindingId) || binding.ordinal <= ordinal || binding.inputDigest !== page.inputDigest
      || !sources[binding.kind].has(canonicalGraphJson(binding.source, RUN_INSPECTION_LIMITS.inputBytes))
      || !sameWorkflowValue(binding.recipient, recipient)
      || !sameWorkflowValue(binding.recipientOccurrence, detail.execution.occurrence ?? null)
      || await digestCurrentValue(binding.source.acceptedResult, RUN_INSPECTION_LIMITS.resultBytes) !== binding.source.acceptedResultDigest) {
      throw invalid('A binding does not match its exact recipient, ordinal or accepted predecessor result.')
    }
    if (binding.kind === 'carry') assertInspectionScope(scope, binding.source.execution.occurrence.scope)
    else if (binding.source.occurrence) assertInspectionScope(scope, binding.source.occurrence.scope)
    ids.add(binding.bindingId); ordinal = binding.ordinal
  }
  if (cursor !== null && page.pageInfo.nextCursor === cursor) throw invalid('Binding pagination did not advance.')
  assertSession(generation)
  return page
}
