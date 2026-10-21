// The repository import graph shared by the affected-test selector (scripts/ci-affected.mjs) and Main's CI
// result cache, so both agree on which files a test file depends on.
import { posix } from 'node:path'

/** Files whose text is read for imports. */
export const ciCodeFile = /\.(?:[cm]?[jt]sx?|json|css)$/

/** Shared CI infrastructure: a change runs the full suite, and the result cache keys every test on it. */
export const ciInfrastructure = [
  /(?:^|\/)(?:package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig[^/]*|vitest\.config\.[^/]*|eslint\.config\.[^/]*)$/,
  /(?:^|\/)migrations?\/|Migration\.[cm]?[jt]s$/,
  /^packages\/contracts\/src\/index\.ts$/,
  /^packages\/contracts\/src\/ci(?:Coverage|ImportGraph)\.[^/]+$/,
  /^apps\/api\/src\/modules\/ci-host\/(?!.*\.(?:test|testSupport)\.[^/]+$)/,
  /^scripts\/(?:test-integration[^/]*|test-resources[^/]*|integration-process[^/]*|integration-coverage[^/]*|ci-[^/]*|vitest-[^/]*|test-db\.mjs|test-command\.mjs|heavy-job\.mjs)$/,
  /^apps\/api\/test\/(?:helpers\/|setup[^/]*$)|^apps\/web\/src\/test\//,
  /^(?:\.github\/workflows\/|\.circleci\/)/,
]

/** @param {string} file */
export function ciInfrastructureFile(file) {
  return ciInfrastructure.some(pattern => pattern.test(file))
}

/** Literal module specifiers of static imports, re-exports, dynamic imports, requires and Vitest module mocks.
 * @param {string} text
 * @returns {string[]} */
export function importSpecifiers(text) {
  const values = []
  const pattern = /\b(?:import|export)\s+(?:[^;'"]*?\s+from\s*)?['"]([^'"]+)['"]|\b(?:import|require|vi\.mock|vi\.doMock|vi\.importActual|vi\.importMock)\s*(?:<[^>]*>)?\s*\(\s*['"]([^'"]+)['"]/g
  for (const match of text.matchAll(pattern)) values.push(match[1] ?? match[2])
  return values
}

/** The repository file a relative or contracts-package specifier names, or null when it names none.
 * @param {string} file
 * @param {string} specifier
 * @param {{ has(path: string): boolean }} paths
 * @param {Record<string, unknown>} exports The contracts package's `exports` map.
 * @returns {string | null} */
export function resolveImport(file, specifier, paths, exports) {
  specifier = specifier.split('?')[0].split('#')[0]
  let target
  if (specifier.startsWith('.')) target = posix.normalize(posix.join(posix.dirname(file), specifier))
  else if (specifier === '@foreman-code/contracts' || specifier.startsWith('@foreman-code/contracts/')) {
    const key = specifier === '@foreman-code/contracts' ? '.' : `.${specifier.slice('@foreman-code/contracts'.length)}`
    const entry = exports[key]
    const path = typeof entry === 'string' ? entry
      : entry && typeof entry === 'object' && 'import' in entry && typeof entry.import === 'string' ? entry.import : undefined
    if (path) target = `packages/contracts/${path.replace(/^\.\//, '').replace(/^dist\//, 'src/')}`
  }
  if (!target) return null
  const stem = target.replace(/\.[cm]?js$/, '')
  const candidates = [target, ...['.ts', '.tsx', '.mts', '.mjs', '.js', '.jsx', '.json', '/index.ts', '/index.tsx', '/index.js']
    .map(extension => `${stem}${extension}`)]
  return candidates.find(candidate => paths.has(candidate)) ?? null
}

/** Repository files named by literal fixture URLs or filesystem reads.
 * @param {string} file
 * @param {string} text
 * @param {{ has(path: string): boolean }} paths
 * @returns {string[]} */
export function runtimeDependencies(file, text, paths) {
  const resolved = new Set()
  const add = (base, literal) => {
    const target = posix.normalize(posix.join(base, literal))
    if (paths.has(target)) resolved.add(target)
    else {
      const source = resolveImport(file, `./${posix.relative(posix.dirname(file), target)}`, paths, {})
      if (source) resolved.add(source)
    }
  }
  for (const match of text.matchAll(/\bnew\s+URL\s*\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g)) {
    if (match[1].startsWith('.')) add(posix.dirname(file), match[1])
  }
  const parts = file.split('/')
  const project = ['apps', 'packages'].includes(parts[0]) ? parts.slice(0, 2).join('/') : parts[0]
  for (const match of text.matchAll(/\b(?:readFile|readFileSync|createReadStream)\s*\(\s*['"]([^'"]+)['"]/g)) {
    if (match[1].startsWith('/') || /^[a-z]+:/i.test(match[1])) continue
    for (const base of [posix.dirname(file), project, '']) add(base, match[1])
  }
  return [...resolved]
}
