import type { SessionControlBinding } from './binding.js'
import type { NativeSessionReference } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../../harnesses/errors.js'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import { DomainError } from '../../errors.js'

export function isNativeReadUnavailable(error: unknown, session: NativeSessionReference,
  owner: { binding: SessionControlBinding; manager: NativeHarnessSessionManager }) {
  if (session.harness === 'opencode') return true
  const unavailableCode = {
    codex: 'CODEX_SESSION_UNAVAILABLE',
    claude: 'CLAUDE_SESSION_UNAVAILABLE',
  }[session.harness]
  if (error instanceof HarnessExecutionError) return error.result.error?.code === unavailableCode
  if (error instanceof DomainError) {
    return error.code === 'NATIVE_MANAGER_DISPOSED' && owner.binding.manager !== owner.manager
  }
  return owner.binding.manager !== owner.manager
}

export async function readNativeCapabilities(binding: SessionControlBinding) {
  const { manager, session } = binding
  if (!manager || !session) return null
  try {
    return { capabilities: await manager.sessionControlCapabilities?.(session) }
  } catch (error) {
    if (isNativeReadUnavailable(error, session, { binding, manager })) return null
    throw error
  }
}

export function readNativeSnapshot(binding: SessionControlBinding) {
  const { manager, session } = binding
  if (!manager || !session) return null
  try {
    return {
      applied: manager.appliedSessionPreferences?.(session) ?? null,
      context: manager.contextSnapshot?.(session) ?? null,
    }
  } catch (error) {
    if (isNativeReadUnavailable(error, session, { binding, manager })) return null
    throw error
  }
}
