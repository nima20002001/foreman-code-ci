import { expect, it } from 'vitest'
import { computerLoad, type ComputerLoadInput } from './computerLoad'

const idle: ComputerLoadInput = { online: true, cpuPercent: 5, memoryPercent: 20, diskUsedPercent: 30, workloads: 0 }

it('reports unknown and offline presence before any reading', () => {
  expect(computerLoad({ ...idle, online: null, cpuPercent: 99 })).toBe('unknown')
  expect(computerLoad({ ...idle, online: false, cpuPercent: 99 })).toBe('offline')
})
it('grades CPU from plenty of capacity to near its limits', () => {
  expect(computerLoad({ ...idle, cpuPercent: 49.9 })).toBe('calm')
  expect(computerLoad({ ...idle, cpuPercent: 50 })).toBe('busy')
  expect(computerLoad({ ...idle, cpuPercent: 75 })).toBe('heavy')
  expect(computerLoad({ ...idle, cpuPercent: 90 })).toBe('saturated')
})
it('grades memory and disk with their own thresholds', () => {
  expect(computerLoad({ ...idle, memoryPercent: 60 })).toBe('busy')
  expect(computerLoad({ ...idle, memoryPercent: 80 })).toBe('heavy')
  expect(computerLoad({ ...idle, memoryPercent: 92 })).toBe('saturated')
  expect(computerLoad({ ...idle, diskUsedPercent: 79 })).toBe('calm')
  expect(computerLoad({ ...idle, diskUsedPercent: 90 })).toBe('heavy')
  expect(computerLoad({ ...idle, diskUsedPercent: 96 })).toBe('saturated')
})
it('lets the most loaded signal decide', () => {
  expect(computerLoad({ ...idle, cpuPercent: 55, memoryPercent: 85, diskUsedPercent: 96 })).toBe('saturated')
  expect(computerLoad({ ...idle, cpuPercent: 80, memoryPercent: 10 })).toBe('heavy')
})
it('counts running Agents and CI jobs as load without saturating on count alone', () => {
  expect(computerLoad({ ...idle, workloads: 1 })).toBe('busy')
  expect(computerLoad({ ...idle, workloads: 8 })).toBe('heavy')
  expect(computerLoad({ ...idle, workloads: 500 })).toBe('heavy')
})
it('ignores unknown readings instead of treating them as idle or full', () => {
  const blind = { online: true, cpuPercent: null, memoryPercent: null, diskUsedPercent: null, workloads: 0 }
  expect(computerLoad(blind)).toBe('calm')
  expect(computerLoad({ ...blind, workloads: 2 })).toBe('busy')
})
it('grades cloud CI services by machines in use', () => {
  const cloud = { online: true, cpuPercent: null, memoryPercent: null, diskUsedPercent: null, workloads: 0 }
  expect(computerLoad({ ...cloud, ciSlotsPercent: 25 })).toBe('calm')
  expect(computerLoad({ ...cloud, ciSlotsPercent: 75 })).toBe('heavy')
  expect(computerLoad({ ...cloud, ciSlotsPercent: 100 })).toBe('saturated')
})
