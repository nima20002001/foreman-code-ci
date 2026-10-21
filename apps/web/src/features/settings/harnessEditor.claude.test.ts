import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { createHarnessEditor, prepareHarnessEditor, switchHarnessEditor } from './harnessEditor'
import { selectNativeModel } from './harnessModelSelection'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

it('round-trips accepted Claude configuration without adding other provider fields', () => {
  expect(prepareHarnessEditor(createHarnessEditor(savedClaudeConfiguration))).toEqual(savedClaudeConfiguration)
})
it('preserves exact per-provider drafts when switching to and from Claude', () => {
  const claude = createHarnessEditor(savedClaudeConfiguration)
  const codex = switchHarnessEditor(claude, 'codex', DEFAULT_HARNESS_DEFAULTS.codex)
  expect(prepareHarnessEditor(switchHarnessEditor(codex, 'claude'))).toEqual(savedClaudeConfiguration)
})
it('changes only the Claude model from native discovery', () => {
  expect(selectNativeModel(savedClaudeConfiguration, { id: 'verified-model', name: 'Verified', reasoningEfforts: [],
    serviceTiers: [], variants: [] })).toEqual({ ...savedClaudeConfiguration, model: 'verified-model' })
})
it('does not fabricate a Claude preset while switching from another provider', () => {
  const codex = createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)
  expect(switchHarnessEditor(codex, 'claude')).toBe(codex)
})
