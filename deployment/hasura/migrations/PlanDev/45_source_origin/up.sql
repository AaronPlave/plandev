alter table merlin.source add column origin text;

create unique index source_origin_unique on merlin.source (owner, origin) where origin is not null;

comment on column merlin.source.origin is e''
  'Where the source''s content comes from, when that is a stable place rather than an upload, e.g. '
  '"workspace:<workspace id>:<path>" for a SeqDev workspace file. Its identity: unique per owner, so re-importing '
  'from the same place adds a revision to the same source, and nothing else (a name, a content hash) is used to find it.';

call migrations.mark_migration_applied(45);
