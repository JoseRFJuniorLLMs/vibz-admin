"""Create and maintain staff accounts from a trusted shell on the server."""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
from pathlib import Path

from .app import Settings
from .auth import hash_password
from .store import Store, StoreError


def main() -> None:
    parser = argparse.ArgumentParser(description="Gerenciar contas locais do vibz-admin")
    parser.add_argument("action", choices=("create-admin", "create-operator", "reset-password"))
    parser.add_argument("username")
    parser.add_argument("--generate", action="store_true", help="gera senha inicial em arquivo local privado")
    args = parser.parse_args()

    if args.generate:
        if args.action != "create-admin":
            parser.error("--generate vale somente para create-admin")
        password = secrets.token_urlsafe(24)
    else:
        password = getpass.getpass("Nova senha (mínimo 12 caracteres): ")
        confirmation = getpass.getpass("Confirme a senha: ")
        if password != confirmation:
            parser.error("As senhas não coincidem")
    try:
        hashed = hash_password(password)
        settings = Settings.from_env()
        store = Store(settings.db_path)
        if args.action == "reset-password":
            if not store.set_password(args.username, hashed):
                parser.error("Usuário não encontrado")
            print("Senha alterada e sessões anteriores revogadas")
        else:
            role = "admin" if args.action == "create-admin" else "operator"
            secret_file = Path(os.getenv("VIBZ_BOOTSTRAP_SECRET_FILE", str(settings.db_path.parent / "initial-password.txt")))
            if args.generate:
                descriptor = os.open(secret_file, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                try:
                    with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                        stream.write(f"{args.username}\n{password}\n")
                except Exception:
                    secret_file.unlink(missing_ok=True)
                    raise
            try:
                user = store.create_user(args.username, hashed, role)
            except Exception:
                if args.generate:
                    secret_file.unlink(missing_ok=True)
                raise
            print(f"Conta {user['username']} criada com papel {role}")
            if args.generate:
                print(f"Senha inicial guardada em {secret_file}; apague o arquivo após recuperá-la")
    except (ValueError, StoreError) as exc:
        parser.error(str(exc))


if __name__ == "__main__":
    main()
