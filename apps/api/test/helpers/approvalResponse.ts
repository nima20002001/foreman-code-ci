import type { DurableInteraction } from '@foreman-code/contracts'

export function approvalResponse(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find(item => item.semantic === 'approve_once')
  if (!option) throw new Error('Expected an approve-once response option')
  return { interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision }
}
