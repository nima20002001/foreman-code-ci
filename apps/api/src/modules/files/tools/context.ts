import { createHash, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { TemporaryFileScopeSchema } from '@foreman-code/contracts/files'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

import { DomainError } from '../../errors.js'
import type { FileAccess, FileConversation, FileConversationAuthorization } from '../authorization.js'
import { fileScopeIdentity } from '../requests.js'
import { ALL_FILE_TOOL_NAMES, type AuthorizedFileCaller, type FileToolContext, type FileToolOperation, type FileToolRepository } from './types.js'

export const FileToolContextSchema = z.object({
  ownerPrincipalId: z.string().min(1), scope: TemporaryFileScopeSchema,
  nativeSessionId: z.string().min(1).max(500), turnId: z.string().min(1).max(500).optional(),
  nativeMessageId: z.string().min(1).max(500).optional(),
  messageId: z.string().min(1).max(500).optional(), allowMutation: z.boolean(),
  allowedTools: z.array(z.enum(ALL_FILE_TOOL_NAMES)).max(ALL_FILE_TOOL_NAMES.length),
}).strict().refine((value) => (value.turnId !== undefined) !== (value.nativeMessageId !== undefined),
  { message: 'Exactly one observed native turn or message identity is required.' })
export const digest = (value: string) => createHash('sha256').update(value).digest('hex')
export function bindingIdentity(context: FileToolContext): string {
  if (context.nativeMessageId) return digest(JSON.stringify(['native-message', context.ownerPrincipalId,
    fileScopeIdentity(context.scope), context.nativeSessionId, context.nativeMessageId, context.messageId ?? null]))
  return digest(JSON.stringify([context.ownerPrincipalId, fileScopeIdentity(context.scope),
    context.nativeSessionId, context.turnId, context.messageId ?? null]))
}
export function targetOf(context: FileToolContext): FileConversation {
  const chat = context.scope.chat
  return chat.kind === 'operator' ? { kind: 'operator', conversationId: chat.conversationId }
    : { kind: 'agent', workspaceId: chat.workspaceId, conversationId: chat.conversationId }
}
export function isMutation(tool: FileToolOperation): boolean {
  return tool === 'files.create_working_copy' || tool === 'files.publish_result'
    || tool === 'files.write_working_copy' || tool === 'files.apply_format_edit'
}

/** A file session lives this long unless its owning native turn renews it; nothing caps a live turn. */
export const FILE_SESSION_LEASE_MS = 15 * 60_000
export const FILE_SESSION_RENEWAL_WINDOW_MS = 5 * 60_000

export class FileToolSessions {
  constructor(private readonly repository: FileToolRepository,
    private readonly currentOwner: (id: string) => Promise<ManagementPrincipal>,
    private readonly authorization: FileConversationAuthorization,
    private readonly clock: () => Date = () => new Date()) {}

  private async current(context: FileToolContext, access: FileAccess): Promise<AuthorizedFileCaller> {
    const principal = await this.currentOwner(context.ownerPrincipalId)
    if (principal.id !== context.ownerPrincipalId || principal.revokedAt || Date.parse(principal.expiresAt) <= this.clock().getTime()) {
      throw new DomainError('FILE_SESSION_REVOKED', 'The file session owner is no longer authorized.', 401)
    }
    const scope = await this.authorization.resolve(principal, targetOf(context), access)
    if (fileScopeIdentity(scope) !== fileScopeIdentity(context.scope)) {
      throw new DomainError('FILE_CONTEXT_DENIED', 'The file session no longer matches its conversation lineage.', 403)
    }
    return { context, principal, binding: bindingIdentity(context) }
  }

  /** Server-only pre-ack authority; no credential is issued or accepted from a caller. */
  authorizeAccepted(binding: FileToolContext, tool?: FileToolOperation): Promise<AuthorizedFileCaller> {
    const context = FileToolContextSchema.parse(binding)
    if (tool && (!context.allowedTools.includes(tool) || (isMutation(tool) && !context.allowMutation))) {
      throw new DomainError('FILE_TOOL_DENIED', 'This session does not allow that file operation.', 403)
    }
    return this.current(context, tool && isMutation(tool) ? 'write' : 'read')
  }

  /** Internal issuer only. Call from the already authenticated native-session/turn admission.
   * No HTTP/MCP issuance route exists. The adapter must supply accepted harness write restrictions. */
  async issueForAcceptedSession(binding: FileToolContext, expiresAt: Date): Promise<string> {
    const context = FileToolContextSchema.parse(binding)
    const caller = await this.current(context, context.allowMutation && context.allowedTools.some(isMutation) ? 'write' : 'read')
    const expiry = Math.min(expiresAt.getTime(), Date.parse(caller.principal.expiresAt), this.clock().getTime() + FILE_SESSION_LEASE_MS)
    if (!Number.isFinite(expiry) || expiry <= this.clock().getTime()) throw new DomainError('FILE_SESSION_INVALID', 'A live file session expiry is required.', 400)
    const token = `gql_file_${randomBytes(32).toString('base64url')}`
    await this.repository.putSession(digest(token), { context, expiresAt: new Date(expiry).toISOString() })
    return token
  }

  async authenticateSharedEndpoint(token: string | undefined): Promise<AuthorizedFileCaller> {
    const caller = await this.authenticate(token)
    const session = await this.repository.session(digest(token!), this.clock().toISOString())
    if (!session) {
      throw new DomainError('FILE_SESSION_INVALID', 'This file credential belongs to a dedicated native turn.', 401)
    }
    return caller
  }

  async authenticate(token: string | undefined, tool?: FileToolOperation): Promise<AuthorizedFileCaller> {
    // Operator, worker, browser and workflow App MCP credentials are not accepted or exchanged here.
    if (!token || !/^gql_file_[A-Za-z0-9_-]{43}$/.test(token)) throw new DomainError('FILE_SESSION_REQUIRED', 'A scoped file-session credential is required.', 401)
    const session = await this.repository.session(digest(token), this.clock().toISOString())
    if (!session || Date.parse(session.expiresAt) <= this.clock().getTime()) throw new DomainError('FILE_SESSION_EXPIRED', 'The file session is expired or revoked.', 401)
    const context = FileToolContextSchema.parse(session.context)
    if (tool && (!context.allowedTools.includes(tool) || (isMutation(tool) && !context.allowMutation))) {
      throw new DomainError('FILE_TOOL_DENIED', 'This session does not allow that file operation.', 403)
    }
    return this.current(context, tool && isMutation(tool) ? 'write' : 'read')
  }
  async revoke(token: string): Promise<void> { await this.repository.revokeSession(digest(token)) }

  /** Called only by the session's owning native turn while it is live. The owner and conversation scope are
   * rechecked; a revoked or expired session stays dead. Returns the new expiry. */
  async renew(token: string): Promise<string> {
    const now = this.clock()
    const session = await this.repository.session(digest(token), now.toISOString())
    if (!session) throw new DomainError('FILE_SESSION_EXPIRED', 'The file session is expired or revoked.', 401)
    const caller = await this.current(FileToolContextSchema.parse(session.context), 'read')
    const expiry = new Date(Math.min(Date.parse(caller.principal.expiresAt), now.getTime() + FILE_SESSION_LEASE_MS)).toISOString()
    if (!await this.repository.renewSession(digest(token), expiry, now.toISOString())) {
      throw new DomainError('FILE_SESSION_EXPIRED', 'The file session is expired or revoked.', 401)
    }
    return expiry
  }

}
