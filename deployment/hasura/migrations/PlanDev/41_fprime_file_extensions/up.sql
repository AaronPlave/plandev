-- F Prime sequencing: Rust/WASM sequences and the files of their Cargo projects.
-- (`.seq` is already a Sequence; `.bin` already Binary.)
insert into ui.file_extension_content_type(file_extension, content_type)
values ('.rs', 'Sequence'),
       ('.toml', 'Text'),
       ('.lock', 'Text'),
       ('.wasm', 'Binary')
on conflict (file_extension) do nothing;

call migrations.mark_migration_applied(41);
