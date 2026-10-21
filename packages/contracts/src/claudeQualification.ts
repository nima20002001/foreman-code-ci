import { z } from 'zod';

/** Provider evidence extends the existing HRT host-profile proof; it carries no authority of its own. */
const ClaudeQualificationCheckSchema = z.object({
  state: z.enum(['unverified', 'passed', 'failed']),
  source: z.enum(['root_init_probe', 'native_scenario']).optional(),
  evidenceId: z.string().min(1).max(500).optional(),
  evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine((value, context) => {
  if (value.state !== 'unverified' && (!value.source || !value.evidenceId || !value.evidenceSha256))
    context.addIssue({ code: 'custom', message: 'Recorded results require the actual root evidence identity and digest' });
});
export const CLAUDE_QUALIFICATION_CHECKS = [
  'sdkInitialization', 'firstSecondTurn', 'exactMessageReceipt', 'idleClose', 'resultThenThrow', 'wakeCorrelation',
  'exactResume', 'forkPreservesSource', 'exactHistory', 'activeCancellation', 'workingDirectory', 'startupPrompt', 'settingsIsolation', 'backgroundTasksDisabled',
  'alwaysAppliedToolHook', 'readOnlySandbox', 'workspaceWriteSandbox', 'fullAccessPolicy',
] as const;
export const ClaudeQualificationPinSchema = z.object({
  sdkVersion: z.string().min(1), sdkIntegrity: z.string().min(1), cliVersion: z.string().min(1),
  executableSha256: z.string().regex(/^[a-f0-9]{64}$/),
  profilePath: z.string().min(1).refine((value) => value.startsWith('/') && !value.includes('\0'), 'An accepted host-local profile path is required'),
  configRevision: z.string().min(1),
}).strict();
export type ClaudeQualificationPin = z.infer<typeof ClaudeQualificationPinSchema>;
export const ClaudeQualificationProofSchema = z.object({
  pin: ClaudeQualificationPinSchema,
  observedTools: z.array(z.string().min(1)).max(100).optional(),
  checks: z.partialRecord(z.enum(CLAUDE_QUALIFICATION_CHECKS), ClaudeQualificationCheckSchema),
}).strict();
export type ClaudeQualificationProof = z.infer<typeof ClaudeQualificationProofSchema>;

/** Missing checks remain unverified; an initialization-only probe proves no model or OS-policy scenarios. */
export function claudeQualificationCapabilities(proof: ClaudeQualificationProof) {
  const passed = (key: typeof CLAUDE_QUALIFICATION_CHECKS[number], native = true) =>
    proof.checks[key]?.state === 'passed' && (!native || proof.checks[key]?.source === 'native_scenario');
  const sdk = passed('sdkInitialization', false);
  const basicTurns = sdk && ['firstSecondTurn', 'exactMessageReceipt', 'idleClose', 'resultThenThrow', 'wakeCorrelation']
    .every((key) => passed(key as typeof CLAUDE_QUALIFICATION_CHECKS[number]));
  const resume = basicTurns && passed('exactResume');
  return {
    sdk, basicTurns, resume, cancellation: sdk && passed('activeCancellation'), workingDirectory: sdk && passed('workingDirectory'), startupPrompt: sdk && passed('startupPrompt'), fork: resume && passed('forkPreservesSource'), history: sdk && passed('exactHistory'),
    policy: { settingsIsolation: passed('settingsIsolation'), backgroundTasksDisabled: passed('backgroundTasksDisabled'),
      alwaysAppliedToolHook: passed('alwaysAppliedToolHook'), readOnlySandbox: passed('readOnlySandbox'), workspaceWriteSandbox: passed('workspaceWriteSandbox'), fullAccessPolicy: passed('fullAccessPolicy') },
  };
}
