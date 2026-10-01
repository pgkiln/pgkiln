-- App Builder → Activity → Top SQL reads pg_stat_statements. Create the
-- extension when the server has it; it only collects statistics once the
-- server loads it (shared_preload_libraries = 'pg_stat_statements'). Without
-- the privilege to create it, the builder page explains what to do.
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_stat_statements') then
    create extension if not exists pg_stat_statements;
  end if;
exception when insufficient_privilege then
  raise notice 'pg_stat_statements not created (needs a superuser): %', sqlerrm;
end $$;
