"""Test-only external model HTTP fixture; never packaged into the application."""
import argparse
import json
import os
import re
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import uvicorn

from backend.app import create_app
from backend.modules.analysis import SIGNATURE, signature
from backend.providers import Providers
from backend.schemas import dump, uid
from backend.tests.test_workflow import MemorySecrets


def model_result(task):
    purpose = task['purpose']
    if purpose == 'connection_test':
        return {'ok': True}
    if purpose == 'draft':
        return {'subject': 'Clarification on your quote — ' + task['project_name'], 'body': 'Hi,\n\nThank you for your quote. Please clarify:\n' + '\n'.join(f'{index}. {question}' for index, question in enumerate(task['questions'], 1)) + '\n\nMany thanks.'}
    if purpose == 'alignment':
        groups = {}
        for quote in task['quotes']:
            for fact in quote['facts']:
                key = signature(fact)
                if key not in groups:
                    groups[key] = {'id': uid(), 'label': fact['raw_label'], 'signature': {field: fact[field] for field in SIGNATURE}, 'members': [], 'status': 'suggested', 'reason': '同义且口径一致；请用户核对', 'display_order': len(groups)}
                groups[key]['members'].append({'quote_id': quote['quote_id'], 'fact_id': fact['id']})
        return {'groups': list(groups.values())}
    facts = []
    for block in task['source_blocks']:
        for line in block['text'].splitlines():
            match = re.search(r'(Total|Amount|Kitchen cabinets|Worktop|Waste removal|Payment terms|Duration|Materials)\s*:?\s*(.*)', line, re.I)
            if not match:
                continue
            label, raw = match.groups()
            number = re.search(r'\d+(?:\.\d+)?', raw)
            total = label.lower() in ('total', 'amount')
            monetary = total or label.lower() in ('kitchen cabinets', 'worktop')
            facts.append({'id': uid(), 'raw_label': '总价' if total else label, 'raw_value': raw,
                'normalized_value': number.group() if monetary and number else raw, 'value_type': 'decimal' if monetary else 'text',
                'semantic_kind': 'project_total' if total else 'line_total' if monetary else 'material' if label == 'Materials' else 'term',
                'entity_key': None if total else label.lower().replace(' ', '_'), 'unit': None, 'currency': 'GBP' if monetary else None,
                'tax_basis': 'included' if monetary and 'VAT included' in '\n'.join(value['text'] for value in task['source_blocks']) else 'unknown' if monetary else 'not_applicable',
                'coverage': 'separate' if monetary else 'not_applicable', 'source_refs': [{'quote_id': task['quote_id'], 'block_id': block['id']}],
                'origin': 'extracted', 'review_status': 'unreviewed'})
    return {'contractor_name': 'Test Contractor', 'facts': facts, 'warnings': []}


class ModelHandler(BaseHTTPRequestHandler):
    def log_message(self, *arguments):
        pass

    def do_GET(self):
        self.respond({'balance_infos': [{'currency': 'CNY', 'total_balance': '38.40', 'granted_balance': '0', 'topped_up_balance': '38.40'}]})

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        content = data.get('input') or data['messages'][-1]['content']
        task = json.loads(content)['task']
        result = dump(model_result(task))
        if self.path.endswith('/responses'):
            response = {'output': [{'content': [{'type': 'output_text', 'text': result}]}], 'usage': {'input_tokens': 1000, 'output_tokens': 250, 'input_tokens_details': {'cached_tokens': 100}}}
        elif self.path.endswith('/messages'):
            response = {'content': [{'type': 'text', 'text': result}], 'usage': {'input_tokens': 900, 'output_tokens': 250, 'cache_read_input_tokens': 100}}
        else:
            response = {'choices': [{'message': {'content': result}}], 'usage': {'prompt_tokens': 1000, 'completion_tokens': 250, 'prompt_cache_hit_tokens': 100}}
        self.respond(response)

    def respond(self, data):
        contents = dump(data).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(contents)))
        self.end_headers()
        self.wfile.write(contents)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    arguments = parser.parse_args()
    vendor = ThreadingHTTPServer(('127.0.0.1', 0), ModelHandler)
    threading.Thread(target=vendor.serve_forever, daemon=True).start()
    urls = {provider: 'http://127.0.0.1:' + str(vendor.server_port) for provider in ('openai', 'claude', 'deepseek')}
    app = create_app(arguments.data_dir, token=os.environ['QUOTECOMPARE_SESSION_TOKEN'], secrets=MemorySecrets(), providers=Providers(urls=urls))
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    print('QUOTECOMPARE_PORT=' + str(listener.getsockname()[1]), flush=True)
    try:
        uvicorn.Server(uvicorn.Config(app, log_level='warning', access_log=False)).run(sockets=[listener])
    finally:
        vendor.shutdown()


if __name__ == '__main__':
    main()
