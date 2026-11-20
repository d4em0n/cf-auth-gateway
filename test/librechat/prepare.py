"""Create fresh QA state; read only the model provider key from the trusted live deployment."""
import json
import os
import secrets
import sys
from pathlib import Path

os.umask(0o077)
directory = Path(sys.argv[1]).resolve()
if directory.exists():
    raise SystemExit('Use a fresh QA directory')
directory.mkdir(parents=True)
for name in ['data', 'uploads', 'images', 'logs', 'skill', 'mongo-data', 'mongo-config']:
    (directory / name).mkdir()
source = dict(line.split('=', 1) for line in Path('/mnt/data/librechat/.env').read_text().splitlines()
              if '=' in line and not line.startswith('#'))
values = {
    'HOST': '0.0.0.0', 'PORT': '3080', 'NODE_ENV': 'production',
    'DOMAIN_CLIENT': 'https://chat.example.com', 'DOMAIN_SERVER': 'https://chat.example.com',
    'MONGO_URI': 'mongodb://mongo:27017/gateway_qa', 'SEARCH': 'false', 'NO_INDEX': 'true',
    'ALLOW_EMAIL_LOGIN': 'true', 'ALLOW_REGISTRATION': 'false',
    'ALLOW_SOCIAL_LOGIN': 'false', 'ALLOW_SOCIAL_REGISTRATION': 'false',
    'ALLOW_PASSWORD_RESET': 'false', 'ALLOW_UNVERIFIED_EMAIL_LOGIN': 'false',
    'SESSION_COOKIE_SECURE': 'true', 'SESSION_EXPIRY': '60000', 'TRUST_PROXY': '1',
    'ENDPOINTS': 'custom,agents', 'SCHEDULES_SINGLE_PROCESS': 'true',
    'DEBUG_LOGGING': 'false', 'DEBUG_CONSOLE': 'false', 'LOGIN_MAX': '100',
    'CLIPROXY_API_KEY': source['CLIPROXY_API_KEY'],
}
for name, size in [('CREDS_KEY', 32), ('CREDS_IV', 16), ('JWT_SECRET', 32), ('JWT_REFRESH_SECRET', 32)]:
    values[name] = secrets.token_hex(size)
(directory / 'librechat.env').write_text(''.join(f'{key}={value}\n' for key, value in values.items()))
(directory / 'librechat.yaml').write_text('''version: 1.3.19
cache: true
endpoints:
  custom:
    - name: QA Gateway
      apiKey: ${CLIPROXY_API_KEY}
      baseURL: http://cliproxyapi:8317/v1
      models:
        default: [gpt-6.1-sol]
        fetch: false
      titleConvo: false
''')
(directory / 'account.json').write_text(json.dumps({
    'email': 'gateway-qa@example.test', 'name': 'Gateway QA', 'username': 'gateway-qa',
    'password': secrets.token_urlsafe(24),
}))
print('Created disposable QA configuration')
