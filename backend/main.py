import argparse
import os
import socket

import uvicorn

from backend.app import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', required=True)
    arguments = parser.parse_args()
    token = os.environ.get('QUOTECOMPARE_SESSION_TOKEN')
    if not token or len(token) < 32:
        raise SystemExit('Missing desktop session token')
    app = create_app(arguments.data_dir, token=token)
    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen(128)
    port = listener.getsockname()[1]
    print('QUOTECOMPARE_PORT=' + str(port), flush=True)
    config = uvicorn.Config(app, log_level='warning', access_log=False)
    uvicorn.Server(config).run(sockets=[listener])


if __name__ == '__main__':
    main()
