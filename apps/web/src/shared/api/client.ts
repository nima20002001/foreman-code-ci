import { installationHeaders, reloadChangedInstallation } from './sessionBoundary'
import {
  CurrentWorkspaceDetailsSchema, CurrentGetWorkflowResponseSchema, CurrentRunDetailsSchema, CurrentManagedWorkflowCommandResultSchema, CurrentManagedWorkflowPageSchema, RunStartV3InputSchema, RunStartV3ResultSchema, CurrentWorkflowCreateInputSchema, 
  type CurrentWorkspaceDetails, type CurrentGetWorkflowResponse, type CurrentRunDetails, type CurrentWorkflowCreateInput,
} from '@foreman-code/contracts/wave25'
import {
  ApiErrorResponseSchema,
  GetInteractionResponseSchema,
  ListInteractionsRequestSchema,
  ListInteractionsResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
  ScopedMcpDetectionSchema,
  GetRunRequestSchema,
  GetWorkflowRequestSchema,
  ListAgentsRequestSchema,
  ListAgentsResponseSchema,
  ListVisibleResourcesRequestSchema,
  ListVisibleResourcesResponseSchema,
  CreateOperatorConversationRequestSchema,
  CreateOperatorConversationResponseSchema,
  ListOperatorConversationsResponseSchema,
  GetOperatorConversationResponseSchema,
  SendOperatorMessageRequestSchema,
  SendOperatorMessageResponseSchema,
  CancelOperatorTurnResponseSchema,
  CancelOperatorTurnRequestSchema,
  RespondOperatorInteractionRequestSchema,
  WorkspaceDetailsRequestSchema,
  type GetRunRequest,
  type GetWorkflowRequest,
  type ListAgentsRequest,
  type ListAgentsResponse,
  type ListVisibleResourcesRequest,
  type ListVisibleResourcesResponse,
  type OperatorConversationState,
  type WorkspaceDetailsRequest,
} from '@foreman-code/contracts'
import { z } from 'zod'
import { collectManagementPages, managementPageUrl } from './managementPaging'
import {
  assertSession, sessionGeneration, sessionSignal, sessionIsSwitching, SessionChangedError,
} from './sessionBoundary'
import {
  WorkflowReorderInputSchema, WorkflowReorderResultSchema, type WorkflowReorderInput,
  WorkspaceBatchArchiveInputSchema, WorkspaceBatchArchiveResultSchema, type WorkspaceBatchArchiveInput,
  ManagedWorkflowSchema, WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema, type WorkflowBatchArchiveInput,
  ManagedWorkspaceCommandResultSchema,
  ManagedWorkspaceSchema,
  ManagedWorkspacePageSchema,
  WorkspaceStorageFoldersPageSchema, WorkspaceStorageFolderDeleteInputSchema, WorkspaceStorageFolderDeleteResultSchema,
  type WorkspaceStorageFolderDeleteInput,
  ManagedAgentPageSchema,
  RunStopInputSchema,
  RunStopResultSchema,
  HarnessCatalogSchema,
  HarnessDefaultsUpdateInputSchema,
  HarnessDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
  WorkspaceArchiveInputSchema,
  WorkspaceCreateInputSchema,
  WorkspaceUpdateInputSchema,
  WorkspaceGetInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationSetResultSchema,
  WorkspaceLocationValidateInputSchema,
  WorkspaceLocationValidationSchema,
  WorkflowArchiveInputSchema,
  WorkflowUpdateInputSchema,
  AgentUpdateInputSchema,
  AgentMutationResultSchema,
  type AgentUpdateInput,
  type WorkspaceArchiveInput,
  type WorkspaceCreateInput,
  type WorkspaceUpdateInput,
  type WorkspaceLocationSetInput,
  type WorkspaceLocationValidateInput,
  type WorkflowArchiveInput,
  type WorkflowUpdateInput,
} from '@foreman-code/contracts/management'


export type RequestOptions = Omit<RequestInit, 'body' | 'method'> & {
  /** The client uses this signal for query cancellation and component unmounts. */
  signal?: AbortSignal
  /** Bounds both response headers and body consumption. */
  timeoutMs?: number
}

export type ApiErrorPayload = {
  code: string
  message: string
  details?: Record<string, unknown>
  requestId?: string
}

