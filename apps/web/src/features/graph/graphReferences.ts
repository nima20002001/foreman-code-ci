/** Small, shallow render-adapter comparisons; never compare a component tree or runtime history. */
export function sameFields<T extends object>(left: T, right: T): boolean {
  if (left === right) return true
  const keys = Object.keys(left) as Array<keyof T>
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]))
}

export function retainArray<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && previous.every((value, index) => value === next[index]) ? previous : next
}
