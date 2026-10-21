import { describe, expect, it } from 'vitest';
import { BrowserProfileReplicaSchema, BrowserProfileSyncJobSchema, BrowserLoginEvidenceSchema,
  BrowserProfileSnapshotManifestSchema, NodeBrowserSettingsSchema, ExecutableNodeBrowserSettingsSchema } from './browserProfiles.js';
import { BrowserSessionSchema, BrowserSessionReadbackSchema, BrowserPrepareResultSchema } from './browserSessions.js';
import { collaborationContractFixtures as fixture } from './collaborationFixtures.js';

const snapshot = { profileId: 'profile', publishedRevision: 1, sha256: 'a'.repeat(64), format: 'cookies-localstorage-v1' };
const manifest = { snapshot, sourceComputerId: 'source', createdAt: fixture.createdAt, byteLength: 123,
  origins: ['https://example.com'], unsupportedState: [] };
const replica = { profileId: 'profile', computerId: 'destination', desiredSnapshot: snapshot, receivedSnapshot: snapshot,
  appliedSnapshot: snapshot, transfer: 'up_to_date', loginEvidence: [], localOverride: false, lastSeenAt: fixture.createdAt, reason: null };

describe('browser profile synchronization contracts', () => {
  it('compares full snapshot identity and keeps login evidence separate', () => {
    expect(BrowserProfileReplicaSchema.safeParse(replica).success).toBe(true);
    expect(BrowserProfileReplicaSchema.safeParse({ ...replica, appliedSnapshot: { ...snapshot, sha256: 'b'.repeat(64) } }).success).toBe(false);
    expect(BrowserProfileReplicaSchema.safeParse({ ...replica, appliedSnapshot: { ...snapshot, profileId: 'other' } }).success).toBe(false);
    expect(BrowserProfileReplicaSchema.safeParse({ ...replica, appliedSnapshot: null }).success).toBe(false);
    const unchecked = { origin: 'https://example.com', state: 'not_checked', checkedAt: null, evidence: 'none', reason: null };
    expect(BrowserLoginEvidenceSchema.parse(unchecked)).toEqual(unchecked);
    expect(BrowserLoginEvidenceSchema.safeParse({ ...unchecked, state: 'signed_in' }).success).toBe(false);
    expect(BrowserLoginEvidenceSchema.safeParse({ ...unchecked, state: 'signed_in', checkedAt: fixture.createdAt, evidence: 'user_confirmed' }).success).toBe(true);
    expect(BrowserLoginEvidenceSchema.safeParse({ ...unchecked, checkedAt: fixture.createdAt }).success).toBe(false);
    expect(BrowserLoginEvidenceSchema.safeParse({ ...unchecked, origin: 'https://example.com/path' }).success).toBe(false);
  });

  it('rejects mismatched sync identities and completion claims', () => {
    const target = { profileId: 'profile', computerId: 'destination', snapshot, state: 'up_to_date', exclusion: null, reason: null, updatedAt: fixture.createdAt };
    const job = { id: 'sync', commandId: 'command', state: 'completed', profiles: [{ profileId: 'profile', sourceComputerId: 'source', state: 'published', manifest, reason: null }],
      targets: [target], revision: 1, createdAt: fixture.createdAt, updatedAt: fixture.createdAt };
    expect(BrowserProfileSyncJobSchema.safeParse(job).success).toBe(true);
    expect(BrowserProfileSyncJobSchema.safeParse({ ...job, targets: [{ ...target, snapshot: { ...snapshot, sha256: 'b'.repeat(64) } }] }).success).toBe(false);
    expect(BrowserProfileSyncJobSchema.safeParse({ ...job, targets: [{ ...target, state: 'offline' }] }).success).toBe(false);
    expect(BrowserProfileSyncJobSchema.safeParse({ ...job, state: 'partial' }).success).toBe(false);
    expect(BrowserProfileSyncJobSchema.safeParse({ ...job, state: 'partial', targets: [target, { ...target, computerId: 'other', state: 'failed', reason: 'Unavailable storage' }] }).success).toBe(true);
    expect(BrowserProfileSnapshotManifestSchema.safeParse({ ...manifest, cookies: 'secret' }).success).toBe(false);
  });
});

describe('browser session ownership contracts', () => {
  const subject = { kind: 'execution', agent: fixture.agent, execution: fixture.execution };
  const session = { id: 'browser-session', subject, profileId: 'profile', computerId: 'computer', browserGeneration: 2, state: 'ready', selectedTabId: 'tab' };
  const control = { sessionId: 'browser-session', state: 'agent', epoch: 0, controllingViewerId: null, reason: null };
  const tab = { id: 'lease', sessionId: 'browser-session', tabId: 'tab', browserGeneration: 2, title: 'Example', url: 'https://example.com' };

  it('separates incomplete settings from executable configuration', () => {
    expect(NodeBrowserSettingsSchema.parse({ enabled: true })).toEqual({ enabled: true });
    expect(ExecutableNodeBrowserSettingsSchema.safeParse({ enabled: true }).success).toBe(false);
    expect(ExecutableNodeBrowserSettingsSchema.safeParse({ enabled: true, profileId: 'profile' }).success).toBe(true);
  });

  it('requires exactly one subject or matching setup profile', () => {
    expect(BrowserSessionSchema.safeParse(session).success).toBe(true);
    expect(BrowserSessionSchema.safeParse({ ...session, setupForProfileId: 'profile' }).success).toBe(false);
    const { subject: _subject, ...setup } = session;
    void _subject;
    expect(BrowserSessionSchema.safeParse(setup).success).toBe(false);
    expect(BrowserSessionSchema.safeParse({ ...setup, setupForProfileId: 'profile' }).success).toBe(true);
    expect(BrowserSessionSchema.safeParse({ ...setup, setupForProfileId: 'other' }).success).toBe(false);
  });

  it('rejects sibling leases, old generations and foreign control', () => {
    expect(BrowserSessionReadbackSchema.safeParse({ session, control, tabs: [tab] }).success).toBe(true);
    expect(BrowserSessionReadbackSchema.safeParse({ session, control, tabs: [{ ...tab, sessionId: 'sibling' }] }).success).toBe(false);
    expect(BrowserSessionReadbackSchema.safeParse({ session, control, tabs: [{ ...tab, browserGeneration: 1 }] }).success).toBe(false);
    expect(BrowserSessionReadbackSchema.safeParse({ session, control, tabs: [] }).success).toBe(false);
    expect(BrowserPrepareResultSchema.safeParse({ kind: 'ready', session, control: { ...control, sessionId: 'sibling' } }).success).toBe(false);
    expect(BrowserSessionReadbackSchema.safeParse({ session, control: { ...control, state: 'user' }, tabs: [tab] }).success).toBe(false);
    expect(BrowserSessionReadbackSchema.safeParse({ session, control: { ...control, state: 'user', controllingViewerId: 'viewer' }, tabs: [tab] }).success).toBe(true);
  });
});