/** A normalized error for both HTTP failures and invalid API responses. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown>
  readonly requestId?: string

  constructor(payload: ApiErrorPayload, status = 0, options?: ErrorOptions) {
    super(payload.message, options)
    this.name = 'ApiError'
    this.code = payload.code
    this.status = status
    this.details = payload.details
    this.requestId = payload.requestId
  }

  static is(error: unknown): error is ApiError {
    return error instanceof ApiError
  }
}

function isGatewayStatus(status: number): boolean {
  return status === 502 || status === 503 || status === 504
}

/** The API is restarting or unreachable: no response, or a gateway status without an API error body. */
export function isApiRestartError(error: unknown): boolean {
  return ApiError.is(error)
    && (error.code === 'NETWORK_ERROR' || (error.code === 'HTTP_ERROR' && isGatewayStatus(error.status)))
}

type FetchLike = typeof fetch

export interface ApiClientOptions {
  baseUrl?: string
  fetch?: FetchLike
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
}

function describeIssues(error: z.ZodError): Record<string, unknown> {
  return { issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })) }
}

function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new ApiError({
      code: 'INVALID_REQUEST',
      message: 'The API request does not match its contract.',
      details: describeIssues(parsed.error),
    })
  }
  return parsed.data
}

function toPath(value: string): string {
  return encodeURIComponent(value)
}

function resolveRequestUrl(baseUrl: string, path: string): string {
  if (baseUrl) return `${baseUrl}${path}`
  // Browsers resolve `/api/...` relative to the current origin. Node's fetch
  // requires an absolute URL, so retain the same semantics in Vitest/SSR.
  const origin = typeof globalThis.location?.origin === 'string' ? globalThis.location.origin : 'http://localhost'
  return new URL(path, origin).toString()
}

/**
 * The only HTTP boundary used by the web app. Every successful response is
 * parsed with its contract schema before it reaches a feature/query hook.
 */
