import type { AgentFileToolService } from '../../files/tools/service.js'
import type { FileToolContext, FileToolOperation } from '../../files/tools/types.js'
import { FILE_SESSION_LEASE_MS, FILE_SESSION_RENEWAL_WINDOW_MS, isMutation } from '../../files/tools/context.js'
import { leaseFailureCause, renewOwnedLeases } from '../../leases/ownerLeases.js'
import { HarnessExecutionError } from '../errors.js'
import type { ClaudeCallbackIdentity } from './interactions.js'

/** Server-only accepted admission lookup. Native callback arguments cannot supply scope or principal. */
export interface ClaudeFileAdmission {
  current(identity: ClaudeCallbackIdentity): Promise<{ context: FileToolContext; expiresAt: Date } | undefined>
}
export class ClaudeFileBridge {
  private token: string | undefined
  private issue: Promise<string> | undefined
  private closed = false
  /** The bridge owns its file session: renewal runs while it is open and stops when it closes. */
  private readonly sessionOwner = new AbortController()
  private renewalFailure: Error | undefined
  constructor(private readonly identity: ClaudeCallbackIdentity, private readonly admission: ClaudeFileAdmission,
    private readonly service: AgentFileToolService) { this.identity = structuredClone(identity) }

  private async accepted(tool: FileToolOperation) {
    if (this.closed || (this.identity.parentToolUseId || this.identity.agentId)) throw new HarnessExecutionError('CLAUDE_FILE_CONTEXT_DENIED', 'The file bridge is closed or belongs to an unqualified child.')
    const accepted = await this.admission.current(this.identity)
    const context = accepted?.context
    const exactSubmission = this.identity.nativeTurnId
      ? context?.turnId === this.identity.nativeTurnId && context.nativeMessageId === undefined
      : this.identity.nativeMessageId && context?.nativeMessageId === this.identity.nativeMessageId && context.turnId === undefined
    if (this.closed || !exactSubmission || !accepted || !context || context.ownerPrincipalId !== this.identity.ownerPrincipalId
      || context.nativeSessionId !== this.identity.nativeSessionId
      || !context.allowedTools.includes(tool) || (isMutation(tool) && !context.allowMutation)) {
      throw new HarnessExecutionError('CLAUDE_FILE_ADMISSION_REQUIRED', 'A trusted accepted native turn and sender-bound file scope are required.')
    }
    return accepted
  }

  async call(tool: FileToolOperation, input: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted()
    const accepted = await this.accepted(tool)
    signal?.throwIfAborted()
    if (this.closed) throw new HarnessExecutionError('CLAUDE_FILE_CONTEXT_DENIED', 'The file bridge closed before issuance.')
    this.issue ??= this.service.sessions.issueForAcceptedSession(accepted.context, accepted.expiresAt).then(async (token) => {
      this.token = token
      if (this.closed) { await this.service.sessions.revoke(token); throw new HarnessExecutionError('CLAUDE_FILE_CONTEXT_DENIED', 'The file bridge closed during issuance.') }
      this.renewSession(token, Math.min(accepted.expiresAt.getTime(), this.service.clock().getTime() + FILE_SESSION_LEASE_MS))
      return token
    })
    const token = await this.issue
    if (this.renewalFailure) throw new HarnessExecutionError('CLAUDE_FILE_SESSION_RENEWAL_FAILED',
      `File tools stopped because their session could not be renewed: ${leaseFailureCause(this.renewalFailure)}`)
    signal?.throwIfAborted()
    await this.accepted(tool)
    signal?.throwIfAborted()
    // Once dispatched, the file service owns mutation completion and its commit.
    switch (tool) {
      case 'files.list': return this.service.list(token, input)
      case 'files.read': return this.service.read(token, input)
      case 'files.create_working_copy': return this.service.createWorkingCopy(token, input)
      case 'files.write_working_copy': return this.service.writeWorkingCopy(token, input)
      case 'files.apply_format_edit': return this.service.applyFormatEdit(token, input)
      case 'files.publish_result': return this.service.publish(token, input)
    }
  }
  private renewSession(token: string, initialExpiry: number): void {
    let expiresAt = initialExpiry
    void renewOwnedLeases({ signal: this.sessionOwner.signal,
      leases: [{ name: 'file-tool session', renewWithinMs: FILE_SESSION_RENEWAL_WINDOW_MS,
        remainingMs: () => expiresAt - this.service.clock().getTime(),
        renew: async () => { expiresAt = Date.parse(await this.service.sessions.renew(token)) } }],
      onFailure: error => { this.renewalFailure = error },
    })
  }
  /** Pre-ack reads remain credential-free and are available only through trusted admission. */
  async readAccepted(input: unknown): Promise<unknown> {
    return this.service.readAccepted((await this.accepted('files.read')).context, input)
  }
  async close(): Promise<void> {
    this.closed = true
    this.sessionOwner.abort()
    if (this.issue) await this.issue.catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    if (this.token) await this.service.sessions.revoke(this.token)
    this.token = undefined
    this.issue = undefined
  }
}
