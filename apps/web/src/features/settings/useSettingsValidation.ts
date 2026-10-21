import { useEffect, useRef } from 'react'

import { focusFirstInvalid, type FieldIssue } from './fieldValidation'

export function useSettingsValidation(issues: readonly FieldIssue[] | undefined) {
  const ref = useRef<HTMLElement>(null)
  useEffect(() => { if (issues?.length) focusFirstInvalid(ref.current) }, [issues])
  return ref
}
