import { exclusiveIntegrationFiles, requirements, userSystemdIntegrationFiles } from './integrationScheduling.mjs'

/** @param {string} file */
export function requiresUserSystemd(file) {
  return userSystemdIntegrationFiles.has(file)
}

/** Place user-systemd files first, then balance remaining durations by computer speed.
 * Files without a recorded duration count as the median.
 * @param {readonly string[]} files
 * @param {Readonly<Record<string, number>>} durations
 * @param {import('./ciHost.js').CiPartition} partition
 * @returns {string[]} */
export function integrationPartition(files, durations, partition) {
  if (partition.tier) {
    // A tiered request plans its fast and slow files separately; each part sees only its own tier.
    const slow = new Set(partition.slowFiles ?? [])
    files = files.filter(file => slow.has(file) === (partition.tier === 'slow'))
  }
  const valid = value => typeof value === 'number' && Number.isFinite(value) && value > 0
  const known = files.map(file => durations[file]).filter(valid).sort((a, b) => a - b)
  const fallback = known.length ? known[Math.floor(known.length / 2)] : 1
  const weight = file => valid(durations[file]) ? durations[file] : fallback
  const loads = Array(partition.count).fill(0)
  const speed = index => partition.weights?.[index] ?? 1
  const owner = new Map()
  const heavy = partition.targetDurationMs
    ? new Set(files.filter(file => weight(file) >= partition.targetDurationMs))
    : new Set([...requirements.keys(), ...exclusiveIntegrationFiles])
  const heavyCounts = Array(partition.count).fill(0)
  const indexes = Array.from({ length: partition.count }, (_, index) => index)
  const hostFiles = new Set(partition.hostIndexes ? files.filter(requiresUserSystemd) : [])
  const ordered = [...files].sort((left, right) => Number(hostFiles.has(right)) - Number(hostFiles.has(left))
    || Number(heavy.has(right)) - Number(heavy.has(left))
    || weight(right) - weight(left) || (left < right ? -1 : 1))
  for (const file of ordered) {
    // Heavy files use each partition once per round before host speed breaks ties.
    const isHeavy = heavy.has(file)
    let eligible = indexes
    if (partition.hostIndexes && hostFiles.has(file)) {
      eligible = partition.hostIndexes
    }
    if (partition.targetDurationMs && !isHeavy && !requiresUserSystemd(file)) {
      const withoutHeavy = eligible.filter(index => heavyCounts[index] === 0)
      if (withoutHeavy.length) eligible = withoutHeavy
    }
    if (!eligible.length) throw new Error('Partition plan has no eligible slice for an integration file.')
    let lightest = eligible[0]
    const finish = index => (loads[index] + weight(file)) / speed(index)
    for (const index of eligible.slice(1)) {
      const fewerHeavy = isHeavy && heavyCounts[index] < heavyCounts[lightest]
      const sameHeavy = !isHeavy || heavyCounts[index] === heavyCounts[lightest]
      if (fewerHeavy || (sameHeavy && finish(index) < finish(lightest))) lightest = index
    }
    if (isHeavy) heavyCounts[lightest]++
    loads[lightest] += weight(file)
    owner.set(file, lightest)
  }
  return files.filter(file => owner.get(file) === partition.index)
}
