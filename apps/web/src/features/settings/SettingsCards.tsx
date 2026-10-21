import type { ReactNode } from 'react'
import { Icon } from '../../shared/ui/nocturne'
import './settingsExperience.css'

export function SettingsOverview({ title, children }: { title: string; children: ReactNode }) {
  return <section className="settings-overview" aria-label={title}>
    <header className="settings-experience-heading"><h1>{title}</h1></header>
    <div className="settings-choice-grid">{children}</div>
  </section>
}
export function SettingsChoice({ title, summary, onSelect, icon = 'bot', footer }: {
  title: string; summary: readonly { label: string; value: string }[];
  onSelect(): void; icon?: 'bot' | 'settings';
  /** One-click actions shown under the summary, outside the card's open button. */
  footer?: ReactNode;
}) {
  return <div className="settings-choice">
    <button type="button" className="settings-choice-open" onClick={onSelect} aria-label={`Edit ${title} defaults`}>
      <span className="settings-choice-heading"><span className="settings-choice-icon"><Icon name={icon} size={21} /></span>
        <span><strong>{title}</strong></span><Icon name="chevron" size={17} /></span>
      <span className="settings-choice-summary">{summary.map((item) => <span className="settings-summary-row" key={item.label}><span>{item.label}</span><strong title={item.value}>{item.value}</strong></span>)}</span>
    </button>
    {footer ? <div className="settings-choice-footer">{footer}</div> : null}
  </div>
}
