import { useEffect, useRef, useState } from 'react'
import type { CiRunJob } from '@foreman-code/contracts'
import type { EdgePulse } from '../../graph/SignalEdgeShape'
import { ciGroupStates, ciTransfers, type CiGroupStates } from './ciServer'

const FLIGHT_MS = 1400, RESULT_DELAY_MS = 1700, SETTLE_MS = 2200
/** Lights for CI requests leaving an Agent and results returning to it, keyed by the Agent's node. The first read
 * replays nothing, and nothing travels under reduced motion. */
export function useCiTransfers(jobs: readonly CiRunJob[] | undefined, reduced: boolean) {
  const previous = useRef<CiGroupStates | undefined>(undefined)
  const [flights, setFlights] = useState<{ nodeId: string; pulse: EdgePulse }[]>([])
  useEffect(() => {
    if (!jobs) return
    const next = ciGroupStates(jobs)
    const transfers = ciTransfers(previous.current, next)
    previous.current = next
    if (reduced || !transfers.length) return
    const now = performance.now()
    const requested = new Set(transfers.filter((transfer) => transfer.direction === 'request').map((transfer) => transfer.key.split(':')[0]))
    setFlights((current) => [...current, ...transfers.map((transfer) => ({ nodeId: transfer.nodeId, pulse: {
      key: transfer.key, reversed: transfer.direction === 'result',
      signal: transfer.direction === 'request' ? 'task' as const : transfer.outcome === 'passed' ? 'grant' as const : 'error' as const,
      word: transfer.direction === 'request' ? 'CI request' : `CI ${transfer.outcome}`,
      startsAt: now + (transfer.direction === 'result' && requested.has(transfer.key.split(':')[0]) ? RESULT_DELAY_MS : 0) } }))])
  }, [jobs, reduced])
  useEffect(() => {
    if (!flights.length) return
    const ends = flights.map((flight) => flight.pulse.startsAt + FLIGHT_MS + SETTLE_MS)
    const timer = setTimeout(() => {
      const now = performance.now()
      setFlights((current) => current.filter((flight) => flight.pulse.startsAt + FLIGHT_MS + SETTLE_MS > now))
    }, Math.max(0, Math.min(...ends) - performance.now()))
    return () => clearTimeout(timer)
  }, [flights])
  const byNode = new Map<string, EdgePulse[]>()
  for (const flight of flights) byNode.set(flight.nodeId, [...byNode.get(flight.nodeId) ?? [], flight.pulse])
  return byNode
}
