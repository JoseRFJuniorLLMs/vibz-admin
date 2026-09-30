"""SQLite ledger for origins, sequential passes and one-time redemption."""

from __future__ import annotations

from contextlib import closing
import re
import secrets
import sqlite3
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo


TOKEN_RE = re.compile(r"^[A-Za-z0-9_-]{32}$")


class StoreError(Exception):
    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def local_today() -> date:
    return datetime.now(ZoneInfo("America/Sao_Paulo")).date()


def card_number(number: int) -> str:
    return f"VIBZ-{number:06d}"


def parse_qr(value: str, public_base_url: str) -> str:
    value = value.strip()
    if TOKEN_RE.fullmatch(value):
        return value
    parsed = urlsplit(value)
    base = urlsplit(public_base_url.rstrip("/"))
    prefix = base.path.rstrip("/") + "/"
    if (
        parsed.scheme != "https"
        or parsed.netloc != base.netloc
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith(prefix)
    ):
        raise StoreError("QR não pertence ao VIBZ")
    token = parsed.path[len(prefix):]
    if not TOKEN_RE.fullmatch(token):
        raise StoreError("QR inválido")
    return token


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self._connect()) as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS origins (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    category TEXT NOT NULL,
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    created_by TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS cards (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    token TEXT NOT NULL UNIQUE,
                    origin_id TEXT NOT NULL REFERENCES origins(id),
                    origin_name TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'issued' CHECK(status IN ('issued', 'redeemed')),
                    issued_at TEXT NOT NULL,
                    issued_by TEXT NOT NULL,
                    valid_until TEXT,
                    redeemed_at TEXT,
                    redeemed_by TEXT,
                    wristband TEXT
                );
                CREATE INDEX IF NOT EXISTS cards_origin_idx ON cards(origin_id, id);
                CREATE INDEX IF NOT EXISTS cards_status_idx ON cards(status, id);
                CREATE TABLE IF NOT EXISTS users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('admin', 'operator')),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY,
                    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
                    csrf_token TEXT NOT NULL,
                    expires_at INTEGER NOT NULL
                );
                CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
                CREATE TABLE IF NOT EXISTS login_limits (
                    key TEXT PRIMARY KEY,
                    attempts INTEGER NOT NULL,
                    started_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS partners (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    category TEXT NOT NULL CHECK(category IN ('hospedagem','gastronomia','praia')),
                    neighborhood TEXT NOT NULL DEFAULT '',
                    address TEXT NOT NULL DEFAULT '',
                    phone TEXT NOT NULL DEFAULT '',
                    whatsapp TEXT NOT NULL DEFAULT '',
                    instagram TEXT NOT NULL DEFAULT '',
                    website TEXT NOT NULL DEFAULT '',
                    manager TEXT NOT NULL DEFAULT '',
                    estimated_rooms INTEGER CHECK(estimated_rooms IS NULL OR estimated_rooms >= 0),
                    priority TEXT NOT NULL DEFAULT 'media' CHECK(priority IN ('baixa','media','alta')),
                    status TEXT NOT NULL DEFAULT 'nao_contatado' CHECK(status IN ('nao_contatado','contatado','interessado','parceiro')),
                    source_note TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS partners_filter_idx ON partners(category,status,name);
            """)

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=20, isolation_level=None)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=20000")
        return db

    @staticmethod
    def _card(row: sqlite3.Row) -> dict:
        result = dict(row)
        result["number"] = card_number(result["id"])
        result["expired"] = bool(result["valid_until"] and result["valid_until"] < local_today().isoformat())
        return result

    def create_origin(self, name: str, category: str, uid: str) -> dict:
        origin = {
            "id": uuid.uuid4().hex,
            "name": name.strip(),
            "category": category.strip(),
            "active": 1,
            "created_at": utc_now(),
            "created_by": uid,
        }
        if not origin["name"] or not origin["category"]:
            raise StoreError("Origem e categoria são obrigatórias")
        with closing(self._connect()) as db:
            db.execute(
                "INSERT INTO origins(id,name,category,active,created_at,created_by) VALUES (:id,:name,:category,:active,:created_at,:created_by)",
                origin,
            )
        return origin

    def list_origins(self, page: int = 1, page_size: int = 20) -> dict:
        with closing(self._connect()) as db:
            total = db.execute("SELECT COUNT(*) FROM origins").fetchone()[0]
            items = [dict(row) for row in db.execute(
                "SELECT * FROM origins ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?",
                (page_size, (page - 1) * page_size),
            )]
        return self._page(items, total, page, page_size)

    def origin_options(self) -> list[dict]:
        with closing(self._connect()) as db:
            registered = [dict(row) | {"source": "origin", "status": None} for row in db.execute(
                "SELECT id,name,category FROM origins WHERE active=1"
            )]
            prospects = [dict(row) | {"source": "prospect"} for row in db.execute(
                """SELECT p.id,p.name,p.category,p.status FROM partners p
                   WHERE NOT EXISTS (
                     SELECT 1 FROM origins o WHERE o.id=p.id OR o.name=p.name COLLATE NOCASE
                   )"""
            )]
        return sorted(registered + prospects, key=lambda item: (item["name"].casefold(), item["id"]))

    @staticmethod
    def _page(items: list[dict], total: int, page: int, page_size: int) -> dict:
        return {"items": items, "total": total, "page": page,
                "page_size": page_size, "pages": (total + page_size - 1) // page_size}

    def issue(self, origin_id: str, count: int, valid_until: str | None, uid: str) -> list[dict]:
        if not 1 <= count <= 100:
            raise StoreError("Emita de 1 a 100 cartões por lote")
        if valid_until:
            try:
                if date.fromisoformat(valid_until) < local_today():
                    raise StoreError("A validade não pode estar no passado")
            except ValueError as exc:
                raise StoreError("Data de validade inválida") from exc
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            origin = db.execute("SELECT * FROM origins WHERE id=?", (origin_id,)).fetchone()
            if origin is not None and not origin["active"]:
                raise StoreError("Origem não encontrada ou inativa", 404)
            if origin is None:
                partner = db.execute("SELECT * FROM partners WHERE id=?", (origin_id,)).fetchone()
                if partner is None:
                    raise StoreError("Origem não encontrada ou inativa", 404)
                origin = db.execute("SELECT * FROM origins WHERE name=? COLLATE NOCASE", (partner["name"],)).fetchone()
                if origin is not None and not origin["active"]:
                    raise StoreError("Origem não encontrada ou inativa", 404)
                if origin is None:
                    now = utc_now()
                    category = {"hospedagem": "Hospedagem", "gastronomia": "Gastronomia", "praia": "Praia"}[partner["category"]]
                    db.execute(
                        """INSERT INTO origins(id,name,category,active,created_at,created_by)
                           VALUES (?,?,?,1,?,?)""",
                        (partner["id"], partner["name"], category, now, uid),
                    )
                    origin = db.execute("SELECT * FROM origins WHERE id=?", (partner["id"],)).fetchone()
            issued = []
            now = utc_now()
            for _ in range(count):
                token = secrets.token_urlsafe(24)
                cursor = db.execute(
                    """INSERT INTO cards(token,origin_id,origin_name,issued_at,issued_by,valid_until)
                       VALUES (?,?,?,?,?,?)""",
                    (token, origin["id"], origin["name"], now, uid, valid_until),
                )
                issued.append(self._card(db.execute("SELECT * FROM cards WHERE id=?", (cursor.lastrowid,)).fetchone()))
            db.commit()
            return issued
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def find(self, token: str) -> dict:
        if not TOKEN_RE.fullmatch(token):
            raise StoreError("QR inválido")
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM cards WHERE token=?", (token,)).fetchone()
        if row is None:
            raise StoreError("Cartão não encontrado", 404)
        return self._card(row)

    def list_cards(self, page: int = 1, page_size: int = 20, origin_id: str | None = None) -> dict:
        with closing(self._connect()) as db:
            if origin_id:
                total = db.execute("SELECT COUNT(*) FROM cards WHERE origin_id=?", (origin_id,)).fetchone()[0]
                rows = db.execute("SELECT * FROM cards WHERE origin_id=? ORDER BY id DESC LIMIT ? OFFSET ?", (origin_id, page_size, (page - 1) * page_size))
            else:
                total = db.execute("SELECT COUNT(*) FROM cards").fetchone()[0]
                rows = db.execute("SELECT * FROM cards ORDER BY id DESC LIMIT ? OFFSET ?", (page_size, (page - 1) * page_size))
            items = [self._card(row) for row in rows]
        return self._page(items, total, page, page_size)

    def seed_partners(self, entries: list[tuple[str, str]]) -> int:
        inserted = 0
        now = utc_now()
        with closing(self._connect()) as db:
            for category, name in entries:
                identifier = uuid.uuid5(uuid.NAMESPACE_URL, f"vibz-buzios-2026:{name.casefold()}").hex
                result = db.execute(
                    """INSERT OR IGNORE INTO partners(id,name,category,source_note,created_at,updated_at)
                       VALUES (?,?,?,?,?,?)""",
                    (identifier, name, category, "Base de prospecção fornecida pelo proprietário em 2026; parceria e contatos não verificados.", now, now),
                )
                inserted += result.rowcount
        return inserted

    def list_partners(self, page: int = 1, page_size: int = 20, category: str | None = None,
                      status: str | None = None, query: str = "") -> dict:
        clauses = []
        args: list[str] = []
        if category:
            clauses.append("category=?")
            args.append(category)
        if status:
            clauses.append("status=?")
            args.append(status)
        if query.strip():
            clauses.append("name LIKE ? ESCAPE '\\'")
            escaped = query.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
            args.append(f"%{escaped}%")
        where = " WHERE " + " AND ".join(clauses) if clauses else ""
        with closing(self._connect()) as db:
            total = db.execute("SELECT COUNT(*) FROM partners" + where, args).fetchone()[0]
            items = [dict(row) for row in db.execute(
                "SELECT * FROM partners" + where + " ORDER BY name COLLATE NOCASE, id LIMIT ? OFFSET ?",
                (*args, page_size, (page - 1) * page_size),
            )]
        return self._page(items, total, page, page_size)

    def update_partner(self, identifier: str, changes: dict) -> dict:
        fields = ("neighborhood", "address", "phone", "whatsapp", "instagram", "website",
                  "manager", "estimated_rooms", "priority", "status")
        updates = {key: changes[key] for key in fields if key in changes}
        if not updates:
            raise StoreError("Nenhum campo para atualizar")
        updates["updated_at"] = utc_now()
        updates["id"] = identifier
        assignments = ", ".join(f"{key}=:{key}" for key in updates if key != "id")
        with closing(self._connect()) as db:
            cursor = db.execute(f"UPDATE partners SET {assignments} WHERE id=:id", updates)
            if not cursor.rowcount:
                raise StoreError("Estabelecimento não encontrado", 404)
            return dict(db.execute("SELECT * FROM partners WHERE id=?", (identifier,)).fetchone())

    def redeem(self, token: str, wristband: str, uid: str) -> dict:
        if not TOKEN_RE.fullmatch(token):
            raise StoreError("QR inválido")
        wristband = wristband.strip()
        if not 1 <= len(wristband) <= 32:
            raise StoreError("Informe o número da pulseira (até 32 caracteres)")
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM cards WHERE token=?", (token,)).fetchone()
            if row is None:
                raise StoreError("Cartão não encontrado", 404)
            if row["status"] != "issued":
                raise StoreError("Cartão já utilizado", 409)
            if row["valid_until"] and row["valid_until"] < local_today().isoformat():
                raise StoreError("Cartão vencido", 409)
            db.execute(
                """UPDATE cards SET status='redeemed', redeemed_at=?, redeemed_by=?, wristband=?
                   WHERE token=? AND status='issued'""",
                (utc_now(), uid, wristband, token),
            )
            result = self._card(db.execute("SELECT * FROM cards WHERE token=?", (token,)).fetchone())
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def create_user(self, username: str, password_hash: str, role: str) -> dict:
        username = username.strip().lower()
        if not re.fullmatch(r"[a-z0-9_.-]{3,40}", username):
            raise StoreError("Usuário deve ter 3 a 40 letras, números, pontos ou hífens")
        if role not in {"admin", "operator"}:
            raise StoreError("Papel inválido")
        try:
            with closing(self._connect()) as db:
                cursor = db.execute(
                    "INSERT INTO users(username,password_hash,role,created_at) VALUES (?,?,?,?)",
                    (username, password_hash, role, utc_now()),
                )
                return {"id": cursor.lastrowid, "username": username, "role": role}
        except sqlite3.IntegrityError as exc:
            raise StoreError("Usuário já existe", 409) from exc

    def get_user(self, username: str) -> dict | None:
        with closing(self._connect()) as db:
            row = db.execute(
                "SELECT * FROM users WHERE username=? COLLATE NOCASE AND active=1", (username,)
            ).fetchone()
            return dict(row) if row else None

    def set_password(self, username: str, password_hash: str) -> bool:
        db = self._connect()
        try:
            db.execute("BEGIN IMMEDIATE")
            cursor = db.execute(
                "UPDATE users SET password_hash=? WHERE username=? COLLATE NOCASE",
                (password_hash, username),
            )
            if cursor.rowcount:
                db.execute("DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=? COLLATE NOCASE)", (username,))
            db.commit()
            return bool(cursor.rowcount)
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def create_session(self, user_id: int, token_hash: str, csrf_token: str, lifetime: int) -> None:
        now = int(time.time())
        with closing(self._connect()) as db:
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (now,))
            db.execute(
                "INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)",
                (token_hash, user_id, csrf_token, now + lifetime),
            )

    def get_session(self, token_hash: str) -> dict | None:
        with closing(self._connect()) as db:
            row = db.execute(
                """SELECT s.token_hash,s.csrf_token,s.expires_at,u.id,u.username,u.role
                   FROM sessions s JOIN users u ON u.id=s.user_id
                   WHERE s.token_hash=? AND s.expires_at>? AND u.active=1""",
                (token_hash, int(time.time())),
            ).fetchone()
            return dict(row) if row else None

    def delete_session(self, token_hash: str) -> None:
        with closing(self._connect()) as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (token_hash,))

    def login_allowed(self, key: str) -> bool:
        now = int(time.time())
        with closing(self._connect()) as db:
            row = db.execute("SELECT attempts,started_at FROM login_limits WHERE key=?", (key,)).fetchone()
        return row is None or row["started_at"] < now - 600 or row["attempts"] < 8

    def record_login_failure(self, key: str) -> None:
        now = int(time.time())
        with closing(self._connect()) as db:
            db.execute("DELETE FROM login_limits WHERE started_at<?", (now - 86400,))
            db.execute(
                """INSERT INTO login_limits(key,attempts,started_at) VALUES (?,1,?)
                   ON CONFLICT(key) DO UPDATE SET
                     attempts=CASE WHEN started_at<? THEN 1 ELSE attempts+1 END,
                     started_at=CASE WHEN started_at<? THEN excluded.started_at ELSE started_at END""",
                (key, now, now - 600, now - 600),
            )

    def clear_login_failures(self, key: str) -> None:
        with closing(self._connect()) as db:
            db.execute("DELETE FROM login_limits WHERE key=?", (key,))
