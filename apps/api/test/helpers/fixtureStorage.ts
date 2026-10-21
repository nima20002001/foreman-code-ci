import { privateFixtureRoot } from './privateFixtureDirectory.js'

// HOME is quota-backed scratch inside verification; heavy-job TMPDIR may have shared ancestors.
export const persistentFixtureRoot = await privateFixtureRoot()
