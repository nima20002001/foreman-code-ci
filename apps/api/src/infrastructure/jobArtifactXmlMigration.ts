export const jobArtifactXmlMigration = {
  version: 2026100607,
  sql: `
    alter table file_revisions drop constraint file_revisions_class_check;
    alter table file_revisions add constraint file_revisions_class_check check (
      (origin in ('upload','agent_output','agent_copy') and media_type in (
        'image/png','image/jpeg','image/webp','image/gif','application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/markdown','application/zip')) or
      (origin='job_output' and media_type in (
        'text/plain','application/json','application/xml','text/html','application/zip','application/gzip','application/octet-stream'))
    );
  `,
} as const
