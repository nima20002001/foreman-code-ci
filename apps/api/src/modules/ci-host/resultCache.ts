import { createHash } from 'node:crypto'
import { isBuiltin } from 'node:module'
import { posix } from 'node:path'
import { ciCodeFile, ciInfrastructureFile, importSpecifiers, resolveImport } from '@foreman-code/contracts/ci-import-graph'

/** Bump when the key inputs or the doubt rules change, so earlier passes stop matching. */
const CI_RESULT_CACHE_VERSION = 1

/** One commit of the repository for result cache keys. */
export interface CiTestTree {
  /** Every file with its git mode and blob id (`100644:<sha>`), which change with its content. */
  blobs: ReadonlyMap<string, string>
  read(path: string, signal: AbortSignal): Promise<string>
}

/** The key cannot prove the file's inputs, so the file must run. */
class CacheDoubt extends Error {}

interface Analysis { specifiers: string[]; literals: string[]; doubt: string | null; testDoubt: string | null }

const ANALYSES_MAX = 50_000
/** By blob and extension: a blob's imports never change. */
const analyses = new Map<string, Analysis>()

const DOUBTS: [RegExp, string][] = [
  [/\bimport\s*\(\s*(?!['"][^'"]*['"]\s*[,)])/, 'imports a computed module'],
  [/\brequire\s*\(\s*(?!['"])|\bcreateRequire\b|\brequire\.resolve\b/, 'requires a computed module'],
  [/import\.meta\.glob/, 'imports a glob'],
]
/** Test code that reads repository files by path or runs other programs depends on files no import names. */
const TEST_DOUBTS: [RegExp, string][] = [
  [/import\.meta\.(?:url|dirname|filename)|\b__dirname\b|\b__filename\b|process\.cwd\s*\(/, 'reads files by path'],
  [/['"](?:node:)?(?:child_process|worker_threads)['"]|\bnew\s+Worker\s*\(/, 'starts other processes'],
]
const testSupport = /(?:^|\/)(?:test|tests|__tests__|fixtures?)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|test-?support|test-?utils/i
const pathLiteral = /['"`]((?:\.{1,2}\/)*[A-Za-z0-9_@-][A-Za-z0-9_.@-]*(?:\/[A-Za-z0-9_.@-]+)+)['"`]/g
const scriptFile = /\.[cm]?[jt]sx?$/
const DIRECTORY_FILES_MAX = 2000

/** Share the read limit across manifests and all test closures of the selection. */
function boundedTree(tree: CiTestTree, signal: AbortSignal): CiTestTree {
  let active = 0
  const waiting: (() => void)[] = []
  return { blobs: tree.blobs, read: async path => {
    if (active >= 16) await new Promise<void>(resolve => { waiting.push(resolve) })
    else active++
    try {
      signal.throwIfAborted()
      return await tree.read(path, signal)
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  } }
}

function analyze(path: string, text: string): Analysis {
  const css = path.endsWith('.css')
  const data = css || path.endsWith('.json')
  return {
    specifiers: data ? [] : importSpecifiers(text),
    literals: data ? [] : [...text.matchAll(pathLiteral)].map(match => match[1]!),
    doubt: css ? (/@import\b/.test(text) ? 'imports CSS' : null) : DOUBTS.find(([pattern]) => pattern.test(text))?.[1] ?? null,
    testDoubt: data ? null : TEST_DOUBTS.find(([pattern]) => pattern.test(text))?.[1] ?? null,
  }
}

/** The package directory a test file belongs to: apps/<name>, packages/<name> or its top-level directory. */
function projectOf(file: string) {
  const parts = file.split('/')
  return ['apps', 'packages'].includes(parts[0]!) ? parts.slice(0, 2).join('/') : parts[0]!
}

function packageName(specifier: string) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!
}

/** Conservative input keys for test files of one commit: a file's key changes whenever anything it can observe
 * changes, and a file whose inputs the import graph cannot prove has no key. */
export class CiResultKeys {
  private readonly pendingAnalyses = new Map<string, Promise<Analysis>>()
  private readonly harness = new Map<string, Promise<Set<string>>>()
  private readonly environments = new Map<string, string[]>()
  private readonly directories = new Set<string>()

  private constructor(private readonly tree: CiTestTree, private readonly exports: Record<string, unknown>,
    private readonly packages: ReadonlySet<string>, private readonly signal: AbortSignal) {
    for (const path of tree.blobs.keys()) {
      const parts = path.split('/')
      for (let index = 1; index < parts.length; index++) this.directories.add(parts.slice(0, index).join('/'))
    }
  }

  /** Reads the contracts exports and the external packages every manifest declares (workspace packages excluded). */
  static async create(input: CiTestTree, signal: AbortSignal): Promise<CiResultKeys> {
    const tree = boundedTree(input, signal)
    const manifests = await Promise.all([...tree.blobs.keys()].filter(path => posix.basename(path) === 'package.json')
      .map(async path => ({ path, value: JSON.parse(await tree.read(path, signal)) as Record<string, unknown> })))
    const workspace = new Set(manifests.map(manifest => manifest.value.name).filter(name => typeof name === 'string'))
    const packages = new Set<string>()
    for (const { value } of manifests) {
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        const declared = value[field]
        if (!declared || typeof declared !== 'object') continue
        for (const [name, version] of Object.entries(declared)) {
          if (typeof version === 'string' && !/^(?:workspace|link|file|portal):/.test(version) && !workspace.has(name)) {
            packages.add(name)
          }
        }
      }
    }
    const contracts = manifests.find(manifest => manifest.path === 'packages/contracts/package.json')?.value.exports
    return new CiResultKeys(tree, contracts && typeof contracts === 'object' ? contracts as Record<string, unknown> : {}, packages, signal)
  }

  /** The file's key for the suite and part, or null with the reason it must run. */
  async key(file: string, suite: string, part: string): Promise<{ key: string | null; reason?: string }> {
    try {
      this.signal.throwIfAborted()
      const project = projectOf(file)
      const environment = this.environment(project)
      const harness = await this.harnessFiles(project, environment)
      const own = await this.closure([file], true)
      const paths = [...new Set([...environment, ...harness, ...own])].sort()
      const hash = createHash('sha256').update(JSON.stringify([CI_RESULT_CACHE_VERSION, suite, part,
        paths.map(path => [path, this.tree.blobs.get(path)])]))
      return { key: hash.digest('hex') }
    } catch (error) {
      if (error instanceof CacheDoubt) return { key: null, reason: error.message }
      throw error
    }
  }

  /** Files hashed by content for every test of a project: root files, CI scripts and workflows, the project's and the
   * contracts package's CI infrastructure, and the project's data files (fixtures, SQL, assets) a test may read. */
  private environment(project: string) {
    let files = this.environments.get(project)
    if (!files) {
      files = this.projectEnvironment(project)
      this.environments.set(project, files)
    }
    return files
  }

  private projectEnvironment(project: string) {
    return [...this.tree.blobs.keys()].filter(path => {
      if (/\.md$/i.test(path)) return false
      if (!path.includes('/')) return true
      if (ciInfrastructureFile(path)) {
        return ['scripts/', '.github/', '.circleci/', `${project}/`, 'packages/contracts/'].some(prefix => path.startsWith(prefix))
      }
      return path.startsWith(`${project}/`) && !ciCodeFile.test(path)
    })
  }

  /** What the environment's configs, setup files and runner scripts load, including files they name by relative path.
   * Shared test helpers are hashed by content; a test that imports one reaches its imports through its own closure. */
  private harnessFiles(project: string, environment: string[]) {
    let files = this.harness.get(project)
    if (!files) {
      const roots = environment.filter(path => scriptFile.test(path) && !/(?:^|\/)eslint\.config\./.test(path)
        && !/^(?:\.github|\.circleci)\//.test(path) && !path.startsWith('apps/api/test/helpers/'))
      files = this.closure(roots, false)
      this.harness.set(project, files)
    }
    return files
  }

  private async analysis(path: string, blob: string) {
    const id = `${blob}${posix.extname(path)}`
    const cached = analyses.get(id)
    if (cached) return cached
    let pending = this.pendingAnalyses.get(id)
    if (!pending) {
      pending = this.tree.read(path, this.signal).then(text => {
        const value = analyze(path, text)
        if (analyses.size >= ANALYSES_MAX) analyses.delete(analyses.keys().next().value!)
        analyses.set(id, value)
        return value
      }).finally(() => { this.pendingAnalyses.delete(id) })
      this.pendingAnalyses.set(id, pending)
    }
    return pending
  }

  /** Every repository file the roots import, transitively. Strict closures (a test's own) reject anything the static
   * graph cannot prove; the harness closure follows the same edges and the paths its scripts name. */
  private async closure(roots: string[], strict: boolean) {
    const files = new Set<string>()
    let frontier = roots
    while (frontier.length) {
      const next: string[] = []
      for (let start = 0; start < frontier.length; start += 16) {
        await Promise.all(frontier.slice(start, start + 16).map(async file => {
          if (files.has(file)) return
          files.add(file)
          next.push(...await this.edges(file, strict))
        }))
      }
      frontier = next
    }
    return files
  }

  private async edges(file: string, strict: boolean): Promise<string[]> {
    const blob = this.tree.blobs.get(file)
    if (!blob) throw new CacheDoubt(`${file} is not in the commit.`)
    if (!/^100(?:644|755):/.test(blob)) throw new CacheDoubt(`${file} is a link or submodule.`)
    if (!ciCodeFile.test(file)) return []
    const analysis = await this.analysis(file, blob)
    const support = testSupport.test(file)
    if (strict && analysis.doubt) throw new CacheDoubt(`${file} ${analysis.doubt}.`)
    if (strict && support && analysis.testDoubt) throw new CacheDoubt(`${file} ${analysis.testDoubt}.`)
    const edges: string[] = []
    for (const specifier of analysis.specifiers) {
      const relative = specifier.startsWith('.') || specifier.startsWith('/')
      if (relative || packageName(specifier) === '@foreman-code/contracts') {
        const target = specifier.startsWith('/') ? null : resolveImport(file, specifier, this.tree.blobs, this.exports)
        if (!target) throw new CacheDoubt(`${file} imports ${specifier}, which is not a repository file.`)
        edges.push(target)
      } else if (strict && !specifier.startsWith('node:') && !isBuiltin(specifier) && !this.packages.has(packageName(specifier))) {
        // Aliases, virtual modules and workspace packages other than contracts have no edge the key can follow.
        throw new CacheDoubt(`${file} imports ${specifier}, which no manifest pins.`)
      }
    }
    // Test support can read repository files it names, and configs name their runners and setup files by relative
    // path; those files join the key.
    for (const literal of analysis.literals) {
      if (support && strict) edges.push(...this.namedFiles(file, literal))
      else if (!strict && literal.startsWith('.')) {
        const named = posix.join(posix.dirname(file), literal)
        if (this.tree.blobs.has(named)) edges.push(named)
      }
    }
    return edges
  }

  private namedFiles(file: string, literal: string): string[] {
    const project = projectOf(file)
    const candidates = literal.startsWith('.') ? [posix.join(posix.dirname(file), literal)] : [literal, `${project}/${literal}`]
    const named: string[] = []
    for (const candidate of candidates) {
      if (this.tree.blobs.has(candidate)) named.push(candidate)
      else if (this.directories.has(candidate)) {
        const inside = [...this.tree.blobs.keys()].filter(path => path.startsWith(`${candidate}/`))
        if (inside.length > DIRECTORY_FILES_MAX) throw new CacheDoubt(`${file} names the large directory ${candidate}.`)
        named.push(...inside)
      }
    }
    return named
  }
}
