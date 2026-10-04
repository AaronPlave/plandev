-- Creates a scratch banananation plan 'profile-bench-<n>' with :n activities spread over :days days.
-- Usage: psql ... -v n=10000 -v days=365 [-v fast=1] -f make-plans.sql   (then simulate it; see the doc)
-- fast=1 (superuser only) skips the directive triggers for this insert. The deferred anchor validation is
-- quadratic in plan size (10k directives ≈ 1 min, 100k did not finish in 15 min). Skipped: generated names,
-- validation rows, plan revision bump, change log. Simulation does not need them; don't use it on real plans.
-- Activity mix (round robin): BiteBanana (flag + fruit), GrowBanana (fruit rate up/down + plant),
-- PickBanana (fruit), ChangeProducer (producer string). Each produces 1-3 profile segments.
begin;
insert into merlin.plan (name, model_id, duration, start_time, owner, updated_by)
  select 'profile-bench-' || :'n', (select id from merlin.mission_model order by id limit 1),
         make_interval(days => :days), '2031-01-01T00:00:00Z', 'test', 'test';
\if :{?fast}
set local session_replication_role = replica;
\endif
insert into merlin.activity_directive (plan_id, name, type, start_offset, arguments)
  select p.id, 'bench ' || i,
         (array['BiteBanana','GrowBanana','PickBanana','ChangeProducer'])[1 + i % 4],
         make_interval(secs => (i::float8 * :days * 86400) / :n),
         case i % 4
           when 0 then jsonb_build_object('biteSize', 1 + (i / 4) % 2)
           when 1 then jsonb_build_object('quantity', 1, 'growingDuration', 600000000) -- 10 min, µs
           when 2 then jsonb_build_object('quantity', 1)
           else jsonb_build_object('producer', 'P' || (i % 7))
         end
  from generate_series(0, :n - 1) i, merlin.plan p
  where p.name = 'profile-bench-' || :'n';
commit;
select id as plan_id, (select count(*) from merlin.activity_directive d where d.plan_id = p.id) as activities
  from merlin.plan p where name = 'profile-bench-' || :'n';
