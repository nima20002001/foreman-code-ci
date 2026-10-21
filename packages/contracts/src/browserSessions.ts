import { z } from 'zod';
import { IdSchema } from './schemaPrimitives.js';
import { AgentSubjectSchema } from './agentIdentity.js';

export const BrowserSessionSchema = z.object({
  id: IdSchema, subject: AgentSubjectSchema.optional(),
  setupForProfileId: IdSchema.optional(),
  profileId: IdSchema, computerId: IdSchema,
  browserGeneration: z.number().int().positive(),
  state: z.enum(['starting','ready','paused','recovering','closed','failed']),
  selectedTabId: IdSchema.nullable(),
}).strict().superRefine((session, context) => {
  if ((session.subject !== undefined) === (session.setupForProfileId !== undefined)) context.addIssue({ code: 'custom', message: 'Choose exactly one Agent subject or profile setup owner.' });
  if (session.setupForProfileId && session.setupForProfileId !== session.profileId) context.addIssue({ code: 'custom', path: ['setupForProfileId'], message: 'Setup owner must identify the same profile.' });
});
export const BrowserTabLeaseSchema = z.object({
  id: IdSchema, sessionId: IdSchema, tabId: IdSchema,
  browserGeneration: z.number().int().positive(),
  openerTabId: IdSchema.optional(),
  title: z.string(), url: z.string(),
}).strict().refine((lease) => lease.openerTabId !== lease.tabId, { path: ['openerTabId'], message: 'A tab cannot open itself.' });
export const BrowserControlSchema = z.object({
  sessionId: IdSchema,
  state: z.enum(['agent','quiescing','user','resuming','paused','recovering']),
  epoch: z.number().int().nonnegative(),
  controllingViewerId: IdSchema.nullable(),
  reason: z.string().nullable(),
}).strict().superRefine((control, context) => {
  if (control.state === 'user' && !control.controllingViewerId) context.addIssue({ code: 'custom', path: ['controllingViewerId'], message: 'User control identifies its controlling viewer.' });
  if (control.state === 'agent' && control.controllingViewerId !== null) context.addIssue({ code: 'custom', path: ['controllingViewerId'], message: 'Agent control has no controlling viewer.' });
  if (['paused', 'recovering'].includes(control.state) && !control.reason?.trim()) context.addIssue({ code: 'custom', path: ['reason'], message: 'Paused or recovering control requires an explanation.' });
});

export const BrowserPrepareResultSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), session: BrowserSessionSchema,
    control: BrowserControlSchema }).strict(),
  z.object({ kind: z.literal('unavailable'),
    reason: z.enum(['disabled','profile_missing','computer_offline','runtime_missing',
      'sign_in_required','resource_pressure','profile_busy']),
    retryable: z.boolean() }).strict(),
]).superRefine((result, context) => {
  if (result.kind === 'ready' && result.session.id !== result.control.sessionId) {
    context.addIssue({ code: 'custom', message: 'Ready results identify one session and its control.' });
  }
});
export const BrowserReleaseResultSchema = z.object({
  sessionId: IdSchema, state: z.enum(['closed','pending','already_closed']),
  reason: z.string().nullable(),
}).strict();



export type BrowserSession = z.infer<typeof BrowserSessionSchema>;
export type BrowserTabLease = z.infer<typeof BrowserTabLeaseSchema>;
export type BrowserControl = z.infer<typeof BrowserControlSchema>;
export type BrowserPrepareResult = z.infer<typeof BrowserPrepareResultSchema>;
export type BrowserReleaseResult = z.infer<typeof BrowserReleaseResultSchema>;

/** Public host readback validates lease ownership without exposing host paths or CDP. */
export const BrowserSessionReadbackSchema = z.object({
  session: BrowserSessionSchema, control: BrowserControlSchema, tabs: z.array(BrowserTabLeaseSchema),
}).strict().superRefine(({ session, control, tabs }, context) => {
  const fail = (message: string) => context.addIssue({ code: 'custom', message });
  if (session.id !== control.sessionId) fail('Control must identify the selected session.');
  if (tabs.some((tab) => tab.sessionId !== session.id || tab.browserGeneration !== session.browserGeneration)) fail('Tab leases must belong to this session and browser generation.');
  const ids = new Set(tabs.map((tab) => tab.tabId));
  if (ids.size !== tabs.length || new Set(tabs.map((tab) => tab.id)).size !== tabs.length) fail('Tab and lease identities must be unique.');
  if (session.selectedTabId !== null && !ids.has(session.selectedTabId)) fail('Selected tab must have a current session lease.');
});
export type BrowserSessionReadback = z.infer<typeof BrowserSessionReadbackSchema>;
