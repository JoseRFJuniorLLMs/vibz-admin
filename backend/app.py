"""vibz-admin: private Python API for issuing and redeeming Tourist Pass cards."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path

import qrcode
import qrcode.image.svg
from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .auth import Actor, hash_password, new_secret, verify_password
from .store import Store, StoreError, TOKEN_RE, parse_qr


FRONTEND = Path(__file__).with_name("frontend")
COOKIE_NAME = "vibz_session"
DUMMY_HASH = hash_password("this-is-a-placeholder-password")


@dataclass(frozen=True)
class Settings:
    db_path: Path
    public_base_url: str
    secure_cookie: bool = True
    cookie_path: str = "/vibz-admin"
    session_seconds: int = 8 * 3600

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            db_path=Path(os.getenv("VIBZ_DB_PATH", str(Path(__file__).with_name("data") / "vibz.sqlite3"))),
            public_base_url=os.getenv(
                "VIBZ_PUBLIC_BASE_URL", "https://35.247.217.66.nip.io/vibz-admin/p"
            ).rstrip("/"),
        )


class LoginInput(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=256)


class OriginInput(BaseModel):
    name: str = Field(min_length=2, max_length=120)
    category: str = Field(min_length=2, max_length=60)


class IssueInput(BaseModel):
    origin_id: str = Field(min_length=32, max_length=32)
    count: int = Field(ge=1, le=100)
    valid_until: str | None = None


class LookupInput(BaseModel):
    qr: str = Field(min_length=1, max_length=512)


class RedeemInput(BaseModel):
    wristband: str = Field(min_length=1, max_length=32)


def create_app(settings: Settings | None = None, store: Store | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = store or Store(settings.db_path)
    app = FastAPI(title="vibz-admin", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.settings = settings
    app.state.store = store

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Permissions-Policy"] = "camera=(self)"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: blob:; connect-src 'self'; media-src 'self' blob:; "
            "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
        )
        if request.url.path.startswith("/api/") or request.url.path.startswith("/p/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def actor(request: Request) -> Actor:
        token = request.cookies.get(COOKIE_NAME, "")
        if len(token) < 32 or len(token) > 256:
            raise HTTPException(401, "Faça login para continuar")
        token_hash = hashlib.sha256(token.encode("ascii", errors="ignore")).hexdigest()
        session = store.get_session(token_hash)
        if session is None:
            raise HTTPException(401, "Sessão expirada")
        return Actor(
            id=session["id"], username=session["username"], role=session["role"],
            csrf_token=session["csrf_token"], session_hash=token_hash,
        )

    def csrf_actor(request: Request, staff: Actor = Depends(actor)) -> Actor:
        supplied = request.headers.get("X-CSRF-Token", "")
        if not secrets.compare_digest(supplied, staff.csrf_token):
            raise HTTPException(403, "Proteção de sessão inválida")
        return staff

    def admin(staff: Actor = Depends(csrf_actor)) -> Actor:
        if staff.role != "admin":
            raise HTTPException(403, "Ação permitida apenas ao administrador")
        return staff

    def card_response(card: dict) -> dict:
        return {**card, "qr_url": f"{settings.public_base_url}/{card['token']}"}

    def qr_bytes(token: str) -> bytes:
        image = qrcode.make(
            f"{settings.public_base_url}/{token}", image_factory=qrcode.image.svg.SvgPathImage
        )
        output = BytesIO()
        image.save(output)
        return output.getvalue()

    def store_call(fn, *args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except StoreError as exc:
            raise HTTPException(exc.status, str(exc)) from exc

    @app.get("/api/health")
    def health():
        return {"ok": True}

    @app.post("/api/login")
    def login(data: LoginInput, request: Request, response: Response):
        ip = request.client.host if request.client else "unknown"
        key = hashlib.sha256(ip.encode()).hexdigest()
        if not store.login_allowed(key):
            raise HTTPException(429, "Muitas tentativas. Tente novamente em alguns minutos")
        user = store.get_user(data.username)
        valid = verify_password(user["password_hash"] if user else DUMMY_HASH, data.password)
        if not user or not valid:
            store.record_login_failure(key)
            raise HTTPException(401, "Usuário ou senha inválidos")
        store.clear_login_failures(key)
        token = new_secret()
        csrf = new_secret()
        store.create_session(user["id"], hashlib.sha256(token.encode()).hexdigest(), csrf, settings.session_seconds)
        response.set_cookie(
            COOKIE_NAME, token, max_age=settings.session_seconds, path=settings.cookie_path,
            secure=settings.secure_cookie, httponly=True, samesite="strict",
        )
        return {"username": user["username"], "role": user["role"], "csrf_token": csrf}

    @app.get("/api/session")
    def session(staff: Actor = Depends(actor)):
        return {"username": staff.username, "role": staff.role, "csrf_token": staff.csrf_token}

    @app.post("/api/logout", status_code=204)
    def logout(response: Response, staff: Actor = Depends(csrf_actor)):
        store.delete_session(staff.session_hash)
        response.delete_cookie(COOKIE_NAME, path=settings.cookie_path)

    @app.get("/api/origins")
    def origins(_staff: Actor = Depends(actor)):
        return store.list_origins()

    @app.post("/api/origins", status_code=201)
    def create_origin(data: OriginInput, staff: Actor = Depends(admin)):
        return store_call(store.create_origin, data.name, data.category, str(staff.id))

    @app.get("/api/cards")
    def cards(limit: int = 50, origin_id: str | None = None, _staff: Actor = Depends(actor)):
        return [card_response(card) for card in store.list_cards(limit, origin_id)]

    @app.post("/api/cards", status_code=201)
    def issue_cards(data: IssueInput, staff: Actor = Depends(admin)):
        issued = store_call(store.issue, data.origin_id, data.count, data.valid_until, str(staff.id))
        return [
            {
                **card_response(card),
                "qr_data_url": "data:image/svg+xml;base64:" + base64.b64encode(qr_bytes(card["token"])).decode("ascii"),
            }
            for card in issued
        ]

    @app.post("/api/lookup")
    def lookup(data: LookupInput, _staff: Actor = Depends(actor)):
        token = store_call(parse_qr, data.qr, settings.public_base_url)
        return card_response(store_call(store.find, token))

    @app.post("/api/cards/{token}/redeem")
    def redeem(token: str, data: RedeemInput, staff: Actor = Depends(csrf_actor)):
        return card_response(store_call(store.redeem, token, data.wristband, str(staff.id)))

    @app.get("/api/cards/{token}/qr.svg")
    def qr_svg(token: str, _staff: Actor = Depends(actor)):
        card = store_call(store.find, token)
        return Response(qr_bytes(card["token"]), media_type="image/svg+xml")

    @app.get("/p/{token}")
    def public_pass(token: str):
        if not TOKEN_RE.fullmatch(token):
            raise HTTPException(404)
        return FileResponse(FRONTEND / "pass.html")

    @app.get("/")
    def root_page():
        return RedirectResponse("admin/", status_code=307)

    @app.get("/admin/")
    def admin_page():
        return FileResponse(FRONTEND / "admin.html")

    app.mount("/static", StaticFiles(directory=FRONTEND), name="static")
    return app


app = create_app()
