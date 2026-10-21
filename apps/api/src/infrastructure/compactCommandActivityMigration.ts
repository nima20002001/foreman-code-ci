/** Activity reads need only these receipt fields, never the retained response
 * snapshot. Generated values keep every insert/update on the receipt authority. */
export const compactCommandActivityMigration = {
  version: 282504,
  sql: `alter table management_command_receipts
    add column activity_status text generated always as (result->>'status') stored,
    add column activity_control jsonb generated always as (result->'acceptedControl') stored,
    add column activity_acknowledgment jsonb generated always as (result->'providerAcknowledgment') stored;`,
}
