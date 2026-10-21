/** Synthetic schemas test the diagnostic itself; they are not provider qualification evidence. */
export function codexSchema() {
  const methods = ['initialize', 'thread/start', 'thread/resume', 'thread/read', 'thread/turns/list', 'thread/items/list', 'turn/start', 'turn/interrupt', 'turn/steer', 'thread/fork', 'config/read', 'model/list', 'config/batchWrite', 'mcpServerStatus/list', 'account/login/start', 'account/login/cancel']
  const serverMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'item/tool/requestUserInput', 'mcpServer/elicitation/request']
  const responses = ['InitializeResponse', 'ThreadStartResponse', 'ThreadResumeResponse', 'ThreadReadResponse', 'ThreadTurnsListResponse', 'ThreadItemsListResponse', 'TurnStartResponse', 'TurnInterruptResponse', 'TurnSteerResponse', 'ThreadForkResponse', 'ConfigReadResponse', 'ModelListResponse', 'ConfigWriteResponse', 'ListMcpServerStatusResponse', 'LoginAccountResponse', 'CancelLoginAccountResponse', 'CommandExecutionRequestApprovalResponse', 'FileChangeRequestApprovalResponse', 'PermissionsRequestApprovalResponse', 'ToolRequestUserInputResponse', 'McpServerElicitationRequestResponse']
  const branch = (method: string) => ({ type: 'object', properties: {
    method: { const: method }, id: { type: 'integer' },
    params: method === 'thread/start' ? { $ref: '#/definitions/v2/ThreadStartParams' } : { type: 'object' },
  }, required: ['method'] })
  const start = { type: 'object', properties: {
    model: { type: 'string' }, cwd: { type: 'string' }, ephemeral: { type: 'boolean' }, config: { type: 'object' },
    serviceTier: { type: ['string', 'null'] },
    sandbox: { type: 'string', enum: ['read-only', 'workspace-write', 'danger-full-access'] },
    approvalPolicy: { type: 'string', enum: ['on-request', 'never'] },
    approvalsReviewer: { type: 'string', enum: ['user', 'auto_review'] },
  } }
  const threadResponse = { type: 'object', required: ['thread', 'model', 'modelProvider', 'cwd', 'sandbox', 'approvalPolicy', 'approvalsReviewer', 'reasoningEffort', 'serviceTier'], properties: {
    thread: { $ref: '#/definitions/v2/Thread' }, model: { type: 'string' }, modelProvider: { type: 'string' },
    reasoningEffort: { type: ['string', 'null'] }, serviceTier: { type: ['string', 'null'] }, cwd: { type: 'string' },
    sandbox: { type: 'object' }, approvalPolicy: { type: 'string' }, approvalsReviewer: { type: 'string' },
  } }
  return { $schema: 'http://json-schema.org/draft-07/schema#', definitions: {
    ClientRequest: { oneOf: methods.map(branch) }, ServerRequest: { oneOf: serverMethods.map(branch) },
    ServerNotification: { oneOf: ['turn/started', 'turn/completed', 'item/started', 'item/completed', 'serverRequest/resolved'].map(branch) },
    v2: { ...Object.fromEntries(responses.map((name) => [name, { type: 'object' }])), ThreadStartParams: start,
      ThreadStartResponse: threadResponse, ThreadResumeResponse: threadResponse, ThreadForkResponse: threadResponse,
      ThreadReadResponse: { type: 'object', required: ['thread'], properties: { thread: { $ref: '#/definitions/v2/Thread' } } },
      ...Object.fromEntries(['ThreadTurnsListResponse', 'ThreadItemsListResponse', 'ModelListResponse', 'ListMcpServerStatusResponse'].map(name =>
        [name, { type: 'object', required: ['data'], properties: { data: { type: 'array', items: { type: 'object' } }, nextCursor: { type: ['string', 'null'] } } }])),
      InitializeResponse: { type: 'object', required: ['userAgent'], properties: { userAgent: { type: 'string' } } },
      ConfigReadResponse: { type: 'object', required: ['config'], properties: { config: { type: 'object' } } },
      ConfigWriteResponse: { type: 'object', required: ['status', 'version'], properties: { status: { type: 'string' }, version: { type: 'string' } } },
      TurnSteerResponse: { type: 'object', required: ['turnId'], properties: { turnId: { type: 'string' } } },
      CancelLoginAccountResponse: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } },
      Thread: { type: 'object', required: ['id', 'turns'], properties: { id: { type: 'string' }, turns: { type: 'array', items: { type: 'object' } } } },
      TurnStartResponse: { type: 'object', required: ['turn'], properties: { turn: { type: 'object' } } },
    },
  } }
}