export class ApiClient {
  private readonly baseUrl: string
  private readonly fetchImpl?: FetchLike
  private runtimeCompatibility?: () => boolean

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? ''
    // Do not bind the global fetch at module construction time: the unit-test
    // interceptor starts during the setup hook after modules load.
    this.fetchImpl = options.fetch
  }

  /** Query remains the owner of build facts; the client reads them at the request boundary. */
  bindRuntimeCompatibility(check: () => boolean): () => void {
    this.runtimeCompatibility = check
    return () => { if (this.runtimeCompatibility === check) this.runtimeCompatibility = undefined }
  }

  async request<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { method?: string; body?: unknown } = {},
  ): Promise<T> {
    const { timeoutMs, ...requestOptions } = options
    if (timeoutMs === undefined) return this.readResponse(path, schema, requestOptions)
    const controller = new AbortController()
    const signal = requestOptions.signal
      ? AbortSignal.any([requestOptions.signal, controller.signal]) : controller.signal
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new ApiError({ code: 'REQUEST_TIMEOUT',
          message: 'The response timed out. Checking the original message receipt.' })
        reject(error)
        controller.abort(error)
      }, timeoutMs)
    })
    try {
      return await Promise.race([this.readResponse(path, schema, { ...requestOptions, signal }), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  private async readResponse<T>(path: string, schema: z.ZodType<T>,
    options: RequestOptions & { method?: string; body?: unknown }): Promise<T> {
    const { body, method = 'GET', headers, signal, ...init } = options
    const generation = sessionGeneration()
    const identityRead = path === '/api/runtime/identity' || path === '/api/runtime/build-identity/v1' || path === '/api/local-human'
    if (!identityRead && this.runtimeCompatibility?.() === false) {
      throw new ApiError({ code: 'APP_UPDATED', message: 'The app has updated. Your pending changes are kept until the app can reload.' }, 409)
    }
    if (sessionIsSwitching()) throw new SessionChangedError()
    const requestSignal = signal ? AbortSignal.any([signal, sessionSignal()]) : sessionSignal()
    const bootstrap = path === '/api/runtime/identity' || path === '/api/local-human'
    const requestHeaders = bootstrap ? new Headers(headers) : installationHeaders(headers)
    requestHeaders.set('Accept', 'application/json')
    if (body !== undefined) requestHeaders.set('Content-Type', 'application/json')

    let response: Response
    try {
      response = await (this.fetchImpl ?? globalThis.fetch)(resolveRequestUrl(this.baseUrl, path), {
        ...init,
        credentials: 'omit',
        method,
        headers: requestHeaders,
        signal: requestSignal,
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      // AbortError is meaningful to TanStack Query and should not be turned
      // into a retryable API failure.
      if (isAbortError(error)) throw error
      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: 'Updating — reconnecting…',
        details: { cause: error instanceof Error ? error.message : String(error) },
      }, undefined, { cause: error })
    }

    let payload: unknown = undefined
    if (response.status !== 204) {
      try {
        payload = await response.json()
      } catch {
        payload = undefined
      }
    }

    // Includes late responses from fetch implementations which ignore AbortSignal.
    assertSession(generation)
    requestSignal.throwIfAborted()
    if (!response.ok) {
      const parsedError = ApiErrorResponseSchema.safeParse(payload)
      if (parsedError.success) {
        reloadChangedInstallation(parsedError.data.error.code)
        // The API answered with its own error: a domain failure its owner shows, never a restart.
        throw new ApiError(parsedError.data.error, response.status)
      }
      throw new ApiError(
        {
          code: 'HTTP_ERROR',
          // A gateway status without an API error body means the API is restarting or unreachable.
          message: isGatewayStatus(response.status)
            ? 'Updating — reconnecting…' : `The API request failed with status ${response.status}.`,
        },
        response.status,
      )
    }

    const parsed = schema.safeParse(payload)
    if (!parsed.success) {
      throw new ApiError(
        {
          code: 'INVALID_RESPONSE',
          message: 'The API returned a response that does not match its contract.',
          details: describeIssues(parsed.error),
        },
        response.status,
      )
    }
    return parsed.data
  }

  getUserInteraction(interactionId: string, options?: RequestOptions) {
    return this.request(`/api/user/interactions/${toPath(interactionId)}`, GetInteractionResponseSchema, options)
  }

  respondToUserInteraction(input: z.infer<typeof RespondToInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondToInteractionRequestSchema, input)
    return this.request(`/api/user/interactions/${toPath(request.interactionId)}/respond`, RespondToInteractionResponseSchema,
      { ...options, method: 'POST', body: request })
  }

  archiveManagedWorkspaceBatch(input: WorkspaceBatchArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceBatchArchiveInputSchema, input)
    return this.request('/api/management/workspaces/batch-archive', WorkspaceBatchArchiveResultSchema,
      { ...options, method: 'POST', body: request })
  }

  listManagedWorkspacePage(cursor?: string, options?: RequestOptions) {
    return this.request(managementPageUrl('/api/management/workspaces', cursor, cursor ? 10 : 5), ManagedWorkspacePageSchema, options)
  }

  listWorkspaceStorageFolderPage(cursor?: string, options?: RequestOptions) {
    return this.request(managementPageUrl('/api/management/workspace-storage/folders', cursor, cursor ? 10 : 5), WorkspaceStorageFoldersPageSchema, options)
  }

  deleteWorkspaceStorageFolder(input: WorkspaceStorageFolderDeleteInput, options?: RequestOptions) {
    return this.request('/api/management/workspace-storage/folders/delete', WorkspaceStorageFolderDeleteResultSchema,
      { ...options, method: 'POST', body: parseRequest(WorkspaceStorageFolderDeleteInputSchema, input) })
  }

  getManagedWorkflow(workspaceId: string, workflowId: string, options?: RequestOptions) {
    return this.request(`/api/management/workspaces/${toPath(workspaceId)}/workflows/${toPath(workflowId)}`, ManagedWorkflowSchema, options)
  }

  listManagedWorkflowPage(workspaceId: string, cursor?: string, options?: RequestOptions) {
    return this.request(managementPageUrl(`/api/management/workspaces/${toPath(workspaceId)}/workflows`, cursor, cursor ? 10 : 5), CurrentManagedWorkflowPageSchema, options)
  }

  async reorderWorkflows(input: WorkflowReorderInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowReorderInputSchema, input)
    const result = await this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/order`,
      WorkflowReorderResultSchema,
      { ...options, method: 'PUT', body: request },
    )
    if (result.value.workspaceId !== request.workspaceId
      || result.value.workflowIds.length !== request.workflowIds.length
      || result.value.workflowIds.some((id, index) => id !== request.workflowIds[index])) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The saved workflow order did not match the request.' })
    }
    return result
  }

  archiveManagedWorkflowBatch(input: WorkflowBatchArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowBatchArchiveInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows/batch-archive`, WorkflowBatchArchiveResultSchema,
      { ...options, method: 'POST', body: request })
  }

  listManagedWorkspaces(options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl('/api/management/workspaces', cursor), ManagedWorkspacePageSchema, options,
    ), options?.signal)
  }

  getManagedWorkspace(workspaceId: string, options?: RequestOptions) {
    const request = parseRequest(WorkspaceGetInputSchema, { workspaceId })
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceSchema, options)
  }

  validateWorkspaceLocation(input: WorkspaceLocationValidateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceLocationValidateInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/location/validate`,
      WorkspaceLocationValidationSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  setWorkspaceLocation(input: WorkspaceLocationSetInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceLocationSetInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/location`,
      WorkspaceLocationSetResultSchema,
      { ...options, method: 'PUT', body: request },
    )
  }

  createManagedWorkspace(input: WorkspaceCreateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceCreateInputSchema, input)
    return this.request('/api/management/workspaces', ManagedWorkspaceCommandResultSchema, { ...options, method: 'POST', body: request })
  }

  updateManagedWorkspace(input: WorkspaceUpdateInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceUpdateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceCommandResultSchema, { ...options, method: 'PATCH', body: request })
  }

  archiveManagedWorkspace(input: WorkspaceArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkspaceArchiveInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}`, ManagedWorkspaceCommandResultSchema, { ...options, method: 'DELETE', body: request })
  }

  listManagedWorkflows(workspaceId: string, options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl(`/api/management/workspaces/${toPath(workspaceId)}/workflows`, cursor),
      CurrentManagedWorkflowPageSchema, options,
    ), options?.signal)
  }

  createManagedWorkflow(input: Omit<CurrentWorkflowCreateInput, 'executionSemanticsVersion'> & { executionSemanticsVersion?: 3 }, options?: RequestOptions) {
    const request = parseRequest(CurrentWorkflowCreateInputSchema, { executionSemanticsVersion: 3, ...input })
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows`, CurrentManagedWorkflowCommandResultSchema, { ...options, method: 'POST', body: request })
  }

  updateManagedWorkflow(input: WorkflowUpdateInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowUpdateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`, CurrentManagedWorkflowCommandResultSchema, { ...options, method: 'PATCH', body: request })
  }

  archiveManagedWorkflow(input: WorkflowArchiveInput, options?: RequestOptions) {
    const request = parseRequest(WorkflowArchiveInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`, CurrentManagedWorkflowCommandResultSchema, { ...options, method: 'DELETE', body: request })
  }

  listManagedAgents(workspaceId: string, options?: RequestOptions) {
    return collectManagementPages((cursor) => this.request(
      managementPageUrl(`/api/management/workspaces/${toPath(workspaceId)}/agents`, cursor), ManagedAgentPageSchema, options,
    ), options?.signal)
  }

  /** Revision-checked Agent edit. Creates a new Agent configuration version, like the Board save and agent_update. */
  updateManagedAgent(input: AgentUpdateInput, options?: RequestOptions) {
    const request = parseRequest(AgentUpdateInputSchema, input)
    return this.request(`/api/management/workspaces/${toPath(request.workspaceId)}/agents/${toPath(request.agentId)}`,
      AgentMutationResultSchema, { ...options, method: 'PATCH', body: request })
  }

  startManagedRun(input: z.input<typeof RunStartV3InputSchema>, options?: RequestOptions) {
    const request = parseRequest(RunStartV3InputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}/runs`,
      RunStartV3ResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  stopManagedRun(input: z.input<typeof RunStopInputSchema>, options?: RequestOptions) {
    const request = parseRequest(RunStopInputSchema, input)
    return this.request(
      `/api/management/workspaces/${toPath(request.workspaceId)}/runs/${toPath(request.runId)}/stop`,
      RunStopResultSchema,
      { ...options, method: 'POST', body: request },
    )
  }

  getManagedHarnessCatalog(options?: RequestOptions) {
    return this.request('/api/management/harnesses', HarnessCatalogSchema, options)
  }

  updateManagedHarnessDefaults(input: z.input<typeof HarnessDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(HarnessDefaultsUpdateInputSchema, input)
    return this.request('/api/management/harnesses/defaults', HarnessDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  getManagedAgentDefaults(options?: RequestOptions) {
    return this.request('/api/management/settings/agents', ManagedAgentDefaultsSchema, options)
  }

  updateManagedAgentDefaults(input: z.input<typeof AgentDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(AgentDefaultsUpdateInputSchema, input)
    return this.request('/api/management/settings/agents', AgentDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  getManagedWorkflowDefaults(options?: RequestOptions) {
    return this.request('/api/management/settings/workflows', ManagedWorkflowDefaultsSchema, options)
  }

  getScopedMcpDetection(workspaceId: string, harness: 'codex', options?: RequestOptions) {
    return this.request(
      `/api/management/workspaces/${toPath(workspaceId)}/harnesses/${harness}/mcp-detection`,
      ScopedMcpDetectionSchema,
      options,
    )
  }

  updateManagedWorkflowDefaults(input: z.input<typeof WorkflowDefaultsUpdateInputSchema>, options?: RequestOptions) {
    const request = parseRequest(WorkflowDefaultsUpdateInputSchema, input)
    return this.request('/api/management/settings/workflows', WorkflowDefaultsUpdateResultSchema, { ...options, method: 'PUT', body: request })
  }

  listInteractions(input: z.input<typeof ListInteractionsRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(ListInteractionsRequestSchema, input)
    const query = new URLSearchParams()
    if (request.cursor) query.set('cursor', request.cursor)
    query.set('limit', String(request.limit))
    if (request.workspaceId) query.set('workspaceId', request.workspaceId)
    if (request.workflowId) query.set('workflowId', request.workflowId)
    if (request.status) query.set('status', request.status)
    return this.request(`/api/management/interactions?${query.toString()}`, ListInteractionsResponseSchema, options)
  }

  getInteraction(interactionId: string, options?: RequestOptions) {
    return this.request(`/api/management/interactions/${toPath(interactionId)}`, GetInteractionResponseSchema, options)
  }

  respondToInteraction(input: z.input<typeof RespondToInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondToInteractionRequestSchema, input)
    return this.request(`/api/management/interactions/${toPath(request.interactionId)}/respond`, RespondToInteractionResponseSchema, {
      ...options, method: 'POST', body: request,
    })
  }

  getWorkspaceDetails(input: WorkspaceDetailsRequest, options?: RequestOptions) {
    const request = parseRequest(WorkspaceDetailsRequestSchema, input)
    return this.request<CurrentWorkspaceDetails>(
      `/api/workspaces/${toPath(request.workspaceId)}`,
      CurrentWorkspaceDetailsSchema,
      options,
    )
  }

  getWorkspace(input: WorkspaceDetailsRequest, options?: RequestOptions) {
    return this.getWorkspaceDetails(input, options)
  }

  listAgents(input: ListAgentsRequest, options?: RequestOptions) {
    const request = parseRequest(ListAgentsRequestSchema, input)
    return this.request<ListAgentsResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/agents`,
      ListAgentsResponseSchema,
      options,
    )
  }

  getWorkflow(input: GetWorkflowRequest, options?: RequestOptions) {
    const request = parseRequest(GetWorkflowRequestSchema, input)
    return this.request<CurrentGetWorkflowResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/workflows/${toPath(request.workflowId)}`,
      CurrentGetWorkflowResponseSchema,
      options,
    )
  }

  getRun(input: GetRunRequest, options?: RequestOptions) {
    const request = parseRequest(GetRunRequestSchema, input)
    return this.request<CurrentRunDetails>(
      `/api/workspaces/${toPath(request.workspaceId)}/runs/${toPath(request.runId)}`,
      CurrentRunDetailsSchema,
      options,
    )
  }

  listOperatorConversations(options?: RequestOptions) {
    return this.request('/api/operator/conversations', ListOperatorConversationsResponseSchema, options)
  }

  createOperatorConversation(input: z.input<typeof CreateOperatorConversationRequestSchema> = {}, options?: RequestOptions) {
    const request = parseRequest(CreateOperatorConversationRequestSchema, input)
    return this.request('/api/operator/conversations', CreateOperatorConversationResponseSchema, { ...options, method: 'POST', body: request })
  }

  getOperatorConversation(conversationId: string, options?: RequestOptions): Promise<OperatorConversationState> {
    return this.request(`/api/operator/conversations/${toPath(conversationId)}`, GetOperatorConversationResponseSchema, options)
  }

  sendOperatorMessage(conversationId: string, input: unknown, options?: RequestOptions) {
    const request = parseRequest(SendOperatorMessageRequestSchema, input)
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/messages`, SendOperatorMessageResponseSchema, { timeoutMs: 30_000, ...options, method: 'POST', body: request })
  }

  cancelOperatorTurn(conversationId: string, requestId: string, options?: RequestOptions) {
    const request = parseRequest(CancelOperatorTurnRequestSchema, { requestId })
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/cancel`, CancelOperatorTurnResponseSchema, { ...options, method: 'POST', body: request })
  }

  respondOperatorInteraction(conversationId: string, input: z.infer<typeof RespondOperatorInteractionRequestSchema>, options?: RequestOptions) {
    const request = parseRequest(RespondOperatorInteractionRequestSchema, input)
    return this.request(`/api/operator/conversations/${toPath(conversationId)}/responses`, CancelOperatorTurnResponseSchema, { ...options, method: 'POST', body: request })
  }

  listVisibleResources(input: ListVisibleResourcesRequest, options?: RequestOptions) {
    const request = parseRequest(ListVisibleResourcesRequestSchema, input)
    return this.request<ListVisibleResourcesResponse>(
      `/api/workspaces/${toPath(request.workspaceId)}/resources`,
      ListVisibleResourcesResponseSchema,
      options,
    )
  }
}

export const apiClient = new ApiClient()

export const getWorkspaceDetails = apiClient.getWorkspaceDetails.bind(apiClient)
export const getWorkspace = apiClient.getWorkspace.bind(apiClient)
export const listAgents = apiClient.listAgents.bind(apiClient)
export const getWorkflow = apiClient.getWorkflow.bind(apiClient)
export const getRun = apiClient.getRun.bind(apiClient)
export const listOperatorConversations = apiClient.listOperatorConversations.bind(apiClient)
export const createOperatorConversation = apiClient.createOperatorConversation.bind(apiClient)
export const getOperatorConversation = apiClient.getOperatorConversation.bind(apiClient)
export const sendOperatorMessage = apiClient.sendOperatorMessage.bind(apiClient)
export const cancelOperatorTurn = apiClient.cancelOperatorTurn.bind(apiClient)
export const respondOperatorInteraction = apiClient.respondOperatorInteraction.bind(apiClient)
export const listVisibleResources = apiClient.listVisibleResources.bind(apiClient)
export const listManagedWorkspaces = apiClient.listManagedWorkspaces.bind(apiClient)
export const getManagedWorkspace = apiClient.getManagedWorkspace.bind(apiClient)
export const validateWorkspaceLocation = apiClient.validateWorkspaceLocation.bind(apiClient)
export const setWorkspaceLocation = apiClient.setWorkspaceLocation.bind(apiClient)
export const createManagedWorkspace = apiClient.createManagedWorkspace.bind(apiClient)
export const updateManagedWorkspace = apiClient.updateManagedWorkspace.bind(apiClient)
export const archiveManagedWorkspace = apiClient.archiveManagedWorkspace.bind(apiClient)
export const listManagedWorkflows = apiClient.listManagedWorkflows.bind(apiClient)
export const createManagedWorkflow = apiClient.createManagedWorkflow.bind(apiClient)
export const updateManagedWorkflow = apiClient.updateManagedWorkflow.bind(apiClient)
export const archiveManagedWorkflow = apiClient.archiveManagedWorkflow.bind(apiClient)
export const listManagedAgents = apiClient.listManagedAgents.bind(apiClient)
export const updateManagedAgent = apiClient.updateManagedAgent.bind(apiClient)
export const startManagedRun = apiClient.startManagedRun.bind(apiClient)
export const stopManagedRun = apiClient.stopManagedRun.bind(apiClient)
export const getManagedHarnessCatalog = apiClient.getManagedHarnessCatalog.bind(apiClient)
export const updateManagedHarnessDefaults = apiClient.updateManagedHarnessDefaults.bind(apiClient)
export const getManagedAgentDefaults = apiClient.getManagedAgentDefaults.bind(apiClient)
export const updateManagedAgentDefaults = apiClient.updateManagedAgentDefaults.bind(apiClient)
export const getManagedWorkflowDefaults = apiClient.getManagedWorkflowDefaults.bind(apiClient)
export const updateManagedWorkflowDefaults = apiClient.updateManagedWorkflowDefaults.bind(apiClient)
export const getScopedMcpDetection = apiClient.getScopedMcpDetection.bind(apiClient)
export const listInteractions = apiClient.listInteractions.bind(apiClient)
export const getInteraction = apiClient.getInteraction.bind(apiClient)
export const respondToInteraction = apiClient.respondToInteraction.bind(apiClient)
