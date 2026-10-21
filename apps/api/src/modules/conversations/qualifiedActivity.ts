import type { ActivitySnapshotV1, InteractionSummary } from '@foreman-code/contracts/activity'
import type { NativeInteractionResponseAvailability } from '@foreman-code/contracts/interaction-activity'

/** Dynamic callback/grant qualification cannot change recorded answer or delivery evidence. */
export function qualifyChatActivity(snapshot: ActivitySnapshotV1,
  response: NativeInteractionResponseAvailability | undefined): ActivitySnapshotV1 {
  const qualify = (interaction: InteractionSummary): InteractionSummary => {
    const exact = response && response.nativeRequestId && interaction.native?.requestId === response.nativeRequestId
      && interaction.native.sessionId === response.nativeSessionId && interaction.native.turnId === response.nativeTurnId
      && (interaction.native.harness !== 'claude' || Boolean(interaction.native.generation && interaction.native.generation === response.generation))
    return { ...interaction, responseAvailability: exact && response.available ? 'available'
      : exact && response.status === 'recovery_required' ? 'recovery_required' : 'unavailable' }
  }
  return { ...snapshot, pendingInteractions: snapshot.pendingInteractions.map(qualify),
    activities: snapshot.activities.map((item) => item.kind === 'interaction' ? { ...item, interaction: qualify(item.interaction) } : item) }
}
