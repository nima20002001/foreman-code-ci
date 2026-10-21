/** @typedef {{ version: 1, commit: string, testFiles: string[], coverage: Record<string, string[]>, staticTests?: string[] }} IntegrationCoverage */
const integrationFile = /^apps\/api\/test\/[^/]+\.integration\.test\.ts$/
const relativeFile = /^(?!\/|[A-Za-z]:)[^\\\0]+$/
const repositoryFile = file => typeof file === 'string' && relativeFile.test(file)
  && file.split('/').every(part => part && part !== '.' && part !== '..')

/** Reports may be fragments; missing test records keep static selection. */
/** @param {unknown} value @returns {value is IntegrationCoverage} */
export function isIntegrationCoverage(value) {
  return value !== null && typeof value === 'object' && value.version === 1
    && typeof value.commit === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit)
    && Array.isArray(value.testFiles) && value.testFiles.length > 0
    && value.testFiles.every(file => repositoryFile(file) && integrationFile.test(file))
    && new Set(value.testFiles).size === value.testFiles.length
    && value.coverage !== null && typeof value.coverage === 'object' && !Array.isArray(value.coverage)
    && Object.entries(value.coverage).every(([file, paths]) => value.testFiles.includes(file)
      && Array.isArray(paths) && paths.every(repositoryFile))
    && (value.staticTests === undefined || Array.isArray(value.staticTests)
      && value.staticTests.every(file => value.testFiles.includes(file)))
}

/** @param {unknown} value @returns {value is IntegrationCoverage} */
export function completeIntegrationCoverage(value) {
  return isIntegrationCoverage(value) && value.testFiles.every(file => Object.hasOwn(value.coverage, file))
}

/** @param {unknown} value @returns {value is IntegrationCoverage} */
export function usableIntegrationCoverage(value) {
  return isIntegrationCoverage(value) && Object.keys(value.coverage).length > 0
}

/** @typedef {Omit<IntegrationCoverage, 'coverage'> & { sourceFiles: string[], coverage: Record<string, number[]> }} CompactIntegrationCoverage */

/** @param {IntegrationCoverage} map @returns {CompactIntegrationCoverage} */
export function compactIntegrationCoverage(map) {
  const sourceFiles = [...new Set(Object.values(map.coverage).flat())].sort()
  const indexes = new Map(sourceFiles.map((file, index) => [file, index]))
  return { ...map, sourceFiles, coverage: Object.fromEntries(Object.entries(map.coverage)
    .map(([file, paths]) => [file, paths.map(path => indexes.get(path))])) }
}

/** @param {unknown} value @returns {IntegrationCoverage} */
export function expandIntegrationCoverage(value) {
  if (isIntegrationCoverage(value)) return value
  if (!value || typeof value !== 'object' || !Array.isArray(value.sourceFiles)
    || !value.coverage || typeof value.coverage !== 'object') throw new Error('Invalid integration coverage transport.')
  const coverage = {}
  for (const [file, indexes] of Object.entries(value.coverage)) {
    if (!Array.isArray(indexes) || indexes.some(index => !Number.isSafeInteger(index)
      || index < 0 || index >= value.sourceFiles.length)) throw new Error('Invalid integration coverage source index.')
    coverage[file] = indexes.map(index => value.sourceFiles[index])
  }
  const map = { ...value, coverage }
  if (!isIntegrationCoverage(map)) throw new Error('Invalid integration coverage map.')
  return map
}
