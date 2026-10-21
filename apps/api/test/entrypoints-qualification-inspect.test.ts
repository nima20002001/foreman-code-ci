import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateJobQualificationMounts, type QualificationMount } from '../src/modules/jobs/qualification.js'

const retained = JSON.parse(readFileSync(new URL('./fixtures/podman-qualification-inspect.json', import.meta.url), 'utf8')) as {
  Mounts: QualificationMount[]; HostConfig: { Tmpfs: Record<string, string> }
}
const paths = { sourceRoot: '/owned/qualification/tree', inputRoot: '/owned/qualification/tree/.graphql-job-inputs',
  gitDirectory: '/owned/qualification/repository', schedulerDirectory: '/owned/qualification/job-heavy-jobs' }
const spoolBytes = 67108864

describe('retained physical Podman qualification inspect shape', () => {
  it('accepts exactly the four original binds and separate HostConfig.Tmpfs from the actual laptop inspect', () => {
    expect(() => validateJobQualificationMounts(retained.Mounts, paths, retained.HostConfig.Tmpfs, spoolBytes)).not.toThrow()
  })
  it('rejects missing, duplicated, extra and re-bound host mounts and writable private Git or inputs', () => {
    for (const mounts of [retained.Mounts.slice(1), [...retained.Mounts, retained.Mounts[0]!],
      [...retained.Mounts, { Type: 'bind', Source: '/etc', Destination: '/host', RW: true }],
      retained.Mounts.map((item, index) => index === 0 ? { ...item, Source: '/other/tree' } : item),
      retained.Mounts.map((item, index) => index === 1 || index === 2 ? { ...item, RW: true } : item),
    ]) expect(() => validateJobQualificationMounts(mounts, paths, retained.HostConfig.Tmpfs, spoolBytes)).toThrow()
  })
  it('requires exactly the bounded noexec/nosuid/nodev private /tmp and rejects missing or broadened options', () => {
    const actual = retained.HostConfig.Tmpfs['/tmp']!
    for (const tmpfs of [undefined, {}, { '/other': actual }, { '/tmp': actual, '/other': actual }, { '/tmp': actual.replace('noexec', 'exec') },
      { '/tmp': actual.replace('nosuid,', '') }, { '/tmp': actual.replace('nodev,', '') },
      { '/tmp': actual.replace('67108864', '67108865') }, { '/tmp': `${actual},dev` }, { '/tmp': `${actual},rw` },
    ]) expect(() => validateJobQualificationMounts(retained.Mounts, paths, tmpfs, spoolBytes)).toThrow()
  })
})
