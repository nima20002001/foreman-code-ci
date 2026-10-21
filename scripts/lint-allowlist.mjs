import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Content IDs keep existing exemptions attached to unchanged files across renames. */
export function lintFilePaths(root, allowlist) {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0')
  const paths = new Map()
  for (const file of new Set(files.filter(Boolean))) {
    if (!/\.(?:[cm]?[jt]sx?)$/.test(file) || !lstatSync(join(root, file), { throwIfNoEntry: false })?.isFile()) continue
    const id = createHash('sha256').update(readFileSync(join(root, file))).digest('hex')
    if (!Object.hasOwn(allowlist.files, id)) continue
    const matches = paths.get(id) ?? []
    matches.push(file)
    paths.set(id, matches)
  }
  return Object.fromEntries(paths)
}

export function resolveLintAllowlist(root, allowlist) {
  const paths = lintFilePaths(root, allowlist)
  const resolve = ids => ids.flatMap(id => paths[id] ?? [])
  return {
    eslint: Object.fromEntries(Object.entries(allowlist.eslint).map(([rule, ids]) => [rule, resolve(ids)])),
    'test-names': resolve(allowlist['test-names']),
    'import-cycles': allowlist['import-cycles'].filter(ids => ids.every(id => paths[id]?.length === 1)).map(resolve),
  }
}
