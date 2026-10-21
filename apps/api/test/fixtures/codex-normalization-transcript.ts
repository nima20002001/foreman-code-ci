import type { CodexNotificationEnvelope } from '../../src/modules/harnesses/codexNormalization.js'

/** Synthetic protocol regression frames, not a live/native recording. Exact
 * schema/source pins let the production replay lane validate these deliberately
 * ordered frames without representing them as installed-binary qualification. */
export const codexNormalizationTranscript = {
  schemaVersion: 1,
  provider: 'codex',
  protocolRevision: 'codex-cli 0.154.0',
  stableSchemaGitBlob: '7de4646ea2657038e164609d9473c76c1be7c843',
  referenceManifestSha256: 'b785f87f96c4747e9db6c0492cea2de68e99b48f3462908174a1e8122a620054',
  sourceSha: '66696176f5fe94570d763443e9c752726c1a55fc',
  origin: 'synthetic' as const,
  redacted: true,
  owner: { threadId: 'root', turnId: 'parent-turn', runtimeGeneration: 3, terminal: false },
  frames: [
    { method: 'turn/completed', params: { threadId: 'child', turn: {
      id: 'child-turn', status: 'completed', items: [], itemsView: 'full', error: null,
      startedAt: 1, completedAt: 2, durationMs: 1,
    } } },
    { method: 'item/agentMessage/delta', params: { threadId: 'root', turnId: 'parent-turn', itemId: 'answer', delta: 'partial' } },
    { method: 'item/completed', params: { threadId: 'root', turnId: 'parent-turn',
      item: { id: 'answer', type: 'agentMessage', text: 'final', phase: 'final_answer' } } },
    { method: 'turn/completed', params: { threadId: 'root', turn: {
      id: 'old-turn', status: 'completed', items: [], itemsView: 'full', error: null,
      startedAt: 1, completedAt: 2, durationMs: 1,
    } } },
    { method: 'turn/completed', params: { threadId: 'root', turn: {
      id: 'parent-turn', status: 'completed', items: [{ id: 'answer', type: 'agentMessage', text: 'final', phase: 'final_answer' }],
      itemsView: 'full', error: null, startedAt: 1, completedAt: 2, durationMs: 1,
    } } },
  ],
}

export function codexNormalizationEnvelopes(): CodexNotificationEnvelope[] {
  return codexNormalizationTranscript.frames.map((frame, index) => ({
    providerVersion: codexNormalizationTranscript.protocolRevision,
    schemaIdentity: codexNormalizationTranscript.referenceManifestSha256,
    connectionId: 'connection-3', runtimeGeneration: 3, arrivalOrdinal: index + 1,
    ...structuredClone(frame),
  }))
}
