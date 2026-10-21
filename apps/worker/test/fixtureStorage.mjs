import { tmpdir } from 'node:os';

// TMPDIR is persistent job storage in verification; /var/tmp is the local fallback.
export const persistentFixtureRoot = process.env.TMPDIR ? tmpdir() : '/var/tmp';
