import { applyOperatorChatSettings, operatorChatSettings, operatorHarnessDefaults, type AgentDefaults, type HarnessConfiguration, type OperatorChatSettings } from '@foreman-code/contracts'
import { useAgentDefaultsQuery, useHarnessDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { useNativeHarnessOptions } from '../../shared/api/harnessSettings'
import { useRevisionedForm } from '../settings/revisionedForm'

export function useOperatorSettings(enabled: boolean) {
  const query = useAgentDefaultsQuery(enabled)
  const harnesses = useHarnessDefaultsQuery({ enabled })
  const mutation = useUpdateAgentDefaultsMutation()
  const form = useRevisionedForm<AgentDefaults>(query.data, 'operator-chat:defaults')
  const operator = form.draft?.operator
  const catalog = useNativeHarnessOptions('claude', enabled && operator?.harness.harness === 'claude')
  const settings = operator && operator.harness.harness !== 'opencode'
    ? operatorChatSettings(operator.harness, operator.showThinking) : undefined
  const save = () => {
    // Older failed picker drafts may retain an effort that the current exact
    // model does not expose. Repair only an editable draft, never a frozen retry.
    if (operator?.harness.harness === 'claude' && !form.isSaving && !form.uncertain) form.setDraft(value => {
      const harness = value?.operator.harness
      if (!value || harness?.harness !== 'claude' || harness.effort === undefined
        || catalog.data?.models.find(model => model.id === harness.model)?.reasoningEfforts.length !== 0) return value
      const configuration = { ...harness }
      delete configuration.effort
      return { ...value, operator: { ...value.operator, harness: configuration } }
    })
    return form.save(async (input) => {
      const result = await mutation.mutateAsync(input)
      return result.value
    })
  }
  function change(settings: OperatorChatSettings) {
    if (!form.draft || !operator || form.isSaving || form.uncertain) return
    const preset = harnesses.data?.defaults[settings.harness]
    const base = operator.harness.harness === settings.harness ? operator.harness : preset ? operatorHarnessDefaults(preset) : undefined
    if (!base) return
    const next = { ...operator, harness: applyOperatorChatSettings(base, settings), showThinking: settings.showThinking }
    if (operator.harness.harness !== settings.harness) delete next.harnessProfileSelection
    form.setDraft({ ...form.draft, operator: next })
    void save()
  }
  function changeAccess(harness: HarnessConfiguration): Promise<boolean> {
    if (!form.draft || !operator || operator.harness.harness !== harness.harness || form.isSaving || form.uncertain) return Promise.resolve(false)
    form.setDraft({ ...form.draft, operator: { ...operator, harness } })
    return save()
  }
  return { query, form, settings, harness: operator?.harness, change, changeAccess, save }
}
