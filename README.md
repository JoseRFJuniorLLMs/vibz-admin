# vibz-admin

Sistema privado do VIBZ Tourist Pass, implementado em Python. Emite cartões com número sequencial e QR único, identifica a origem na leitura e registra uma única entrada vinculada à pulseira.

O backend usa FastAPI e SQLite, com login local por senha. Não depende de Firebase. A câmera e a impressão funcionam no navegador.

Consulte [instalação, operação e API](backend/README.md).

## Testes

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
.venv/bin/python -m unittest discover -s backend/tests -v
node --check backend/frontend/admin.js
```

O serviço de produção foi preparado para `https://35.247.217.66.nip.io/vibz/`. O acesso HTTPS pelo IP puro tem certificado incompatível.
