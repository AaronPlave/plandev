#!/usr/bin/env python3
"""
Install F Prime sequencing into a running PlanDev: dictionary, SeqDev adaptation, the
"F Prime compile" and "F Prime new sequence" Actions, a parcel and a workspace with examples.
Idempotent: re-running updates the adaptation and adds new Action versions. Standard library only.

  python3 deployment/fprime/setup.py \\
      --gateway http://localhost:9000 --hasura http://localhost:8080 --workspace http://localhost:28000 \\
      --dictionary sequencing-server/plugins/fprime-dictionary-parser/test/dictionary/MathDeploymentTopologyDictionary.json

Build the bundles first (cd deployment/fprime/seqdev && npm ci && npm run build). See README.md.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ACTIONS = {
    'F Prime compile': ('fprime-compile.js', '.seq → .bin (fprime-seqgen), .rs → .wasm (fprime-wasm build + verify)'),
    'F Prime new sequence': ('fprime-new-sequence.js', 'New Rust/WASM sequence (and Cargo project) from fprime-wasm scaffolding'),
    'F Prime test': ('fprime-test.js', 'Run a Rust/WASM sequence\'s behaviour tests (fprime-wasm test)'),
}


class Client:
    def __init__(self, args):
        self.args = args
        self.token = self.post_json(f'{args.gateway}/auth/login',
                                    {'username': args.username, 'password': args.password})['token']

    def request(self, url, body=None, headers=None, method=None):
        headers = {'Authorization': f'Bearer {getattr(self, "token", "")}', 'x-hasura-role': self.args.role, **(headers or {})}
        try:
            return urllib.request.urlopen(urllib.request.Request(url, body, headers, method=method)).read()
        except urllib.error.HTTPError as e:
            raise SystemExit(f'{method or ("POST" if body else "GET")} {url}: HTTP {e.code} {e.read().decode()[:500]}')

    def post_json(self, url, payload):
        return json.loads(self.request(url, json.dumps(payload).encode(), {'Content-Type': 'application/json'}))

    def gql(self, query, variables=None):
        result = self.post_json(f'{self.args.hasura}/v1/graphql', {'query': query, 'variables': variables or {}})
        if 'errors' in result:
            raise SystemExit(json.dumps(result['errors'])[:2000])
        return result['data']

    def upload(self, url, name, data, method='POST'):
        boundary = uuid.uuid4().hex
        body = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{name}"\r\n'
                f'Content-Type: application/octet-stream\r\n\r\n').encode() + data + f'\r\n--{boundary}--\r\n'.encode()
        return self.request(url, body, {'Content-Type': f'multipart/form-data; boundary={boundary}'}, method)


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('--gateway', default='http://localhost:9000')
    p.add_argument('--hasura', default='http://localhost:8080')
    p.add_argument('--workspace', default='http://localhost:28000', help='workspace service URL')
    p.add_argument('--username', default=os.environ.get('PLANDEV_USERNAME', 'test'))
    p.add_argument('--password', default=os.environ.get('PLANDEV_PASSWORD', 'test'))
    p.add_argument('--role', default='aerie_admin')
    p.add_argument('--dictionary', required=True, help='F Prime JSON dictionary (e.g. <deployment>TopologyDictionary.json)')
    p.add_argument('--name', default='F Prime', help='name of the adaptation, parcel and workspace')
    p.add_argument('--toolchain-url', default='http://fprime_toolchain:9258',
                   help='build endpoint as the action server reaches it')
    args = p.parse_args()
    dist = os.path.join(HERE, 'seqdev', 'dist')
    if not os.path.exists(os.path.join(dist, 'adaptation.js')):
        sys.exit('Build the bundles first: cd deployment/fprime/seqdev && npm ci && npm run build')
    c = Client(args)

    # Dictionary: persisted, so Actions can compile against the exact file the editor parsed.
    dictionary = open(args.dictionary).read()
    metadata = json.loads(dictionary)['metadata']
    # Re-uploading the same mission/version updates it in place (re-parsed by the current parser).
    c.gql('mutation($d:String!){ uploadDictionary(dictionary:$d, persistDictionaryToFilesystem:true){ command } }',
          {'d': dictionary})
    ids = c.gql('''query($m:String!,$v:String!){
        command_dictionary(where:{mission:{_eq:$m},version:{_eq:$v}}){ id }
        channel_dictionary(where:{mission:{_eq:$m},version:{_eq:$v}}){ id }
        parameter_dictionary(where:{mission:{_eq:$m},version:{_eq:$v}}){ id } }''',
                {'m': metadata['deploymentName'], 'v': metadata['projectVersion']})
    command_id = ids['command_dictionary'][0]['id']
    channel_id = (ids['channel_dictionary'] or [{}])[0].get('id')
    parameter_ids = [d['id'] for d in ids['parameter_dictionary']]
    print(f'dictionary: {metadata["deploymentName"]} {metadata["projectVersion"]} (command dictionary {command_id})')

    # Adaptation.
    code = open(os.path.join(dist, 'adaptation.js')).read()
    rows = c.gql('query($n:String!){ sequence_adaptation(where:{name:{_eq:$n}}){ id } }', {'n': args.name})['sequence_adaptation']
    if rows:
        adaptation_id = rows[0]['id']
        c.gql('mutation($id:Int!,$a:String!){ update_sequence_adaptation_by_pk(pk_columns:{id:$id}, _set:{adaptation:$a}){ id } }',
              {'id': adaptation_id, 'a': code})
    else:
        adaptation_id = c.gql('mutation($n:String!,$a:String!){ insert_sequence_adaptation_one(object:{name:$n, adaptation:$a}){ id } }',
                              {'n': args.name, 'a': code})['insert_sequence_adaptation_one']['id']
    print(f'adaptation: {adaptation_id} ({len(code)} bytes)')

    # Parcel.
    rows = c.gql('query($n:String!){ parcel(where:{name:{_eq:$n}}){ id } }', {'n': args.name})['parcel']
    parcel = {'command_dictionary_id': command_id, 'channel_dictionary_id': channel_id, 'sequence_adaptation_id': adaptation_id}
    if rows:
        parcel_id = rows[0]['id']
        c.gql('mutation($id:Int!,$p:parcel_set_input!){ update_parcel_by_pk(pk_columns:{id:$id}, _set:$p){ id } }',
              {'id': parcel_id, 'p': parcel})
        c.gql('mutation($id:Int!){ delete_parcel_to_parameter_dictionary(where:{parcel_id:{_eq:$id}}){ affected_rows } }', {'id': parcel_id})
    else:
        parcel_id = c.gql('mutation($p:parcel_insert_input!){ insert_parcel_one(object:$p){ id } }',
                          {'p': {**parcel, 'name': args.name}})['insert_parcel_one']['id']
    if parameter_ids:
        c.gql('mutation($o:[parcel_to_parameter_dictionary_insert_input!]!){ insert_parcel_to_parameter_dictionary(objects:$o){ affected_rows } }',
              {'o': [{'parcel_id': parcel_id, 'parameter_dictionary_id': i} for i in parameter_ids]})
    print(f'parcel: {parcel_id}')

    # Workspace with the example sequences.
    rows = c.gql('query($n:String!){ workspace(where:{name:{_eq:$n}}){ id } }', {'n': args.name})['workspace']
    if rows:
        workspace_id = rows[0]['id']
    else:
        created = c.post_json(f'{args.workspace}/ws/create',
                              {'parcelId': parcel_id, 'workspaceLocation': args.name.lower().replace(' ', '-'),
                               'workspaceName': args.name})
        workspace_id = created if isinstance(created, int) else created.get('id', created.get('workspaceId'))
    for name in ('startup.seq', 'invalid.seq'):
        c.upload(f'{args.workspace}/ws/{workspace_id}/sequences/{name}?type=file&overwrite=true', name,
                 open(os.path.join(HERE, 'seqdev', 'examples', name), 'rb').read(), 'PUT')
    print(f'workspace: {workspace_id}')

    # Actions, defined in the workspace, configured with the toolchain's build endpoint.
    for name, (bundle, description) in ACTIONS.items():
        file_id = json.loads(c.upload(f'{args.gateway}/file', bundle, open(os.path.join(dist, bundle), 'rb').read()))['id']
        rows = c.gql('query($n:String!,$w:Int!){ action_definition(where:{name:{_eq:$n},workspace_id:{_eq:$w}}){ id } }',
                     {'n': name, 'w': workspace_id})['action_definition']
        if rows:
            action_id = rows[0]['id']
            c.gql('mutation($v:action_definition_version_insert_input!){ insert_action_definition_version_one(object:$v){ revision } }',
                  {'v': {'action_definition_id': action_id, 'action_file_id': file_id}})
        else:
            action_id = c.gql('mutation($a:action_definition_insert_input!){ insert_action_definition_one(object:$a){ id } }',
                              {'a': {'name': name, 'description': description, 'workspace_id': workspace_id,
                                     'versions': {'data': [{'action_file_id': file_id}]}}})['insert_action_definition_one']['id']
        c.gql('mutation($id:Int!,$s:jsonb!){ update_action_definition_by_pk(pk_columns:{id:$id}, _set:{settings:$s}){ id } }',
              {'id': action_id, 's': {'toolchainUrl': args.toolchain_url}})
        print(f'action: {name} ({action_id})')


if __name__ == '__main__':
    main()
