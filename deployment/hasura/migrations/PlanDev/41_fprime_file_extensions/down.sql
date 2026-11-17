delete from ui.file_extension_content_type
where file_extension in ('.rs', '.toml', '.lock', '.wasm');

call migrations.mark_migration_rolled_back(41);
