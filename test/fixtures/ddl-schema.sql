-- A schema with one of everything, for test/ddl.test.ts (created as ddl_a).
create type mood as enum ('sad', 'ok', 'happy');
create type money_pair as (amount numeric(12,2), currency text);
create domain email as text check (value ~ '@') ;
create sequence ticket_no as int start with 100 increment by 5;
create table dept (
  id int generated always as identity primary key,
  name text not null collate "C" unique,
  budget numeric(12,2) default 0 check (budget >= 0),
  created timestamptz not null default now()
);
create table emp (
  id bigserial primary key,
  dept_id int references dept on delete cascade,
  name text not null,
  email email,
  feeling mood default 'ok',
  pay money_pair,
  salary numeric(10,2),
  yearly numeric(12,2) generated always as (salary * 12) stored,
  ticket int default nextval('ticket_no')
);
comment on table emp is 'Employees';
comment on column emp.name is 'Full name';
create index emp_name on emp (lower(name));
create table events (id bigint, at date not null, primary key (id, at)) partition by range (at);
create table events_2026 partition of events for values from ('2026-01-01') to ('2027-01-01');
create index events_at on events (at);
create function raise_pay(p_pct numeric) returns int language plpgsql as $$
begin
  update emp set salary = salary * (1 + p_pct / 100);
  return 1;
end $$;
create function dept_count() returns bigint language sql begin atomic select count(*) from dept; end;
create view rich as select id, name from emp where salary > 5000;
create view rich_names as select name from rich;
create materialized view dept_totals as select d.name, count(e.id) as people from dept d left join emp e on e.dept_id = d.id group by d.name;
create function touch() returns trigger language plpgsql as $$ begin new.created := now(); return new; end $$;
create trigger dept_touch before update on dept for each row execute function touch();
alter table emp enable row level security;
create policy own_dept on emp for select to public using (dept_id is not null);
comment on function raise_pay(numeric) is 'Raise everyone';
grant select on emp to public;
revoke execute on function raise_pay(numeric) from public;
