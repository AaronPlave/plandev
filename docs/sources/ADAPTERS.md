# Source adapters

An adapter reads one file format into the canonical resource and activity stream. It only parses:
`SourceImporter` validates, chunks, summarizes, stores and publishes, and the worker owns the revision row.
**An adapter never creates or changes `merlin.source` or `merlin.source_revision` rows.**

## The interface

`gov.nasa.ammos.plandev.sources.SourceAdapter`:

- `descriptor()` returns a `Descriptor`:
  - `id`: stable, what `source_revision.adapter` stores. Never change it once revisions use it (TOL is `xml_tol`).
  - `displayName`, `version` (recorded on each revision as `adapter_version`).
  - `extensions` (e.g. `.tol`, `.tol.gz`, `.tar.gz`) and `mimeTypes` (may be empty): hints for file pickers, not
    used for selection.
  - `capabilities`: any of `resources`, `activities`.
  - `configSchema`: a JSON Schema for the adapter's config, or null when it takes none.
- `probe(byte[] head)`: whether the adapter understands a file, from its first 4 KiB (after decompression).
- `read(InputStream, Sink, String config)`: streams the file into the sink. `config` is the revision's
  `adapter_config` JSON text, or null.

Besides `declare` / `manifestComplete` / `sample` / `activity`, the `Sink` has an optional
`productMetadata(ProductMetadata)`, described below.

## Discovery and deployment

Adapters are trusted, in-process Java code, found with `java.util.ServiceLoader`. An adapter JAR lists its
classes in `META-INF/services/gov.nasa.ammos.plandev.sources.SourceAdapter`, one per line, as this module does
for `TolAdapter`. The worker loads every adapter on its classpath once, at startup. Two adapters with the same
id are a startup error.

A mission adds a format by putting its adapter JAR on the worker's classpath, for example a plugin directory
next to the module's own libraries:

```sh
./gradlew :source-ingest:installDist
java -cp 'source-ingest/build/install/source-ingest/lib/*:/opt/plandev/source-adapters/*' \
  gov.nasa.ammos.plandev.sources.SourceIngestCli work
```

The adapter compiles against `source-ingest` (compile-only). There is no hot reload and no JAR upload
through the UI: adding or upgrading an adapter is a deployment, followed by a worker restart.

## Selecting an adapter

`source_revision.adapter` is either an installed adapter's id or `auto` (the column default).

- **Explicit id**: the worker uses that adapter. An id that is not installed, or an adapter whose `probe`
  rejects the file, fails the revision.
- **`auto`**: the worker probes every installed adapter on the file's head. Exactly one match is used. No
  match, or several, fails the revision with an error naming the installed adapters or the candidates; the
  user then picks one explicitly.

Once resolved, the worker writes the actual id and version to `adapter` and `adapter_version`, so a
revision always records what read it.

```sh
# register [--adapter=<id>] <name> <path> [planId] [user]     (default: auto)
source-ingest register --adapter=xml_tol "mission tour TOL" /data/tour.tol.gz
```

## Adapter config

`source_revision.adapter_config` (jsonb, null when none) is passed to `read` as-is. It is stored on the
revision so that an import is reproducible: the same file, adapter id, adapter version and config give the
same revision. The adapter's `configSchema` describes it; the UI may use the schema to build a form (no such
UI exists yet). Validating the config is the adapter's job.

## Product metadata

An adapter may call `sink.productMetadata(new ProductMetadata(generatedAt, productVersion, suggestedName, mission))`
with what the file says about the upstream product (every field optional):

- `generatedAt`: when the upstream product was generated (an `Instant`), not when it was imported.
- `productVersion`, `suggestedName`: as the product states them.
- `mission`: a free JSON object of mission-specific facts.

The importer, never the adapter, writes it on publish as
`source_revision.metadata.product = {generatedAt?, productVersion?, suggestedName?, mission?}` (absent fields
omitted, `generatedAt` as ISO-8601). The UI labels a revision with `metadata.product.generatedAt` when present,
else its import time. Adapters report only what the file states: the TOL header carries no generation time,
version or name, so `xml_tol` reports none.

## The `source_adapter` catalog

On startup each worker upserts its adapters' descriptors into `merlin.source_adapter`:

| column | type |
| --- | --- |
| `id` | text, primary key |
| `display_name` | text |
| `version` | text |
| `extensions`, `mime_types`, `capabilities` | text[] |
| `config_schema` | jsonb, null when none |
| `updated_at` | timestamptz |

Hasura exposes it read-only to every role, so the UI can list importable formats:

```graphql
source_adapter { id display_name version extensions capabilities config_schema }
```

Rows of adapters that are no longer installed are not removed.

## Future: non-Java adapters

The likely escape hatch for formats that are easier to read outside the JVM: `source-ingest` launches a
trusted, installed executable per ingest and reads from its stdout a versioned, batched canonical stream of
resource declarations, samples and activities, which it feeds into `SourceImporter` like any adapter. There is
no always-on service, and the executable still never touches source or revision rows. The stream must be
batched and binary-friendly: do not use line-by-line JSON for massive profile products without benchmarking
it against the in-process path first.
