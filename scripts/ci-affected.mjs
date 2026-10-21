import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ciCodeFile as codeFile, ciInfrastructureFile, importSpecifiers as imports, resolveImport, runtimeDependencies }
  from '../packages/contracts/src/ciImportGraph.mjs'
import { usableIntegrationCoverage } from '../packages/contracts/src/ciCoverage.mjs'
import { workerEntryPoints, rsyncWriterEntrypoint, schemaWorkerEntrypoint, verificationScripts, workerSnapshotFiles }
  from './worker-snapshot-policy.mjs'

const projects = ['apps/api', 'apps/web', 'apps/worker', 'packages/contracts']
const testFile = /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/
const integrationFile = /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/

/** Bundled/copied sources run under generated paths in child processes, outside repository V8 coverage. */
function changedWorkerBundleInput(changedFiles, dependencies) {
  const inputs = new Set([...Object.values(workerEntryPoints), rsyncWriterEntrypoint, schemaWorkerEntrypoint,
    ...verificationScripts, ...workerSnapshotFiles])
  for (const input of inputs) for (const dependency of dependencies.get(input) ?? []) inputs.add(dependency)
  return changedFiles.find(file => !testFile.test(file)
    && (inputs.has(file) || /^apps\/worker\/(?:src|artifacts)\//.test(file)))
}

/** Reverse import reachability, like Vitest related/changed, with separate package test inventories. */
export function selectAffectedFiles({ suite, changedFiles, sources, exports = {}, coverageMap, coverageReason }) {
  const full = reason => ({ scope: 'full', files: [], reason })
  if (!['unit', 'integration', 'lint', 'typecheck'].includes(suite)) return full('This suite requires a full run.')
  if (changedFiles.some(ciInfrastructureFile)) return full('Shared CI infrastructure changed.')
  if (changedFiles.some(file => codeFile.test(file) && !sources.has(file))) return full('A source file was removed.')
  // Glob dependencies cannot be represented by one literal import edge.
  if ([...sources.values()].some(text => /import\.meta\.glob\s*\(/.test(text))) return full('Glob imports require a full run.')
  const useCoverage = suite === 'integration' && usableIntegrationCoverage(coverageMap)
  const recordedSources = new Set(useCoverage ? Object.values(coverageMap.coverage).flat() : [])
  const staticChanges = useCoverage ? changedFiles.filter(file => !recordedSources.has(file)) : changedFiles
  const dependents = new Map()
  const dependencies = new Map()
  for (const [file, text] of sources) {
    const targets = [...imports(text).map(specifier => resolveImport(file, specifier, sources, exports)),
      ...runtimeDependencies(file, text, sources)].filter(Boolean)
    dependencies.set(file, targets)
    for (const target of targets) dependents.set(target, [...dependents.get(target) ?? [], file])
  }
  const bundleInput = suite === 'integration' && changedWorkerBundleInput(changedFiles, dependencies)
  if (bundleInput) return full(`A Worker bundle input changed: ${bundleInput}`)
  const unresolved = suite === 'integration' && changedFiles.find(file => !testFile.test(file)
    && /^(?:apps|packages|scripts|fixtures)\//.test(file)
    && (!/\.(?:md|mdx)$/.test(file) || /\/fixtures?\//.test(file))
    && !dependents.has(file) && !recordedSources.has(file))
  if (unresolved) return full(`A changed runtime input has no resolved dependency: ${unresolved}`)
  const affected = new Set(staticChanges)
  const pending = [...affected]
  for (let index = 0; index < pending.length; index++) {
    for (const file of dependents.get(pending[index]) ?? []) {
      if (!affected.has(file)) { affected.add(file); pending.push(file) }
    }
  }
  let files
  let staticFallbackFiles = []
  let missingRecords = []
  if (suite === 'integration') {
    files = [...affected].filter(file => sources.has(file) && integrationFile.test(file))
    if (useCoverage) {
      const changed = new Set(changedFiles)
      const inventory = new Set(coverageMap.testFiles)
      missingRecords = [...sources.keys()].filter(file => integrationFile.test(file)
        && inventory.has(file) && !Object.hasOwn(coverageMap.coverage, file))
      const staticTests = new Set([...coverageMap.staticTests ?? [], ...missingRecords])
      const staticSelection = staticTests.size ? selectAffectedFiles({ suite, changedFiles, sources, exports }) : undefined
      if (staticSelection?.scope === 'full') return staticSelection
      const staticAffected = new Set(staticSelection?.files ?? [])
      staticFallbackFiles = missingRecords.filter(file => staticAffected.has(file)).sort()
      for (const file of sources.keys()) {
        if (integrationFile.test(file) && (changed.has(file) || !inventory.has(file)
          || staticTests.has(file) && staticAffected.has(file)
          || coverageMap.coverage[file]?.some(path => changed.has(path)))) files.push(file)
      }
    }
  }
  else if (suite === 'unit') {
    files = [...affected].filter(file => sources.has(file) && testFile.test(file)
      && !(file.startsWith('apps/api/') && /\.(?:integration|acceptance)\.test\.ts$/.test(file))
      && (projects.some(project => file.startsWith(`${project}/`)) || file.startsWith('scripts/')))
  } else if (suite === 'lint') {
    files = changedFiles.filter(file => sources.has(file) && /\.[cm]?[jt]sx?$/.test(file)
      && projects.some(project => file.startsWith(`${project}/`)))
  } else {
    files = [...affected].filter(file => sources.has(file) && /\.tsx?$/.test(file)
      && projects.some(project => file.startsWith(`${project}/`)))
  }
  let reason = 'Static import reachability from changed files.'
  if (suite === 'integration') {
    reason = useCoverage
      ? `Coverage map ${coverageMap.commit}; changed/new tests included; static selection for ${missingRecords.length} missing coverage records, ${staticChanges.length} unrecorded changes and subprocess tests.`
      : `Static import reachability: ${coverageReason ?? 'no usable coverage map'}.`
  }
  return { scope: 'affected', files: [...new Set(files)].sort(), reason,
    ...(useCoverage ? { staticFallbackFiles } : {}) }
}

/** Read the snapshot tree against an explicit ancestor or its default branch merge-base. */
export function affectedSnapshot(commit, suite, cwd = process.cwd(), defaultRef = 'origin/main', baseCommit,
  coverageMaps = [], preparedCoverage) {
  cwd = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8' }).trim()
  const git = (args, env) => execFileSync('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
  if (!baseCommit && git(['rev-list', '--parents', '-n', '1', commit]).split(' ').length > 2) {
    return { scope: 'full', files: [], reason: 'Merge commits require a full run.' }
  }
  let base
  if (baseCommit) {
    try {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseCommit)) throw new Error('Invalid base SHA.')
      git(['merge-base', '--is-ancestor', baseCommit, commit])
      base = baseCommit
    } catch {
      return { scope: 'full', files: [], reason: 'baseCommit is unavailable or is not an ancestor of the resolved commit.' }
    }
  } else {
    try {
      if (git(['rev-parse', '--verify', defaultRef]) === git(['rev-parse', commit])) {
        return { scope: 'full', files: [], reason: 'The commit is the workspace default branch head.' }
      }
      base = git(['merge-base', commit, defaultRef])
    }
    catch { return { scope: 'full', files: [], reason: 'No merge-base with the default branch is available.' } }
  }
  const changedFiles = git(['diff', '--name-only', '--no-renames', '-z', base, commit]).split('\0').filter(Boolean)
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ci-selection-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(directory, 'index') }
    git(['read-tree', commit], env)
    const tree = join(directory, 'tree')
    git(['checkout-index', '--all', `--prefix=${tree}/`], env)
    const paths = git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean)
    const sources = new Map(paths.map(file => [file, codeFile.test(file) ? readFileSync(join(tree, file), 'utf8') : '']))
    const manifest = sources.get('packages/contracts/package.json')
    const exports = manifest ? JSON.parse(manifest).exports : {}
    const coverage = suite === 'integration' ? preparedCoverage ?? ancestorCoverage(git, commit, coverageMaps) : {}
    const { changedFiles: coverageChanges = [], coverageMap, coverageReason } = coverage
    return selectAffectedFiles({ suite, changedFiles: [...new Set([...changedFiles, ...coverageChanges])],
      sources, exports, coverageMap, coverageReason })
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

/** Git history, rather than wall-clock age, determines whether a map still describes this runtime. */
function ancestorCoverage(git, commit, maps) {
  const candidates = maps.filter(usableIntegrationCoverage)
  if (!candidates.length) return { coverageReason: 'no usable coverage map' }
  const ancestors = git(['rev-list', commit]).split('\n')
  for (const ancestor of ancestors) {
    const coverageMap = candidates.find(map => map.commit === ancestor)
    if (!coverageMap) continue
    const changedFiles = git(['diff', '--name-only', '--no-renames', '-z', ancestor, commit]).split('\0').filter(Boolean)
    if (changedFiles.some(ciInfrastructureFile)) return { coverageReason: 'coverage map predates lockfile or CI infrastructure changes' }
    return { coverageMap, changedFiles }
  }
  return { coverageReason: 'no coverage map from an ancestor commit' }
}
