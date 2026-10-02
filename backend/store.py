"""SQLite ledger for origins, sequential passes and one-time redemption."""

from __future__ import annotations

from contextlib import closing
import re
import secrets
import sqlite3
import time
import uuid
from datetime import date, datetime, timezone, timedelta
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
    try:
        return datetime.now(ZoneInfo("America/Sao_Paulo")).date()
    except Exception:
        return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


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
                    role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'portaria', 'bar')),
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
                CREATE TABLE IF NOT EXISTS drinks (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL COLLATE NOCASE,
                    price REAL NOT NULL,
                    dosage TEXT NOT NULL CHECK(dosage IN ('dose','garrafa','lata','unidade')),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS bar_orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    card_id INTEGER NOT NULL REFERENCES cards(id),
                    card_number TEXT NOT NULL,
                    card_token TEXT NOT NULL,
                    operator_id TEXT NOT NULL,
                    operator_username TEXT NOT NULL DEFAULT 'operador',
                    total_amount REAL NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS bar_orders_card_idx ON bar_orders(card_id);
                CREATE INDEX IF NOT EXISTS bar_orders_created_idx ON bar_orders(created_at);
                CREATE TABLE IF NOT EXISTS bar_order_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER NOT NULL REFERENCES bar_orders(id) ON DELETE CASCADE,
                    drink_id INTEGER REFERENCES drinks(id),
                    drink_name TEXT NOT NULL,
                    dosage TEXT NOT NULL,
                    unit_price REAL NOT NULL,
                    quantity INTEGER NOT NULL,
                    subtotal REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS bar_order_items_order_idx ON bar_order_items(order_id);
            """)
            if db.execute("SELECT COUNT(*) FROM drinks").fetchone()[0] == 0:
                initial_drinks = [
                    ("Gin Tropical", 35.0, "dose"),
                    ("Caipirinha Tradicional", 25.0, "dose"),
                    ("Cerveja Long Neck", 18.0, "garrafa"),
                    ("Whisky Red Label", 30.0, "dose"),
                    ("Garrafa Vodka Absolut", 280.0, "garrafa"),
                    ("Garrafa Gin Tanqueray", 320.0, "garrafa"),
                    ("Energético Red Bull", 20.0, "lata"),
                    ("Água Mineral", 8.0, "garrafa"),
                ]
                now = utc_now()
                db.executemany(
                    "INSERT INTO drinks(name, price, dosage, active, created_at) VALUES (?, ?, ?, 1, ?)",
                    [(name, price, dosage, now) for name, price, dosage in initial_drinks],
                )

            # Migração de roles na tabela users se necessário
            user_sql = db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").fetchone()
            if user_sql and "role IN ('admin', 'operator')" in user_sql[0]:
                db.execute("PRAGMA foreign_keys=OFF")
                db.execute("DROP TABLE IF EXISTS users_migrated")
                db.execute("""CREATE TABLE users_migrated (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('admin', 'operator', 'portaria', 'bar')),
                    active INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL
                )""")
                db.execute("INSERT INTO users_migrated(id, username, password_hash, role, active, created_at) SELECT id, username, password_hash, role, active, created_at FROM users")
                db.execute("DROP TABLE users")
                db.execute("ALTER TABLE users_migrated RENAME TO users")
                db.execute("PRAGMA foreign_keys=ON")

            # Se usuário portaria existir mas bar não existir, cria bar com mesmo hash inicial
            portaria_user = db.execute("SELECT password_hash FROM users WHERE username='portaria'").fetchone()
            if portaria_user:
                bar_count = db.execute("SELECT COUNT(*) FROM users WHERE username='bar'").fetchone()[0]
                if bar_count == 0:
                    db.execute(
                        "INSERT INTO users(username, password_hash, role, active, created_at) VALUES ('bar', ?, 'bar', 1, ?)",
                        (portaria_user[0], utc_now()),
                    )

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
                # Regra de negócio: só parceiros confirmados recebem cartões
                if partner["status"] != "parceiro":
                    raise StoreError(
                        f"'{partner['name']}' não é parceiro confirmado. "
                        f"Altere o status para 'Parceiro confirmado' na aba Estabelecimentos antes de emitir cartões.",
                        400,
                    )
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
            row = db.execute(
                """SELECT cards.*, COALESCE(u.username, cards.redeemed_by) AS redeemed_by_username
                   FROM cards
                   LEFT JOIN users u ON u.id = CAST(cards.redeemed_by AS INTEGER)
                   WHERE cards.token=?""",
                (token,),
            ).fetchone()
        if row is None:
            raise StoreError("Cartão não encontrado", 404)
        return self._card(row)

    def list_cards(self, page: int = 1, page_size: int = 20, origin_id: str | None = None, status: str | None = None) -> dict:
        with closing(self._connect()) as db:
            clauses = []
            params = []
            if origin_id:
                clauses.append("cards.origin_id = ?")
                params.append(origin_id)
            if status:
                clauses.append("cards.status = ?")
                params.append(status)

            where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
            total = db.execute(f"SELECT COUNT(*) FROM cards {where}", tuple(params)).fetchone()[0]

            order_by = "ORDER BY cards.redeemed_at DESC, cards.id DESC" if status == "redeemed" else "ORDER BY cards.id DESC"
            query = f"""SELECT cards.*, COALESCE(u.username, cards.redeemed_by) AS redeemed_by_username
                        FROM cards
                        LEFT JOIN users u ON u.id = CAST(cards.redeemed_by AS INTEGER)
                        {where} {order_by} LIMIT ? OFFSET ?"""
            rows = db.execute(query, tuple(params) + (page_size, (page - 1) * page_size))
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
        wristband = (wristband or "").strip()
        if len(wristband) > 32:
            raise StoreError("Número da pulseira deve ter até 32 caracteres")
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
            result_row = db.execute(
                """SELECT cards.*, COALESCE(u.username, cards.redeemed_by) AS redeemed_by_username
                   FROM cards
                   LEFT JOIN users u ON u.id = CAST(cards.redeemed_by AS INTEGER)
                   WHERE cards.token=?""",
                (token,),
            ).fetchone()
            result = self._card(result_row)
            db.commit()
            return result
        except Exception:
            db.rollback()
            raise
        finally:
            db.close()

    def delete_card(self, token: str) -> dict:
        if not TOKEN_RE.fullmatch(token):
            raise StoreError("QR inválido")
        with closing(self._connect()) as db:
            row = db.execute("SELECT id, token FROM cards WHERE token=?", (token,)).fetchone()
            if not row:
                raise StoreError("Cartão não encontrado", 404)
            card_info = {"number": card_number(row["id"]), "token": row["token"]}
            db.execute("DELETE FROM cards WHERE token=?", (token,))
            db.commit()
            return card_info

    def delete_cards_batch(self, tokens: list[str]) -> int:
        valid_tokens = [t.strip() for t in tokens if TOKEN_RE.fullmatch(t.strip())]
        if not valid_tokens:
            raise StoreError("Nenhum cartão válido selecionado para exclusão", 400)
        with closing(self._connect()) as db:
            placeholders = ",".join("?" for _ in valid_tokens)
            cursor = db.execute(f"DELETE FROM cards WHERE token IN ({placeholders})", tuple(valid_tokens))
            deleted_count = cursor.rowcount
            db.commit()
            return deleted_count

    def create_user(self, username: str, password_hash: str, role: str) -> dict:
        username = username.strip().lower()
        if not re.fullmatch(r"[a-z0-9_.-]{3,40}", username):
            raise StoreError("Usuário deve ter 3 a 40 letras, números, pontos ou hífens")
        if role not in {"admin", "operator", "portaria", "bar"}:
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

    def list_users(self, page: int = 1, page_size: int = 20) -> dict:
        with closing(self._connect()) as db:
            total = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            items = [dict(row) for row in db.execute(
                """SELECT id,username,role,active,created_at FROM users
                   ORDER BY username COLLATE NOCASE, id LIMIT ? OFFSET ?""",
                (page_size, (page - 1) * page_size),
            )]
        return self._page(items, total, page, page_size)

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

    def report_admissions(self, days: int = 30, origin_id: str | None = None) -> dict:
        with closing(self._connect()) as db:
            db.row_factory = sqlite3.Row
            origin_clause = "AND origin_id = ?" if origin_id else ""
            origin_params = (origin_id,) if origin_id else ()

            summary_query = f"""
                SELECT
                    COUNT(*) as total_issued,
                    SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) as total_redeemed,
                    SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as total_unused,
                    SUM(CASE WHEN substr(issued_at, 1, 10) = date('now') THEN 1 ELSE 0 END) as today_issued,
                    SUM(CASE WHEN substr(redeemed_at, 1, 10) = date('now') THEN 1 ELSE 0 END) as today_redeemed,
                    SUM(CASE WHEN substr(issued_at, 1, 10) = date('now') AND status = 'issued' THEN 1 ELSE 0 END) as today_unused
                FROM cards
                WHERE 1=1 {origin_clause}
            """
            s_row = db.execute(summary_query, origin_params).fetchone()

            total_issued = (s_row["total_issued"] if s_row else 0) or 0
            total_redeemed = (s_row["total_redeemed"] if s_row else 0) or 0
            total_unused = (s_row["total_unused"] if s_row else 0) or 0
            today_issued = (s_row["today_issued"] if s_row else 0) or 0
            today_redeemed = (s_row["today_redeemed"] if s_row else 0) or 0
            today_unused = (s_row["today_unused"] if s_row else 0) or 0

            conv_rate = round((total_redeemed / total_issued) * 100, 1) if total_issued > 0 else 0.0
            today_conv = round((today_redeemed / today_issued) * 100, 1) if today_issued > 0 else 0.0

            days_param = f"-{max(1, min(days, 365))} days"

            daily_issued_query = f"""
                SELECT
                    substr(issued_at, 1, 10) as day,
                    COUNT(*) as issued,
                    SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) as issued_used,
                    SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as issued_unused
                FROM cards
                WHERE substr(issued_at, 1, 10) >= date('now', ?) {origin_clause}
                GROUP BY substr(issued_at, 1, 10)
            """
            daily_issued = {
                r["day"]: dict(r)
                for r in db.execute(daily_issued_query, (days_param, *origin_params)).fetchall()
            }

            daily_redeemed_query = f"""
                SELECT
                    substr(redeemed_at, 1, 10) as day,
                    COUNT(*) as admissions
                FROM cards
                WHERE redeemed_at IS NOT NULL AND substr(redeemed_at, 1, 10) >= date('now', ?) {origin_clause}
                GROUP BY substr(redeemed_at, 1, 10)
            """
            daily_redeemed = {
                r["day"]: dict(r)
                for r in db.execute(daily_redeemed_query, (days_param, *origin_params)).fetchall()
            }

            all_days = sorted(set(list(daily_issued.keys()) + list(daily_redeemed.keys())), reverse=True)
            daily_stats = []
            for d in all_days:
                iss = daily_issued.get(d, {})
                red = daily_redeemed.get(d, {})
                c_issued = iss.get("issued", 0)
                c_admissions = red.get("admissions", 0)
                c_unused = iss.get("issued_unused", 0)
                rate = round((c_admissions / c_issued) * 100, 1) if c_issued > 0 else (100.0 if c_admissions > 0 else 0.0)
                daily_stats.append({
                    "date": d,
                    "issued": c_issued,
                    "admissions": c_admissions,
                    "unused": c_unused,
                    "conversion_rate": rate,
                })

            partner_query = f"""
                SELECT
                    origin_id,
                    origin_name,
                    COUNT(*) as total_issued,
                    SUM(CASE WHEN status = 'redeemed' THEN 1 ELSE 0 END) as total_admissions,
                    SUM(CASE WHEN status = 'issued' THEN 1 ELSE 0 END) as total_unused
                FROM cards
                WHERE 1=1 {origin_clause}
                GROUP BY origin_id, origin_name
                ORDER BY total_issued DESC
            """
            partner_stats = []
            for r in db.execute(partner_query, origin_params).fetchall():
                p_issued = r["total_issued"] or 0
                p_adm = r["total_admissions"] or 0
                p_unused = r["total_unused"] or 0
                p_rate = round((p_adm / p_issued) * 100, 1) if p_issued > 0 else 0.0
                partner_stats.append({
                    "origin_id": r["origin_id"],
                    "origin_name": r["origin_name"],
                    "issued": p_issued,
                    "admissions": p_adm,
                    "unused": p_unused,
                    "conversion_rate": p_rate,
                })

            hourly_query = f"""
                SELECT CAST(strftime('%H', redeemed_at) AS INTEGER) as hour, COUNT(*) as count
                FROM cards
                WHERE redeemed_at IS NOT NULL AND substr(redeemed_at, 1, 10) = date('now') {origin_clause}
                GROUP BY hour
                ORDER BY hour
            """
            hourly_counts = {
                r["hour"]: r["count"]
                for r in db.execute(hourly_query, origin_params).fetchall()
            }
            hourly_stats = [{"hour": h, "count": hourly_counts.get(h, 0)} for h in range(24)]

            return {
                "summary": {
                    "total_issued": total_issued,
                    "total_admissions": total_redeemed,
                    "total_unused": total_unused,
                    "conversion_rate": conv_rate,
                    "today_issued": today_issued,
                    "today_admissions": today_redeemed,
                    "today_unused": today_unused,
                    "today_conversion_rate": today_conv,
                },
                "daily": daily_stats,
                "partners": partner_stats,
                "hourly_today": hourly_stats,
            }

    # -------------------------------------------------------------
    # MÓDULO BAR & CARDÁPIO DE BEBIDAS
    # -------------------------------------------------------------
    def list_drinks(self, active_only: bool = False) -> list[dict]:
        with closing(self._connect()) as db:
            where = "WHERE active=1" if active_only else ""
            rows = db.execute(f"SELECT * FROM drinks {where} ORDER BY active DESC, name COLLATE NOCASE ASC").fetchall()
            return [dict(row) for row in rows]

    def get_drink(self, drink_id: int) -> dict | None:
        with closing(self._connect()) as db:
            row = db.execute("SELECT * FROM drinks WHERE id=?", (drink_id,)).fetchone()
            return dict(row) if row else None

    def create_drink(self, name: str, price: float, dosage: str) -> dict:
        name = (name or "").strip()
        if not name:
            raise StoreError("Nome da bebida é obrigatório")
        try:
            price = round(float(price), 2)
        except (ValueError, TypeError):
            raise StoreError("Valor da bebida inválido")
        if price <= 0:
            raise StoreError("Valor da bebida deve ser maior que zero")
        dosage = (dosage or "").lower().strip()
        if dosage not in {"dose", "garrafa", "lata", "unidade"}:
            raise StoreError("Dosagem deve ser 'dose', 'garrafa', 'lata' ou 'unidade'")
        now = utc_now()
        with closing(self._connect()) as db:
            cur = db.execute(
                "INSERT INTO drinks(name, price, dosage, active, created_at) VALUES (?, ?, ?, 1, ?)",
                (name, price, dosage, now),
            )
            db.commit()
            return {"id": cur.lastrowid, "name": name, "price": price, "dosage": dosage, "active": 1, "created_at": now}

    def update_drink(self, drink_id: int, changes: dict) -> dict:
        valid_fields = {"name", "price", "dosage", "active"}
        set_parts = []
        params = []
        for key, val in changes.items():
            if key not in valid_fields:
                continue
            if key == "name":
                val = (val or "").strip()
                if not val:
                    raise StoreError("Nome não pode ser vazio")
            elif key == "price":
                try:
                    val = round(float(val), 2)
                except (ValueError, TypeError):
                    raise StoreError("Valor inválido")
                if val <= 0:
                    raise StoreError("Valor deve ser maior que zero")
            elif key == "dosage":
                val = str(val).lower().strip()
                if val not in {"dose", "garrafa", "lata", "unidade"}:
                    raise StoreError("Dosagem deve ser 'dose', 'garrafa', 'lata' ou 'unidade'")
            elif key == "active":
                val = 1 if val else 0
            set_parts.append(f"{key} = ?")
            params.append(val)
        if not set_parts:
            raise StoreError("Nenhum dado informado para alteração")
        with closing(self._connect()) as db:
            params.append(drink_id)
            cur = db.execute(f"UPDATE drinks SET {', '.join(set_parts)} WHERE id=?", tuple(params))
            db.commit()
            if cur.rowcount == 0:
                raise StoreError("Bebida não encontrada", 404)
            row = db.execute("SELECT * FROM drinks WHERE id=?", (drink_id,)).fetchone()
            return dict(row)

    def delete_drink(self, drink_id: int) -> bool:
        with closing(self._connect()) as db:
            orders_count = db.execute("SELECT COUNT(*) FROM bar_order_items WHERE drink_id=?", (drink_id,)).fetchone()[0]
            if orders_count > 0:
                cur = db.execute("UPDATE drinks SET active=0 WHERE id=?", (drink_id,))
            else:
                cur = db.execute("DELETE FROM drinks WHERE id=?", (drink_id,))
            db.commit()
            if cur.rowcount == 0:
                raise StoreError("Bebida não encontrada", 404)
            return True

    def find_card_any(self, identifier: str, public_base_url: str = "") -> dict:
        raw = (identifier or "").strip()
        if not raw:
            raise StoreError("Informe o cartão ou escaneie o QR", 400)
        # 1. Se URL
        if raw.startswith("http://") or raw.startswith("https://"):
            if public_base_url:
                try:
                    token = parse_qr(raw, public_base_url)
                    return self.find(token)
                except Exception:
                    pass
            clean_path = urlsplit(raw).path.rstrip("/")
            last_segment = clean_path.split("/")[-1] if clean_path else ""
            if TOKEN_RE.fullmatch(last_segment):
                try:
                    return self.find(last_segment)
                except Exception:
                    pass
        # 2. Se token direto
        if TOKEN_RE.fullmatch(raw):
            try:
                return self.find(raw)
            except Exception:
                pass
        # 3. Se número VIBZ-XXXXXX ou apenas números
        cleaned_num = raw.upper().replace("VIBZ-", "").replace("VIBZ", "").strip()
        if cleaned_num.isdigit():
            card_id = int(cleaned_num)
            with closing(self._connect()) as db:
                row = db.execute(
                    """SELECT cards.*, COALESCE(u.username, cards.redeemed_by) AS redeemed_by_username
                       FROM cards
                       LEFT JOIN users u ON u.id = CAST(cards.redeemed_by AS INTEGER)
                       WHERE cards.id=?""",
                    (card_id,),
                ).fetchone()
                if row:
                    return self._card(row)
        # 4. Busca exata de token ou fallback
        with closing(self._connect()) as db:
            row = db.execute(
                """SELECT cards.*, COALESCE(u.username, cards.redeemed_by) AS redeemed_by_username
                   FROM cards
                   LEFT JOIN users u ON u.id = CAST(cards.redeemed_by AS INTEGER)
                   WHERE cards.token=?""",
                (raw,),
            ).fetchone()
            if row:
                return self._card(row)
        raise StoreError(f"Cartão '{raw}' não encontrado.", 404)

    def create_bar_order(self, card_identifier: str, items: list[dict], operator_uid: str, operator_username: str, public_base_url: str = "") -> dict:
        card = self.find_card_any(card_identifier, public_base_url)
        if not items:
            raise StoreError("Selecione ao menos uma bebida")
        prepared_items = []
        total_amount = 0.0
        with closing(self._connect()) as db:
            for it in items:
                drink_id = it.get("drink_id")
                try:
                    qty = int(it.get("quantity", 1))
                except (ValueError, TypeError):
                    continue
                if qty <= 0:
                    continue
                d_row = db.execute("SELECT * FROM drinks WHERE id=?", (drink_id,)).fetchone()
                if not d_row:
                    raise StoreError(f"Bebida ID {drink_id} não encontrada")
                drink = dict(d_row)
                unit_price = float(drink["price"])
                subtotal = round(unit_price * qty, 2)
                total_amount += subtotal
                prepared_items.append({
                    "drink_id": drink["id"],
                    "drink_name": drink["name"],
                    "dosage": drink["dosage"],
                    "unit_price": unit_price,
                    "quantity": qty,
                    "subtotal": subtotal,
                })
            if not prepared_items:
                raise StoreError("Quantidade inválida de itens")
            total_amount = round(total_amount, 2)
            now = utc_now()
            db.execute("BEGIN IMMEDIATE")
            try:
                order_cur = db.execute(
                    """INSERT INTO bar_orders(card_id, card_number, card_token, operator_id, operator_username, total_amount, created_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?)""",
                    (card["id"], card["number"], card["token"], str(operator_uid), operator_username, total_amount, now),
                )
                order_id = order_cur.lastrowid
                for item in prepared_items:
                    db.execute(
                        """INSERT INTO bar_order_items(order_id, drink_id, drink_name, dosage, unit_price, quantity, subtotal)
                           VALUES (?, ?, ?, ?, ?, ?, ?)""",
                        (order_id, item["drink_id"], item["drink_name"], item["dosage"], item["unit_price"], item["quantity"], item["subtotal"]),
                    )
                db.commit()
                return {
                    "id": order_id,
                    "card_id": card["id"],
                    "card_number": card["number"],
                    "card_token": card["token"],
                    "origin_name": card["origin_name"],
                    "operator_username": operator_username,
                    "total_amount": total_amount,
                    "created_at": now,
                    "items": prepared_items,
                }
            except Exception:
                db.rollback()
                raise

    def get_card_consumption(self, card_identifier: str, public_base_url: str = "") -> dict:
        card = self.find_card_any(card_identifier, public_base_url)
        with closing(self._connect()) as db:
            orders = db.execute(
                """SELECT id, total_amount, operator_username, created_at
                   FROM bar_orders WHERE card_id=? ORDER BY created_at DESC, id DESC""",
                (card["id"],)
            ).fetchall()
            orders_list = []
            total_spent = 0.0
            for ord_row in orders:
                ord_dict = dict(ord_row)
                items = db.execute(
                    """SELECT drink_name, dosage, unit_price, quantity, subtotal
                       FROM bar_order_items WHERE order_id=? ORDER BY id ASC""",
                    (ord_dict["id"],)
                ).fetchall()
                ord_dict["items"] = [dict(it) for it in items]
                total_spent += float(ord_dict["total_amount"])
                orders_list.append(ord_dict)

            summary_items = db.execute(
                """SELECT drink_name, dosage, SUM(quantity) as total_qty, SUM(subtotal) as total_subtotal
                   FROM bar_order_items boi
                   JOIN bar_orders bo ON bo.id = boi.order_id
                   WHERE bo.card_id=?
                   GROUP BY drink_name, dosage
                   ORDER BY total_qty DESC""",
                (card["id"],)
            ).fetchall()

            return {
                "card": card,
                "total_spent": round(total_spent, 2),
                "total_orders": len(orders_list),
                "summary_items": [dict(it) for it in summary_items],
                "orders": orders_list,
            }

    def list_all_consumption(self, page: int = 1, page_size: int = 20, q: str = "") -> dict:
        with closing(self._connect()) as db:
            where_clauses = []
            params = []
            if q.strip():
                param_q = f"%{q.strip()}%"
                where_clauses.append("(c.id = ? OR c.origin_name LIKE ? OR bo.card_number LIKE ?)")
                clean = q.upper().replace("VIBZ-", "").replace("VIBZ", "").strip()
                cid = int(clean) if clean.isdigit() else -1
                params.extend([cid, param_q, param_q])
            where = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

            total = db.execute(f"SELECT COUNT(DISTINCT bo.card_id) FROM bar_orders bo JOIN cards c ON c.id = bo.card_id {where}", tuple(params)).fetchone()[0]

            query = f"""
                SELECT bo.card_id, bo.card_number, c.origin_name,
                       COUNT(DISTINCT bo.id) as order_count,
                       SUM(bo.total_amount) as total_spent,
                       MAX(bo.created_at) as last_order_at,
                       (SELECT GROUP_CONCAT(boi.quantity || 'x ' || boi.drink_name, ', ')
                        FROM bar_order_items boi
                        JOIN bar_orders bo2 ON bo2.id = boi.order_id
                        WHERE bo2.card_id = bo.card_id) as items_summary
                FROM bar_orders bo
                JOIN cards c ON c.id = bo.card_id
                {where}
                GROUP BY bo.card_id, bo.card_number, c.origin_name
                ORDER BY last_order_at DESC, total_spent DESC
                LIMIT ? OFFSET ?
            """
            rows = db.execute(query, tuple(params) + (page_size, (page - 1) * page_size)).fetchall()
            items = []
            for r in rows:
                rd = dict(r)
                rd["total_spent"] = round(float(rd["total_spent"] or 0), 2)
                items.append(rd)
            return self._page(items, total, page, page_size)

    def daily_bar_report(self, date_str: str | None = None) -> dict:
        if not date_str:
            date_str = local_today().isoformat()
        try:
            parsed_date = date.fromisoformat(date_str)
        except Exception:
            parsed_date = local_today()
            date_str = parsed_date.isoformat()

        try:
            tz = ZoneInfo("America/Sao_Paulo")
        except Exception:
            tz = timezone(timedelta(hours=-3))
        day_start_local = datetime.combine(parsed_date, datetime.min.time(), tzinfo=tz)
        day_end_local = datetime.combine(parsed_date, datetime.max.time(), tzinfo=tz)
        start_utc = day_start_local.astimezone(timezone.utc).isoformat(timespec="seconds")
        end_utc = day_end_local.astimezone(timezone.utc).isoformat(timespec="seconds")

        with closing(self._connect()) as db:
            summary_row = db.execute(
                """SELECT COUNT(DISTINCT bo.id) as order_count,
                          COUNT(DISTINCT bo.card_id) as customer_count,
                          COALESCE(SUM(bo.total_amount), 0.0) as total_revenue
                   FROM bar_orders bo
                   WHERE bo.created_at >= ? AND bo.created_at <= ?""",
                (start_utc, end_utc),
            ).fetchone()

            items_rows = db.execute(
                """SELECT boi.drink_name, boi.dosage,
                          SUM(boi.quantity) as quantity_sold,
                          ROUND(AVG(boi.unit_price), 2) as avg_unit_price,
                          ROUND(SUM(boi.subtotal), 2) as total_revenue
                   FROM bar_order_items boi
                   JOIN bar_orders bo ON bo.id = boi.order_id
                   WHERE bo.created_at >= ? AND bo.created_at <= ?
                   GROUP BY boi.drink_name, boi.dosage
                   ORDER BY total_revenue DESC, quantity_sold DESC""",
                (start_utc, end_utc),
            ).fetchall()

            total_drinks_sold = sum(r["quantity_sold"] for r in items_rows)

            recent_orders = db.execute(
                """SELECT bo.id, bo.card_number, bo.operator_username, bo.total_amount, bo.created_at,
                          (SELECT GROUP_CONCAT(boi.quantity || 'x ' || boi.drink_name, ', ')
                           FROM bar_order_items boi WHERE boi.order_id = bo.id) as items_summary
                   FROM bar_orders bo
                   WHERE bo.created_at >= ? AND bo.created_at <= ?
                   ORDER BY bo.created_at DESC, bo.id DESC LIMIT 50""",
                (start_utc, end_utc),
            ).fetchall()

            return {
                "date": date_str,
                "summary": {
                    "total_revenue": round(float(summary_row["total_revenue"]), 2),
                    "total_drinks_sold": total_drinks_sold,
                    "order_count": summary_row["order_count"],
                    "customer_count": summary_row["customer_count"],
                },
                "drinks_breakdown": [dict(r) for r in items_rows],
                "recent_orders": [dict(r) for r in recent_orders],
            }

