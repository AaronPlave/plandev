update permissions.user_role_permission
set action_permissions = action_permissions - 'generate_sequence';

drop type permissions.action_permission_key;

create type permissions.action_permission_key
  as enum (
    'assign_activities_by_filter',
    'check_constraints',
    'create_expansion_rule',
    'create_expansion_set',
    'expand_all_activities',
    'expand_all_templates',
    'insert_ext_dataset',
    'resource_samples',
    'schedule',
    'sequence_seq_json_bulk',
    'simulate'
  );

drop trigger generated_product_immutable_trigger on sequencing.generated_product;
drop function sequencing.generated_product_immutable();
drop table sequencing.generated_product;

drop trigger generation_immutable_trigger on sequencing.generation;
drop function sequencing.generation_immutable();
drop table sequencing.generation;

call migrations.mark_migration_rolled_back('38');
