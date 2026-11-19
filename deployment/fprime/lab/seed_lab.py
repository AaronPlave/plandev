#!/usr/bin/env python3
"""
Seed the "F Prime Sequencing Lab" workspace: two Cargo projects scaffolded by the toolchain, the lab's
sequences and tests, a plan-generated Rust sequence, and real builds through the F Prime Actions.

Run setup.py with --name "F Prime Sequencing Lab" first (adaptation, parcel, workspace, Actions). Safe to
rerun: files are written only when they differ, and an Action runs only when its result is missing
(no artifact, an artifact built from different source text, or no earlier run for a failure example).
Standard library only.

  python3 deployment/fprime/lab/seed_lab.py --gateway http://localhost:31121 --hasura http://localhost:31120 \\
      --workspace http://localhost:31123 --action http://localhost:31122
"""
import argparse
import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
FILES = os.path.join(HERE, 'files')
NAME = 'F Prime Sequencing Lab'
# Built and verified; the first of each project is the one its scaffold creates.
RUST_BUILDS = ['restricted_checkout', 'recommended_math', 'unrestricted_sweep', 'factor_campaign', 'bake_bread_from_plan']
HELPERS_MOD = '\n/// Steps shared by this project\'s sequences (src/helpers.rs).\npub mod helpers;\n'
PLAN_SEQ = ('bake_bread', 1)  # (seq_id, simulation dataset) of the plan expansion to write into rust/


def sha(data):
    return hashlib.sha256(data if isinstance(data, bytes) else data.encode()).hexdigest()


