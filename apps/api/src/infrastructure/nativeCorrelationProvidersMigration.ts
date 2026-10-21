export const nativeCorrelationProvidersMigration = {
  version: 2026100601,
  sql: `alter table run_native_correlations drop constraint run_native_correlations_provider_check;
    alter table run_native_correlations add constraint run_native_correlations_provider_check
      check (provider in ('codex','opencode','claude'));`,
} as const
