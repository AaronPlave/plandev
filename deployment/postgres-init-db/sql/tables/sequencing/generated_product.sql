create table sequencing.generated_product (
  id integer generated always as identity,
  generation_id integer not null,

  product_key text not null default 'default',
  seq_id text not null,
  metadata jsonb not null default '{}'::jsonb,

  language text not null,
  rendered_output text not null,
  output_hash text not null,
  source_blocks jsonb not null default '[]'::jsonb,

  created_at timestamptz not null default now(),

  constraint generated_product_synthetic_key
    primary key (id),
  constraint generated_product_generation_exists
    foreign key (generation_id)
    references sequencing.generation
    on update cascade
    on delete cascade,
  constraint generated_product_unique_key_per_generation
    unique (generation_id, product_key)
);

comment on table sequencing.generated_product is e''
  'A sequence product produced by a generation. A generation may produce one or more products.\n'
  'Identity is the product id, never the seq_id.';
comment on column sequencing.generated_product.id is e''
  'The unique identifier of this generated product.';
comment on column sequencing.generated_product.generation_id is e''
  'The generation that produced this product.';
comment on column sequencing.generated_product.product_key is e''
  'Distinguishes the products of a single generation. A single-product generation uses ''default''.';
comment on column sequencing.generated_product.seq_id is e''
  'The sequence id (mission/export identifier) of this product.';
comment on column sequencing.generated_product.metadata is e''
  'The sequence metadata used when building this product.';
comment on column sequencing.generated_product.language is e''
  'The sequencing language of the rendered output (STOL, SeqN, Text).';
comment on column sequencing.generated_product.rendered_output is e''
  'The rendered sequence, as built by the language''s sequence builder.';
comment on column sequencing.generated_product.output_hash is e''
  'The SHA-256 hash of rendered_output.';
comment on column sequencing.generated_product.source_blocks is e''
  'The expansion provenance of this product: one entry per source activity, in output order, recording\n'
  'the source activity, the template (by id and content hash) that expanded it, and the expanded block.';
comment on column sequencing.generated_product.created_at is e''
  'When this product was created.';

create function sequencing.generated_product_immutable()
  returns trigger
  language plpgsql as $$
begin
  raise exception 'Generated product % cannot be modified. Create a new generation instead.', old.id;
end
$$;

comment on function sequencing.generated_product_immutable() is e''
  'Prevents generated products from being modified.';

create trigger generated_product_immutable_trigger
  before update on sequencing.generated_product
  for each row
  execute function sequencing.generated_product_immutable();
