import type { CodexHarnessConfiguration } from '@foreman-code/contracts'
import { HarnessExecutionError } from '../errors.js'
import type { FileToolOperation } from '../../files/tools/types.js'
import { codexFileDynamicTools } from './index.js'
import { harnessProfile } from '../qualification/profiles.js'

export function codexChatFileTools(configuration: CodexHarnessConfiguration): FileToolOperation[] {
  // A declaration is not a grant. The bridge checks the narrower accepted
  // allowlist on every operation, and FIL-05 reauthorizes the owner as well.
  return configuration.sandbox === 'read-only'
    ? ['files.list', 'files.read']
    : ['files.list', 'files.read', 'files.create_working_copy', 'files.publish_result',
      'files.write_working_copy', 'files.apply_format_edit']
}

/** Both Codex profiles use type: 'function' for dynamic tools. */
export function codexChatFileDeclarations(configuration: CodexHarnessConfiguration, providerVersion: string) {
  const profile = harnessProfile('codex', providerVersion)
  if (profile !== 'codex-0.154' && profile !== 'codex-0.156') {
    throw new HarnessExecutionError('CODEX_FILE_PROTOCOL_UNQUALIFIED', 'File tools require a qualified native dynamic-tool schema.')
  }
  return codexFileDynamicTools({ allowedTools: () => codexChatFileTools(configuration) })
}
