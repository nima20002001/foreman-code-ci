import { closeQualificationResources } from '../cleanup.js'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AgentFilePublishInputSchema, AgentFileReadInputSchema } from '@foreman-code/contracts/files'
import type { QualificationSuite } from '../types.js'
import type { NativeQualificationSuiteInput } from '../nativeOwnership.js'
import { protocolFromBundle } from '../../codexProtocol.js'
import { CodexStdioTransport, type RpcRequest } from '../../codexStdioTransport.js'
import { codexFileDynamicTools } from '../../codexFiles/index.js'
import { markdownReadText } from '../../../files/tools/markdownReadText.js'
import { APP_MCP_SERVER_NAME, chatExcludedAppMcpServerNames } from '../../appMcpLauncher.js'
import { runCommand } from '../../process.js'
import { inheritedAgentEnvironment } from '../../secrets.js'
import { collectChecks, modelCheck, nonempty, object, requireCondition, type Check } from './checks.js'

const bundleName = 'codex_app_server_protocol.schemas.json'
const response = (value: unknown, text?: string) => ({ success: true,
  contentItems: [{ type: 'inputText', text: JSON.stringify(value) },
    ...(text === undefined ? [] : [{ type: 'inputText', text }])],
})

export const codexQualificationSuite: QualificationSuite = {
  harness: 'codex', revision: 'codex-live-5',
  async run(input: NativeQualificationSuiteInput) {
    const signal = AbortSignal.any([input.signal, AbortSignal.timeout(240_000)])
    const environment = inheritedAgentEnvironment(input.environment)
    const evidence: Record<string, unknown> = { profile: input.profile, binarySha256: input.binarySha256, model: input.model }
    let protocol: ReturnType<typeof protocolFromBundle> | undefined
    let transport: CodexStdioTransport | undefined
    let releaseCleanup: (() => void) | undefined
    let threadId: string | undefined
    let turnId: string | undefined
    const stagedTools: RpcRequest[] = []
    const terminalStates = new Map<string, string>()
    let completed: (() => void) | undefined
    let completionFailure: ((error: Error) => void) | undefined
    let toolRead = false, toolPublished = false
    let lastText = ''
    let disabledAppMcpServerNames: string[] = []
    const marker = `QUALIFY_${randomUUID()}`
    const inputPath = join(input.workDirectory, 'qualification-source.md')
    const outputPath = join(input.workDirectory, 'qualification-result.md')
    const sourceId = randomUUID(), sourceRevisionId = randomUUID(), outputId = randomUUID(), outputRevisionId = randomUUID()
    const scope = { kind: 'temporary' as const, chat: { kind: 'agent' as const, conversationId: 'qualification',
      agentId: 'qualification', workspaceId: 'qualification', workflowId: 'qualification' } }
    const now = new Date().toISOString()
    const sourceBytes = Buffer.from(`# Qualification\n\n${marker}\n`)
    const sourceFile = { fileId: sourceId, currentRevisionId: sourceRevisionId, createdAt: now,
      scope, state: 'ready' as const, retentionDurationSeconds: 3600,
      expiresAt: new Date(Date.parse(now) + 3_600_000).toISOString() }
    const sourceRevision = { fileId: sourceId, revisionId: sourceRevisionId, filename: 'qualification-source.md',
      mediaType: 'text/markdown' as const, byteSize: sourceBytes.length,
      sha256: createHash('sha256').update(sourceBytes).digest('hex'), origin: 'upload' as const, createdAt: now }
    const runCommandChecked = async (args: string[]) => {
      await input.assertInstallation?.(signal)
      const result = await runCommand(input.binary, args, input.workDirectory, signal, environment,
        input.processRecovery ? { recovery: input.processRecovery } : {})
      requireCondition(result.exitCode === 0, `${args.join(' ')} failed.`)
      return result.stdout || result.stderr
    }
    const terminal = async (text: string) => {
      requireCondition(transport && threadId, 'Codex thread is unavailable.')
      turnId = undefined
      const done = new Promise<void>((resolve, reject) => { completed = resolve; completionFailure = reject })
      const result = object(await transport.request('turn/start', {
        threadId, clientUserMessageId: randomUUID(),
        input: [{ type: 'text', text, text_elements: [] }],
      }, signal))
      turnId = nonempty(object(result.turn).id, 'turn ID')
      for (const request of stagedTools.splice(0)) await handleTool(request)
      const early = terminalStates.get(turnId)
      if (early === 'completed') completed?.()
      else if (early) completionFailure?.(new Error('Native turn failed.'))
      await Promise.race([done, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))])
      completed = undefined; completionFailure = undefined
      return turnId
    }
    const handleTool = async (request: RpcRequest) => {
      requireCondition(transport, 'Transport is unavailable.')
      if (request.method !== 'item/tool/call') { await transport.reject(request.id, -32601, 'Unsupported qualification interaction.'); return }
      const params = object(request.params)
      const args = object(params.arguments)
      requireCondition(params.threadId === threadId && params.turnId === turnId, 'Tool call belongs to another turn.')
      if (params.tool === 'files_read') {
        const fileInput = AgentFileReadInputSchema.parse(args)
        requireCondition(fileInput.fileId === sourceId && fileInput.revisionId === sourceRevisionId, 'Wrong source pin.')
        const source = await readFile(inputPath)
        requireCondition(source.equals(sourceBytes), 'Fixture Markdown changed.')
        const bytes = source.subarray(fileInput.offset, fileInput.offset + fileInput.length)
        toolRead = true
        const result = { status: 'ready' as const, file: sourceFile, revision: sourceRevision,
          readAt: new Date().toISOString(), offset: fileInput.offset, byteLength: bytes.length,
          contentBase64: bytes.toString('base64'), eof: fileInput.offset + bytes.length === source.length }
        await transport.respond(request.id, request.method, response(result, markdownReadText(result)))
      } else if (params.tool === 'files_publish_result' && toolRead) {
        const fileInput = AgentFilePublishInputSchema.parse(args)
        requireCondition(fileInput.artifactId === 'qualification-result' && fileInput.filename === 'qualification-result.md'
          && fileInput.mediaType === 'text/markdown' && JSON.stringify(fileInput.scope) === JSON.stringify(scope),
        'Wrong publication target.')
        const bytes = await readFile(outputPath, 'utf8')
        requireCondition(bytes.includes(marker) && bytes.includes('QUALIFIED'), 'Edited Markdown was not published.')
        toolPublished = true
        const createdAt = new Date().toISOString()
        await transport.respond(request.id, request.method, response({ value: {
          file: { fileId: outputId, currentRevisionId: outputRevisionId, createdAt, scope,
            state: 'ready', retentionDurationSeconds: 3600, expiresAt: new Date(Date.parse(createdAt) + 3_600_000).toISOString() },
          revision: { fileId: outputId, revisionId: outputRevisionId, filename: 'qualification-result.md',
            mediaType: 'text/markdown', byteSize: Buffer.byteLength(bytes),
            sha256: createHash('sha256').update(bytes).digest('hex'), origin: 'agent_output', createdAt },
        }, replayed: false }))
      } else await transport.reject(request.id, -32602, 'Invalid qualification file call.')
    }
    const createThread = async () => {
      requireCondition(transport, 'Transport is unavailable.')
      const started = object(await transport.request('thread/start', {
        cwd: input.workDirectory, runtimeWorkspaceRoots: [input.workDirectory], sandbox: 'workspace-write',
        approvalPolicy: 'never', ephemeral: false, ...(input.model ? { model: input.model } : {}),
        config: { ...(input.reasoningEffort ? { model_reasoning_effort: input.reasoningEffort } : {}),
          ...Object.fromEntries(disabledAppMcpServerNames.map((name) => [`mcp_servers.${name}.enabled`, false])),
          sandbox_workspace_write: { writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true } },
        dynamicTools: codexFileDynamicTools({ allowedTools: () => ['files.read', 'files.publish_result'] }),
      }, signal))
      const thread = object(started.thread)
      threadId = nonempty(thread.id, 'thread ID')
      evidence.threadId = threadId
      if (typeof started.model === 'string' && started.model) evidence.modelUsed = started.model
    }
    const checks: Check[] = [
      ['binary-sha256', async () => {
        const actual = createHash('sha256').update(await readFile(input.binary)).digest('hex')
        requireCondition(actual === input.binarySha256, 'Codex binary SHA-256 differs from the requested candidate.')
        return actual
      }],
      ['version', async () => {
        const version = (await runCommandChecked(['--version'])).trim()
        requireCondition(version === `codex-cli ${input.version}`, 'Installed Codex version differs from the requested version.')
        evidence.version = version
        return version
      }],
      ['schema', async () => {
        const schemaDir = join(input.workDirectory, 'codex-schema')
        await runCommandChecked(['app-server', 'generate-json-schema', '--experimental', '--out', schemaDir])
        const bytes = await readFile(join(schemaDir, bundleName))
        protocol = protocolFromBundle(object(JSON.parse(bytes.toString('utf8'))))
        evidence.schemaSha256 = createHash('sha256').update(bytes).digest('hex')
        return `Generated protocol bundle ${String(evidence.schemaSha256)}`
      }],
      ['thread-start', async () => {
        requireCondition(protocol, 'Schema check did not produce a protocol.')
        await input.assertInstallation?.(signal)
        const listed = await runCommand(input.binary, ['mcp', 'list', '--json'], input.workDirectory, signal, environment,
          input.processRecovery ? { recovery: input.processRecovery } : {})
        let entries: unknown
        try { entries = JSON.parse(listed.stdout) } catch { entries = undefined }
        requireCondition(listed.exitCode === 0 && Array.isArray(entries) && entries.length <= 500
          && entries.every((entry: unknown) => typeof object(entry).name === 'string'),
        'Codex MCP configuration inspection failed; absence was not established.')
        const configuredNames = new Set(entries.map((entry: { name: string }) => entry.name))
        disabledAppMcpServerNames = chatExcludedAppMcpServerNames(APP_MCP_SERVER_NAME)
          .filter((name) => configuredNames.has(name))
        transport = new CodexStdioTransport(input.binary, input.workDirectory, environment, protocol,
          async (request: RpcRequest) => {
            if (!turnId && request.method === 'item/tool/call') { stagedTools.push(request); return }
            await handleTool(request)
          },
          (method, params) => {
            if (method === 'item/completed' && params.threadId === threadId) {
              const item = object(params.item)
              if (item.type === 'agentMessage' && typeof item.text === 'string') lastText = item.text
            }
            if (method === 'turn/completed' && params.threadId === threadId) {
              const turn = object(params.turn)
              const id = nonempty(turn.id, 'turn ID')
              const status = nonempty(turn.status, 'turn status')
              terminalStates.set(id, status)
              if (id === turnId) {
                if (status === 'completed') completed?.()
                else completionFailure?.(new Error('Native turn failed.'))
              }
            }
          }, (error) => completionFailure?.(error), 30_000, input.processRecovery, disabledAppMcpServerNames)
        releaseCleanup = input.ownCleanup?.(() => transport!.close())
        await input.assertInstallation?.(signal)
        await transport.start(signal)
        await input.assertInstallation?.(signal)
        await createThread()
        return 'Native thread started.'
      }],
      ['text-turn', () => modelCheck('text-turn', signal, evidence, async (attempt) => {
        if (attempt === 2) await createThread()
        lastText = ''
        await terminal('Reply with a short sentence confirming this qualification text turn. Do not call tools.')
        requireCondition(lastText.trim(), 'Native turn completed without an assistant text message.')
        return 'Native assistant text message completed.'
      })],
      ['file-tools', async () => {
        await writeFile(inputPath, sourceBytes, { flag: 'wx', mode: 0o400 })
        return modelCheck('file-tools', signal, evidence, async (attempt) => {
          if (attempt === 2) await createThread()
          toolRead = false; toolPublished = false
          await terminal(`Call files_read with fileId ${sourceId} and revisionId ${sourceRevisionId} to read the Markdown marker. Write ${JSON.stringify(outputPath)} as Markdown containing that marker and the word QUALIFIED. Then call files_publish_result with artifactId qualification-result, commandId ${randomUUID()}, filename qualification-result.md, mediaType text/markdown, and scope ${JSON.stringify(scope)}. Do not use shell commands or access other paths.`)
          requireCondition(toolRead && toolPublished, 'Native turn did not read and publish through both dynamic tools.')
          return 'Dynamic read and publish callbacks completed.'
        })
      }],
      ['thread-resume', async () => {
        requireCondition(transport && threadId, 'Codex thread is unavailable.')
        const resumed = object(await transport.request('thread/resume', {
          threadId, cwd: input.workDirectory, sandbox: 'workspace-write', approvalPolicy: 'never',
          excludeTurns: true, ...(input.model ? { model: input.model } : {}),
        }, signal))
        requireCondition(object(resumed.thread).id === threadId, 'Resumed thread identity changed.')
        return 'Native thread resumed.'
      }],
    ]
    try { return await collectChecks({ ...input, signal }, checks, evidence) }
    finally { await closeQualificationResources(transport ? [{ close: () => transport!.close(), release: releaseCleanup }] : []) }
  },
}
