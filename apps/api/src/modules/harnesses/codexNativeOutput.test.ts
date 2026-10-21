import { describe, expect, it } from 'vitest'
import { sameCodexNativeOutputSandbox, type CodexNativeOutputSandbox } from './codexNativeOutput.js'

const policy: CodexNativeOutputSandbox = { cwd: '/workspace', writableRoots: ['/other'], networkAccess: false,
  excludeTmpdirEnvVar: true, excludeSlashTmp: true, tmpdir: '/runtime/tmp' }

describe('measured native output sandbox', () => {
  it('accepts an explicit or implicit cwd while preserving every other root and policy field', () => {
    expect(sameCodexNativeOutputSandbox({ ...policy, writableRoots: ['/workspace', '/other'] }, policy)).toBe(true)
    expect(sameCodexNativeOutputSandbox({ ...policy, writableRoots: ['/other', '/workspace', '/other'] }, policy)).toBe(true)
    for (const actual of [
      { ...policy, cwd: '/another' }, { ...policy, writableRoots: [] },
      { ...policy, writableRoots: ['/other', '/private-store'] }, { ...policy, networkAccess: true },
      { ...policy, excludeTmpdirEnvVar: false }, { ...policy, excludeSlashTmp: false },
      { ...policy, tmpdir: '/another/tmp' },
    ]) expect(sameCodexNativeOutputSandbox(actual, policy)).toBe(false)
  })
})
