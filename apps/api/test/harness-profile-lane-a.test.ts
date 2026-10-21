import assert from 'node:assert/strict'

import { it } from 'vitest'
import type { CodexHarnessConfiguration } from '@foreman-code/contracts'

import { codexChatFileDeclarations } from '../src/modules/harnesses/codexFiles/declarations.js'
import { forgetQualifiedProfile, rememberQualifiedProfile } from '../src/modules/harnesses/qualification/profiles.js'

import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

it('qualified Codex versions use the newest file declaration profile; unknown versions fail closed', async () => {
  const version = 'codex-cli 0.158.0'
  const configuration = { sandbox: 'read-only' } as CodexHarnessConfiguration
  assert.throws(() => codexChatFileDeclarations(configuration, version), /qualified native dynamic-tool schema/)
  assert.throws(() => new DeterministicNativeSessionManager('codex', version), /FIXTURE_PROVIDER_UNQUALIFIED/)
  rememberQualifiedProfile('codex', version, 'codex-0.156')
  try {
    assert.deepEqual(codexChatFileDeclarations(configuration, version),
      codexChatFileDeclarations(configuration, 'codex-cli 0.156.1'))
    assert.equal((await new DeterministicNativeSessionManager('codex', version).capabilities()).providerVersion, version)
  } finally { forgetQualifiedProfile('codex', version) }
})
