export const bugReportLifecycleMigration = { version: 2026101220, sql: `
  alter table bug_reports drop constraint bug_reports_status_check;
  alter table bug_reports add constraint bug_reports_status_check
    check (status in ('open','triaged','fixed','wont-fix','duplicate'));
  alter table bug_reports add column title_key text;
  update bug_reports set title_key=lower(regexp_replace(btrim(record->>'title'),'\\s+',' ','g'));
  alter table bug_reports alter column title_key set not null;
  alter table bug_reports drop column fingerprint;
  create index bug_reports_title_idx on bug_reports(workspace_id,title_key);
` } as const
