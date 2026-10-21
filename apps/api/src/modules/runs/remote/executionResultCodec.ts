import { ExecutionResultSchema } from '@foreman-code/contracts'
import type { RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import { RemoteResultDictionarySchema, type RemoteResultDictionary,
  type RemoteWorkflowPhysicalReadout } from '@foreman-code/contracts/remote-workflow-physical'
import { DEVICE_JSON_CONTINUATION_LIMIT } from '@foreman-code/contracts/device-application'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'

type ResultPath = Array<string | number>
type Container = Record<string | number, unknown>

function parentAt(value: unknown, path: ResultPath): Container | undefined {
  let parent = value
  for (const key of path.slice(0, -1)) {
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, key)) return undefined
    parent = (parent as Container)[key]
  }
  return parent && typeof parent === 'object' ? parent as Container : undefined
}

export function historyResultPaths(prefix: ResultPath = []): ResultPath[] {
  return [[...prefix, 'terminalResult'], [...prefix, 'terminalTurn', 'result']]
}

function receiptResultPaths(receipt: RemoteOperationReceipt, prefix: ResultPath): ResultPath[] {
  return [[...prefix, 'terminal', 'result'], [...prefix, 'retainedReviewer', 'result'],
    ...(receipt.reviewTurns ?? []).map((_turn, index) => [...prefix, 'reviewTurns', index, 'result'])]
}

export function physicalResultPaths(readout: RemoteWorkflowPhysicalReadout, prefix: ResultPath = []): ResultPath[] {
  return [...receiptResultPaths(readout.receipt, [...prefix, 'receipt']),
    ...historyResultPaths([...prefix, 'history']), [...prefix, 'output', 'result']]
}

/** Only explicit domain result slots are replaced; arbitrary user JSON remains untouched. */
export function encodeResultCopies(value: unknown, paths: ResultPath[]): RemoteResultDictionary {
  const data = structuredClone(value)
  const results: RemoteResultDictionary['results'] = []
  const locations: RemoteResultDictionary['locations'] = []
  const indexes = new Map<string, number>()
  for (const path of paths) {
    const parent = parentAt(data, path)
    const key = path.at(-1)!
    if (!parent || !Object.hasOwn(parent, key) || parent[key] === undefined) continue
    const result = ExecutionResultSchema.parse(parent[key])
    const serialized = canonicalGraphJson(result, DEVICE_JSON_CONTINUATION_LIMIT)
    let index = indexes.get(serialized)
    if (index === undefined) {
      index = results.length
      results.push(result)
      indexes.set(serialized, index)
    }
    Object.defineProperty(parent, key, { value: null, enumerable: true, writable: true, configurable: true })
    locations.push({ path, index })
  }
  return RemoteResultDictionarySchema.parse({ kind: 'execution-result-dictionary', data, results, locations })
}

export function decodeResultCopies(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { kind?: unknown }).kind !== 'execution-result-dictionary') return raw
  const dictionary = RemoteResultDictionarySchema.parse(raw)
  const uniqueResults = new Set<string>()
  for (const result of dictionary.results) {
    const serialized = canonicalGraphJson(result, DEVICE_JSON_CONTINUATION_LIMIT)
    if (uniqueResults.has(serialized)) throw new Error('Execution result dictionary repeats a payload')
    uniqueResults.add(serialized)
  }
  const value = structuredClone(dictionary.data)
  const referenced = new Set<number>()
  for (const location of dictionary.locations) {
    const parent = parentAt(value, location.path)
    const key = location.path.at(-1)!
    const result = dictionary.results[location.index]
    if (!parent || !Object.hasOwn(parent, key) || parent[key] !== null || !result) {
      throw new Error('Execution result dictionary location changed')
    }
    Object.defineProperty(parent, key, { value: result, enumerable: true, writable: true, configurable: true })
    referenced.add(location.index)
  }
  if (referenced.size !== dictionary.results.length) throw new Error('Execution result dictionary has an unbound payload')
  return value
}
