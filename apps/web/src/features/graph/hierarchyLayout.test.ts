import { describe, expect, it } from 'vitest'
import { layoutHierarchy } from './hierarchyLayout'

const box = (id: string) => ({ id, width: 156, height: 156 })

describe('hierarchy layout', () => {
  it('puts the entry on top and its children side by side in the next layer', () => {
    const positions = layoutHierarchy(['main', 'build', 'lint', 'unit'].map(box), [
      { source: 'main', target: 'build' }, { source: 'main', target: 'lint' }, { source: 'main', target: 'unit' },
    ], 'main')
    const children = ['build', 'lint', 'unit'].map((id) => positions.get(id)!)
    expect(new Set(children.map((point) => point.y)).size).toBe(1)
    expect(new Set(children.map((point) => point.x)).size).toBe(3)
    expect(children[0]!.y).toBeGreaterThan(positions.get('main')!.y + 156)
    // Children do not overlap and the entry sits centred above them.
    const sorted = [...children].sort((a, b) => a.x - b.x)
    expect(sorted[1]!.x - sorted[0]!.x).toBeGreaterThanOrEqual(156)
    expect(positions.get('main')!.x + 78).toBeCloseTo(sorted[1]!.x + 78)
  })

  it('layers by the longest path and keeps disconnected nodes in the first layer', () => {
    const positions = layoutHierarchy(['a', 'b', 'c', 'lonely'].map(box), [
      { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'a', target: 'c' },
    ], 'a')
    expect(positions.get('c')!.y).toBeGreaterThan(positions.get('b')!.y)
    expect(positions.get('lonely')!.y).toBe(positions.get('a')!.y)
    expect(positions.get('lonely')!.x).not.toBe(positions.get('a')!.x)
  })

  it('finishes on cycles and keeps the entry on top', () => {
    const positions = layoutHierarchy(['a', 'b', 'c'].map(box), [
      { source: 'a', target: 'b' }, { source: 'b', target: 'c' }, { source: 'c', target: 'a' }, { source: 'c', target: 'c' },
      { source: 'c', target: 'missing' },
    ], 'a')
    expect(positions.get('a')!.y).toBeLessThan(positions.get('b')!.y)
    expect(positions.get('b')!.y).toBeLessThan(positions.get('c')!.y)
    expect(layoutHierarchy([], []).size).toBe(0)
  })
})
