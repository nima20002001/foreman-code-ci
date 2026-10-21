/** FIL-37. Register after fileStorageMigration (273601) and fileReferenceMigration (273636). */
export const fileReferenceAccessMigration = {
  version: 273637,
  sql: `
    create table run_reference_file_pins (
      run_id text not null references runs(id),
      file_id text not null,
      revision_id text not null,
      primary key (run_id,file_id),
      unique (run_id,file_id,revision_id),
      foreign key (file_id,revision_id) references file_revisions(file_id,revision_id)
    );
    create table run_reference_file_reads (
      run_id text not null,
      execution_id text not null references harness_executions(id),
      file_id text not null,
      revision_id text not null,
      read_at timestamptz not null,
      primary key (run_id,execution_id,file_id),
      foreign key (run_id,file_id,revision_id) references run_reference_file_pins(run_id,file_id,revision_id)
    );

    create function run_reference_pin_validate() returns trigger language plpgsql as $$
    begin
      perform 1 from runs r join files f on f.file_id=new.file_id
        join file_revisions v on v.file_id=f.file_id and v.revision_id=new.revision_id
        where r.id=new.run_id and f.state='ready' and f.workspace_id=r.workspace_id and
          ((f.scope_kind='workspace_reference' and f.workflow_id is null)
            or (f.scope_kind='workflow_reference' and f.workflow_id=r.workflow_id))
        for share of r,f;
      if not found then
        raise exception using errcode='23514', message='A Run may pin only a ready reference in its exact inherited scope.';
      end if;
      return new;
    end $$;
    create trigger run_reference_pin_validate before insert on run_reference_file_pins
      for each row execute function run_reference_pin_validate();

    create function run_reference_read_validate() returns trigger language plpgsql as $$
    begin
      perform 1 from harness_executions e
        join file_revisions v on v.file_id=new.file_id and v.revision_id=new.revision_id
        where e.id=new.execution_id and e.run_id=new.run_id and new.read_at>=v.created_at
        for share of e;
      if not found then
        raise exception using errcode='23514', message='Reference provenance must name the exact Run execution and a valid read time.';
      end if;
      return new;
    end $$;
    create trigger run_reference_read_validate before insert on run_reference_file_reads
      for each row execute function run_reference_read_validate();

    create function run_reference_provenance_immutable() returns trigger language plpgsql as $$
    begin
      raise exception 'Run reference pins and read provenance are immutable and must be retained.';
    end $$;
    create trigger run_reference_pins_immutable before update or delete on run_reference_file_pins
      for each row execute function run_reference_provenance_immutable();
    create trigger run_reference_reads_immutable before update or delete on run_reference_file_reads
      for each row execute function run_reference_provenance_immutable();
  `,
} as const
