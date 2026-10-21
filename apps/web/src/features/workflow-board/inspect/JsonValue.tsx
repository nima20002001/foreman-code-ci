import { memo, useMemo } from 'react'
import { useInspectionPresentation } from './presentation'

/** Private, exact values are serialized only when their inspector is mounted.
 * No strings are interpreted as markup and no content is put in graph nodes. */
export const JsonValue = memo(function JsonValue({ value, label }: { value: unknown; label: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2), [value])
  return <pre className="run-inspection-json" aria-label={label} tabIndex={0}>{text}</pre>
})

/** Disclosure state is local presentation; the value always stays in Query. */
export function JsonDisclosure({ disclosureKey, summary, label, value }: {
  disclosureKey: string; summary: string; label: string; value: unknown
}) {
  const open = useInspectionPresentation((state) => !!state.open[disclosureKey])
  return <details open={open} onToggle={(event) => useInspectionPresentation.getState().setOpen(disclosureKey, event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open ? <JsonValue label={label} value={value} /> : null}
  </details>
}
