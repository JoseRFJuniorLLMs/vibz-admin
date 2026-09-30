# vibz-admin

Sistema privado do VIBZ Tourist Pass. O backend é Python/FastAPI com SQLite; não depende de Firebase. A câmera e a impressão usam JavaScript no navegador.

## O que faz

- Login local com senha Argon2id, sessão HttpOnly/Secure e proteção CSRF.
- Administradores cadastram origens e emitem lotes de até 100 cartões por vez.
- O número visível é sequencial (`VIBZ-000001` etc.). Cada QR contém somente uma URL com token aleatório de 192 bits, sem nome, CPF ou origem.
- Operadores e administradores consultam a origem ao ler o QR e vinculam a pulseira ao liberar a entrada.
- O resgate é uma transação SQLite: o segundo uso recebe HTTP 409 e não libera outra entrada.
- O link público do cartão não revela origem, status ou número.
- Cartões, origens e estabelecimentos têm listas paginadas. A lista comercial inicial de 130 estabelecimentos de Búzios é uma base de prospecção fornecida pelo proprietário, não um cadastro de parcerias confirmadas.

## Executar localmente

Use Python 3.12+:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r backend/requirements-dev.txt
VIBZ_DB_PATH=./data/vibz.sqlite3 VIBZ_PUBLIC_BASE_URL=https://35.247.217.66.nip.io/vibz-admin/p .venv/bin/python -m backend.manage create-admin vibz-admin
VIBZ_DB_PATH=./data/vibz.sqlite3 .venv/bin/python -m uvicorn backend.app:app --host 127.0.0.1 --port 8792
.venv/bin/python -m unittest discover -s backend/tests -v
```

A criação da conta pede a senha no terminal, sem registrá-la no comando. Para operadores, use `create-operator NOME`; para trocar senha, `reset-password NOME` (revoga as sessões existentes). Não há cadastro público.

Na implantação automatizada, `python -m backend.manage create-admin vibz-admin --generate` grava a credencial inicial em `initial-password.txt` ao lado do banco, com permissão `0600`. O comando não imprime a senha. Recupere-a por SSH, troque a senha com `reset-password` e apague esse arquivo.

## Dados e operação

No servidor, use `VIBZ_DB_PATH=/var/lib/vibz-admin/cards.sqlite3`. Preserve também os arquivos SQLite `-wal` e `-shm` durante backups; para backup consistente com o serviço ativo, use a API de backup do SQLite (`sqlite3.Connection.backup`) ou pare o serviço antes de copiar. O processo deve ter escrita só em `/var/lib/vibz-admin`. A aplicação HTTP deve escutar apenas em `127.0.0.1`, atrás do Nginx HTTPS.

O QR físico aponta para `VIBZ_PUBLIC_BASE_URL/<token>`; mantenha esse endereço estável depois de imprimir cartões. A URL de QR atual usa `35.247.217.66.nip.io/vibz-admin/p`. O painel também atende `https://35.247.217.66/vibz-admin/` com certificado de IP separado. Esse certificado tem validade curta e é renovado por `vibz-ip-cert-renew.timer` duas vezes ao dia; acompanhe o timer e a expiração.

Para incluir a base inicial de prospecção, execute `VIBZ_DB_PATH=/var/lib/vibz-admin/cards.sqlite3 .venv/bin/python -m backend.seed_partners` no diretório da aplicação. O comando é idempotente e não substitui contatos ou status editados. Os nomes entram como `não contatado`; endereço, telefone e demais contatos ficam vazios até confirmação. Um prospecto só se torna `parceiro` após atualização explícita por administrador. Os locais comerciais aparecem no seletor de emissão com seu status. A origem de cartão é cadastrada automaticamente na primeira emissão para aquele local; a interface pede confirmação de distribuição quando a parceria ainda não estiver marcada como confirmada.

O login limita tentativas por IP durante dez minutos. Sessões duram oito horas. Roles: `admin` emite cartões e cria origens; `operator` consulta e resgata. A equipe deve guardar as credenciais individualmente, sair ao encerrar o turno e fazer backup periódico do banco.

## API

| Rota | Acesso | Uso |
| --- | --- | --- |
| `POST /api/login` | público | cria sessão por usuário e senha |
| `GET /api/session` | equipe | restaura sessão e token CSRF |
| `POST /api/logout` | equipe | revoga sessão |
| `GET/POST /api/origins` | equipe/admin | lista paginada/cadastra origens |
| `GET /api/origins/options` | equipe | origens ativas e locais comerciais para seleção de emissão |
| `GET/POST /api/cards` | equipe/admin | lista paginada/emite cartões |
| `GET /api/partners` | equipe | busca e filtra base comercial paginada |
| `PATCH /api/partners/{id}` | admin | atualiza contatos, prioridade e status |
| `POST /api/lookup` | equipe | identifica QR e origem |
| `POST /api/cards/{token}/redeem` | equipe | registra entrada e pulseira uma vez |
| `GET /p/{token}` | público | página genérica sem dados do cartão |

O Nginx remove o prefixo `/vibz-admin/` ao enviar ao FastAPI. Todas as mutações autenticadas exigem `X-CSRF-Token` devolvido no login/sessão. Não exponha a porta 8792 publicamente.