class Lab:
    def __init__(self, args):
        self.a = args
        self.token = self.json('POST', f'{args.gateway}/auth/login', {'username': args.username, 'password': args.password})['token']
        rows = self.gql('query($n:String!){ workspace(where:{name:{_eq:$n}}){ id } }', {'n': NAME})['workspace']
        if not rows:
            sys.exit(f'No workspace "{NAME}": run setup.py --name "{NAME}" first.')
        self.ws = rows[0]['id']
        defs = self.gql('query($w:Int!){ action_definition(where:{workspace_id:{_eq:$w}}){ id name settings } }', {'w': self.ws})
        self.actions = {d['name']: d for d in defs['action_definition']}

    # --- HTTP ---------------------------------------------------------------------------------------
    def request(self, method, url, body=None, headers=None):
        h = {'Authorization': f'Bearer {getattr(self, "token", "")}', 'x-hasura-role': self.a.role, **(headers or {})}
        try:
            with urllib.request.urlopen(urllib.request.Request(url, body, h, method=method)) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            raise SystemExit(f'{method} {url}: HTTP {e.code} {e.read().decode()[:500]}')

    def json(self, method, url, payload):
        return json.loads(self.request(method, url, json.dumps(payload).encode(), {'Content-Type': 'application/json'}))

    def gql(self, query, variables=None):
        result = self.json('POST', f'{self.a.hasura}/v1/graphql', {'query': query, 'variables': variables or {}})
        if 'errors' in result:
            raise SystemExit(json.dumps(result['errors'])[:2000])
        return result['data']

    def url(self, path, kind='ws'):
        return f'{self.a.workspace}/{kind}/{self.ws}/' + '/'.join(urllib.parse.quote(p) for p in path.split('/'))

    def read(self, path):
        return self.request('GET', self.url(path))

    def metadata(self, path):
        data = self.request('GET', self.url(path, 'metadata'))
        return json.loads(data) if data else None

    def write(self, path, data):
        """Writes only when the content differs. Returns whether it wrote."""
        data = data if isinstance(data, bytes) else data.encode()
        if self.read(path) == data:
            return False
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{os.path.basename(path)}"\r\n'
                f'Content-Type: application/octet-stream\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
        self.request('PUT', self.url(path) + '?type=file&overwrite=true', body,
                     {'Content-Type': f'multipart/form-data; boundary={boundary}'})
        print(f'  wrote {path}')
        return True

    # --- Actions ------------------------------------------------------------------------------------
    def run(self, action, parameters):
        """Runs an Action as the UI does (insert the run, then send the user's token) and waits for it."""
        definition = self.actions[action]
        run_id = self.gql('mutation($r:action_run_insert_input!){ insert_action_run_one(object:$r){ id } }', {'r': {
            'action_definition_id': definition['id'], 'has_secrets': True,
            'parameters': parameters, 'settings': definition['settings']}})['insert_action_run_one']['id']
        self.json('POST', f'{self.a.action}/secrets', {'action_run_id': run_id, 'secrets': {}})
        for _ in range(600):
            run = self.gql('query($id:Int!){ action_run_by_pk(id:$id){ status } }', {'id': run_id})['action_run_by_pk']
            if run['status'] in ('success', 'failed', 'cancelled'):
                print(f'  {action} {json.dumps(parameters)} -> run {run_id}: {run["status"]}')
                return run['status']
            time.sleep(1)
        raise SystemExit(f'run {run_id} did not finish')

    def ran_before(self, action, source):
        runs = self.gql('query($id:Int!){ action_run(where:{action_definition_id:{_eq:$id}}){ parameters } }',
                        {'id': self.actions[action]['id']})['action_run']
        return any(json.dumps(r['parameters']).find(f'"{source}"') >= 0 for r in runs)

    def build(self, source, artifact):
        """Compiles unless the artifact exists and was built from the source text as saved now."""
        built = ((self.metadata(artifact) or {}).get('user') or {})
        recorded = (built.get('build') or built.get('fprimeBuild') or {}).get('sourceSha256')
        current = self.read(source)
        if recorded and current is not None and recorded == sha(current):
            return
        self.run('F Prime compile', {'source': {'path': source}})

    # --- Seeding ------------------------------------------------------------------------------------
    def scaffold(self, project, sequence, profile):
        if self.read(f'{project}/Cargo.toml') is None:
            print(f'scaffolding {project}/ ({sequence}, {profile})')
            self.run('F Prime new sequence', {'profile': profile, 'project': project, 'sequence': sequence, 'test': False})

    def plan_generated(self, path):
        """The latest expansion of PLAN_SEQ, written with the provenance Send to workspace records."""
        if self.read(path) is not None:
            return
        seq_id, dataset = PLAN_SEQ
        data = self.gql('''query($s:String!,$d:Int!){
            expanded_templates(where:{seq_id:{_eq:$s}, simulation_dataset_id:{_eq:$d}}, order_by:{id:desc}, limit:1){ id created_at expanded_template }
            sequence_to_simulated_activity(where:{seq_id:{_eq:$s}, simulation_dataset_id:{_eq:$d}}, order_by:{simulated_activity_id:asc}){ simulated_activity_id }
            simulation_dataset_by_pk(id:$d){ simulation { plan { id name start_time duration model_id } } } }''',
                        {'s': seq_id, 'd': dataset})
        if not data['expanded_templates'] or not data['simulation_dataset_by_pk']:
            print(f'  skipped {path}: no expansion of {seq_id} for simulation dataset {dataset}')
            return
        expansion, plan = data['expanded_templates'][0], data['simulation_dataset_by_pk']['simulation']['plan']
        self.write(path, expansion['expanded_template'])
        user = {
            'generatedFrom': {
                'expandedAt': expansion['created_at'], 'expandedTemplateId': expansion['id'],
                'kind': 'sequence-template-expansion', 'planId': plan['id'], 'planName': plan['name'], 'seqId': seq_id,
                'simulationDatasetId': dataset,
                'spanIds': [r['simulated_activity_id'] for r in data['sequence_to_simulated_activity']],
                'writtenAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
            },
            'model': {'id': plan['model_id']},
            'plan': {'derivationGroups': [], 'duration': plan['duration'], 'name': plan['name'], 'start': plan['start_time']},
            'sequence_metadata': {}, 'simulation_dataset_id': dataset,
        }
        self.request('POST', self.url(path, 'metadata'), json.dumps({'user': user}).encode(), {'Content-Type': 'application/json'})

    def seed(self):
        print(f'workspace {self.ws}: {NAME}')
        self.scaffold('rust', 'restricted_checkout', 'restrict')
        self.scaffold('failing', 'profile_violation', 'recommended')

        lib = self.read('rust/src/lib.rs').decode()
        if 'pub mod helpers;' not in lib:
            self.write('rust/src/lib.rs', lib.rstrip('\n') + '\n' + HELPERS_MOD)
        for root, _, names in os.walk(FILES):
            for name in names:
                rel = os.path.relpath(os.path.join(root, name), FILES)
                if rel == 'rust/src/bin/recommended_math.rs' or name.endswith('.built.rs'):
                    continue  # written around its build, below
                self.write(rel, open(os.path.join(root, name), 'rb').read())
        self.plan_generated('rust/src/bin/bake_bread_from_plan.rs')

        # The stale-build example: build the original, then save the edit (once).
        stale = 'rust/src/bin/recommended_math.rs'
        if self.read('rust/out/recommended_math.wasm') is None:
            self.write(stale, open(os.path.join(FILES, 'rust/src/bin/recommended_math.built.rs'), 'rb').read())
            self.build(stale, 'rust/out/recommended_math.wasm')
            self.write(stale, open(os.path.join(FILES, stale), 'rb').read())
        for name in RUST_BUILDS:
            if name != 'recommended_math':
                self.build(f'rust/src/bin/{name}.rs', f'rust/out/{name}.wasm')
        self.build('sequences/startup.seq', 'sequences/startup.bin')

        # Expected failures and the tests: once each (their history is in the Actions panel).
        for source in ('failing/src/bin/profile_violation.rs', 'sequences/invalid.seq'):
            if not self.ran_before('F Prime compile', source):
                self.run('F Prime compile', {'source': {'path': source}})
        if not self.ran_before('F Prime test', 'rust/tests/behavior.rs'):
            self.run('F Prime test', {'source': 'rust/tests/behavior.rs'})
        print('done')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--gateway', default='http://localhost:9000')
    p.add_argument('--hasura', default='http://localhost:8080')
    p.add_argument('--workspace', default='http://localhost:28000')
    p.add_argument('--action', default='http://localhost:27186', help='action server URL')
    p.add_argument('--username', default=os.environ.get('PLANDEV_USERNAME', 'test'))
    p.add_argument('--password', default=os.environ.get('PLANDEV_PASSWORD', 'test'))
    p.add_argument('--role', default='aerie_admin')
    Lab(p.parse_args()).seed()


if __name__ == '__main__':
    main()
