-- Shape and on-disk size of one dataset's profiles.  psql -v ds=<dataset id> -f stats.sql
\pset footer off
with c as (
  select p.id, p.name, count(ps.*) n
  from merlin.profile p left join merlin.profile_segment ps on ps.dataset_id = p.dataset_id and ps.profile_id = p.id
  where p.dataset_id = :ds group by p.id, p.name
)
select :ds as dataset_id,
       count(*) as profiles,
       sum(n) as segments,
       min(n) as seg_min,
       percentile_disc(0.5) within group (order by n) as seg_p50,
       percentile_disc(0.95) within group (order by n) as seg_p95,
       max(n) as seg_max,
       (select name from c order by n desc limit 1) as largest_profile,
       pg_size_pretty(pg_relation_size(('merlin.profile_segment_' || :ds)::regclass)) as heap,
       pg_size_pretty(pg_indexes_size(('merlin.profile_segment_' || :ds)::regclass)) as indexes,
       pg_size_pretty(pg_total_relation_size(('merlin.profile_segment_' || :ds)::regclass)) as total,
       round(pg_total_relation_size(('merlin.profile_segment_' || :ds)::regclass)::numeric / greatest(sum(n), 1)) as bytes_per_segment
from c;
