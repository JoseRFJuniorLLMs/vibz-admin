"""Add the isolated /vibz proxy to existing Nginx virtual hosts safely."""

from __future__ import annotations

import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path


HERE = Path(__file__).parent
SNIPPETS = Path("/etc/nginx/snippets")
TARGETS = (
    (Path("/etc/nginx/sites-available/memoria"), "nginx-http.conf", "server_name _;"),
    (Path("/etc/nginx/sites-available/memoria-nipio"), "nginx-https.conf", "server_name 35.247.217.66.nip.io;"),
)


def install() -> None:
    changes: list[tuple[Path, Path, Path, str, str]] = []
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    for site, filename, marker in TARGETS:
        original = site.read_text(encoding="utf-8")
        if marker not in original or "location /stf/" not in original:
            raise RuntimeError(f"Virtual host inesperado: {site}")
        include = f"include {SNIPPETS / filename};"
        snippet = SNIPPETS / filename
        intended = (HERE / filename).read_text(encoding="utf-8")
        if snippet.exists() and snippet.read_text(encoding="utf-8") != intended:
            raise RuntimeError(f"Snippet VIBZ existente é diferente: {snippet}")
        if "location /vibz/" in original and include not in original:
            raise RuntimeError(f"Já existe rota /vibz em {site}; revisão manual necessária")
        if include in original:
            continue
        end = original.rfind("\n}")
        if end < 0:
            raise RuntimeError(f"Fecho do virtual host não encontrado: {site}")
        backup = site.with_name(site.name + f".before-vibz-{stamp}")
        updated = original[:end] + f"\n    # vibz-admin\n    {include}\n" + original[end:]
        changes.append((site, backup, snippet, intended, updated))
    if not changes:
        print("Nginx já contém as rotas /vibz/")
        return
    if any(backup.exists() for _, backup, _, _, _ in changes):
        raise RuntimeError("Backup com esse horário já existe; tente novamente após um minuto")
    written: list[tuple[Path, Path, Path, bool]] = []
    try:
        SNIPPETS.mkdir(parents=True, exist_ok=True)
        for site, backup, snippet, intended, updated in changes:
            shutil.copy2(site, backup)
            snippet_existed = snippet.exists()
            written.append((site, backup, snippet, snippet_existed))
            snippet.write_text(intended, encoding="utf-8")
            site.write_text(updated, encoding="utf-8")
        subprocess.run(["nginx", "-t"], check=True)
        subprocess.run(["systemctl", "reload", "nginx"], check=True)
    except Exception:
        for site, backup, snippet, snippet_existed in reversed(written):
            shutil.copy2(backup, site)
            if not snippet_existed:
                snippet.unlink(missing_ok=True)
        subprocess.run(["nginx", "-t"], check=False)
        subprocess.run(["systemctl", "reload", "nginx"], check=False)
        raise
    print("Nginx validado e recarregado para /vibz/")


if __name__ == "__main__":
    install()
