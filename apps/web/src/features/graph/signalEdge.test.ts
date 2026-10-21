import { defaultAgentForHarness } from '../agents/agentSettings'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { describe, expect, it } from 'vitest'
import { AGENT_NODE_SIZE, edgeBend, floatingCurve, lineBend, relationshipLines, agentNodeFacts, agentSettingRows } from './signalEdge'

describe('floating agent connections', () => {
  it('leaves and enters each circle on its rim, not at a fixed side handle', () => {
    const curve = floatingCurve({ x: 0, y: 0 }, { x: 600, y: 0 }, 0)
    const [start, end] = [...curve.path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => Number(match[1]))
      .filter((_, index, all) => index === 0 || index === all.length - 1)
    expect(start).toBeCloseTo(AGENT_NODE_SIZE / 2 + 7)
    expect(end).toBeCloseTo(600 - AGENT_NODE_SIZE / 2 - 7)
    expect(curve.mid.angle).toBeCloseTo(0)
  })
  it('fans parallel connections out instead of overlapping them', () => {
    expect(new Set([0, 1, 2].map((index) => edgeBend(index, true))).size).toBe(3)
  })
  it('uses the independently resized rims at either end of a handoff', () => {
    const curve = floatingCurve({ x: 0, y: 0 }, { x: 600, y: 0 }, 0, undefined,
      { width: 360, height: 208 }, { width: 272, height: 320 })
    expect(curve.path).toBe('M 187,0 Q 300,0 457,0')
    const vertical = floatingCurve({ x: 0, y: 0 }, { x: 0, y: 600 }, 0, undefined,
      { width: 360, height: 208 }, { width: 272, height: 320 })
    expect(vertical.path).toBe('M 0,111 Q 0,300 0,433')
  })
  it('enters a box-shaped node at its border, also on a diagonal', () => {
    const curve = floatingCurve({ x: 0, y: 0 }, { x: 400, y: 400 }, 0, undefined, undefined,
      { width: 184, height: 212, box: true })
    // The diagonal meets the 184-wide box at its side (x offset 92), not inside its corner as an ellipse would.
    expect(curve.path.endsWith(`${(400 - 92 - 7 / Math.SQRT2).toFixed(1)},${(400 - 92 - 7 / Math.SQRT2).toFixed(1)}`)).toBe(true)
  })
})

describe('relationship lines', () => {
  it('draws an approval beside a handoff on the handoff line, flipped when it runs the other way', () => {
    const { lines, alias } = relationshipLines([
      { id: 'review', kind: 'approval' as const, source: 'a', target: 'b' },
      { id: 'handoff', kind: 'execution' as const, source: 'a', target: 'b' },
      { id: 'back', kind: 'approval' as const, source: 'c', target: 'a' },
      { id: 'ca', kind: 'execution' as const, source: 'a', target: 'c' },
      { id: 'lonely', kind: 'approval' as const, source: 'a', target: 'd' },
    ])
    expect(lines.map((line) => [line.id, line.members.map((member) => member.id)])).toEqual([['handoff', ['handoff', 'review']], ['ca', ['ca', 'back']], ['lonely', ['lonely']]])
    expect(alias.get('review')).toEqual({ lineId: 'handoff', flipped: false })
    expect(alias.get('back')).toEqual({ lineId: 'ca', flipped: true })
  })
})

it('shows actual Claude facts without invented effort or Claude variant', () => {
  const agent = defaultAgentForHarness('claude', 'claude-1', 'Claude', savedClaudeConfiguration)
  expect(agentNodeFacts(agent)).toMatchObject({ harness: 'claude', harnessLabel: 'Claude', model: savedClaudeConfiguration.model })
  expect(agentNodeFacts(agent).meta).toEqual([{ label: 'Role', value: 'Agent' }])
  expect(agentSettingRows(agent)).toContainEqual({ label: 'Sandbox', value: 'Full access' })
  expect(agentSettingRows(agent)).not.toContainEqual(expect.objectContaining({ label: 'Variant' }))
})

it('labels recorded OpenCode agent facts as retired without presenting execution permissions', () => {
  const agent = { id: 'retired-agent', name: 'Recorded agent', harness: 'opencode' as const,
    model: 'provider/recorded-model' }
  expect(agentNodeFacts(agent)).toMatchObject({ harness: 'opencode',
    harnessLabel: 'Retired harness (OpenCode): read-only', model: 'provider/recorded-model' })
})

describe('edge direction from node positions', () => {
  const path = (target: { x: number; y: number }) => {
    const source = { x: 0, y: 0 }
    const curve = floatingCurve(source, target, lineBend(source, target))
    const [, control] = [...curve.path.matchAll(/(-?[\d.]+),(-?[\d.]+)/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) }))
    return { curve, control: control! }
  }
  it('is straight when the nodes are aligned', () => {
    expect(path({ x: 0, y: 300 }).control.x).toBeCloseTo(0)
    expect(path({ x: 300, y: 0 }).control.y).toBeCloseTo(0)
  })
  it('bends left toward a target on the left and right toward one on the right', () => {
    expect(path({ x: -150, y: 300 }).control.x).toBeLessThan(-75)
    expect(path({ x: 150, y: 300 }).control.x).toBeGreaterThan(75)
  })
  it('routes a line back up on the other side of its forward line', () => {
    const forward = path({ x: 150, y: 300 }).control.x - 75
    const back = floatingCurve({ x: 150, y: 300 }, { x: 0, y: 0 }, lineBend({ x: 150, y: 300 }, { x: 0, y: 0 }))
    const control = Number(/Q (-?[\d.]+),/.exec(back.path)![1]) - 75
    expect(Math.sign(control)).toBe(-Math.sign(forward))
  })
})
