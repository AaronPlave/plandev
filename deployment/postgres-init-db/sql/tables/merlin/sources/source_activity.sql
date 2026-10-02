-- Activities of an imported revision: timed instances with a type, a name and the product's own metadata.
--
--   source_activity        one activity instance (a TOL ACT_START/ACT_END pair); partitioned by revision
--   source_activity_type   the revision's activity types with instance counts, written when it is published
--
-- Like resource storage, each ingest attempt loads activities into a standalone table of its own
-- (source_activity_<revision>_<attempt>), attached as the revision's partition on publish.

create table merlin.source_activity (
  revision_id integer not null,
  id integer not null,

  source_key text not null,
  type text not null,
  name text not null,
  category text,
  start_time timestamptz not null,
  end_time timestamptz not null,
  attributes jsonb not null default '{}'::jsonb,
  parameters jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,

  constraint source_activity_natural_key
    primary key (revision_id, id)
) partition by list (revision_id);

comment on table merlin.source_activity is e''
  'One activity instance of an imported revision. Read-only once published. A revision''s activities are an '
  'ordinary indexed table, not a time-series store: products carry up to about a million of them.';
comment on column merlin.source_activity.id is e''
  'Unique within the revision, in file order. With revision_id, the identity timeline selections refer to.';
comment on column merlin.source_activity.source_key is e''
  'The product''s own identifier for the instance (a TOL Instance ID), kept for provenance.';
comment on column merlin.source_activity.category is e''
  'The source-native grouping, such as a TOL activity''s subsystem attribute.';
comment on column merlin.source_activity.end_time is e''
  'For a TOL, start plus its span attribute; without one, the time of its ACT_END record, else the start. '
  '(TOL ACT_END records often carry the time they were written, not the end; it is kept in metadata.actEnd.)';
comment on column merlin.source_activity.attributes is e''
  'The product''s per-instance attributes (for a TOL: Color, legend, plan, subsystem, span, start), as JSON values.';
comment on column merlin.source_activity.parameters is e''
  'The instance''s parameters as JSON values: lists become arrays, structs objects, durations milliseconds.';
comment on column merlin.source_activity.metadata is e''
  'Provenance the product records about the instance (for a TOL: Parent, Visibility, and the ACT_END time).';

create table merlin.source_activity_type (
  revision_id integer not null,
  type text not null,
  count integer not null,
  category text,
  first_start timestamptz,
  last_end timestamptz,
  parameters jsonb not null default '{}'::jsonb,

  constraint source_activity_type_natural_key
    primary key (revision_id, type),
  constraint source_activity_type_revision_exists
    foreign key (revision_id)
    references merlin.source_revision
    on update cascade
    on delete cascade
);

comment on table merlin.source_activity_type is e''
  'The activity types present in a published revision, with how many instances each has and their most '
  'common category, so a source can be browsed without reading its activities.';
comment on column merlin.source_activity_type.parameters is e''
  'Each parameter name seen on the type''s activities, with the JSON type of its values (the most common one '
  'when they differ): number, string, boolean, array or object. Imported types declare no parameters of their '
  'own, so this is what filters offer for them.';

