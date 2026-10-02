"""vibz-admin: private Python API for issuing and redeeming Tourist Pass cards."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
import zipfile
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Literal

import qrcode
import qrcode.image.svg
from PIL import Image, ImageDraw, ImageFont
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
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


class NewUserInput(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=12, max_length=256)
    role: Literal["admin", "operator", "portaria", "bar"]


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
    wristband: str = Field(default="", max_length=32)


class ExportInput(BaseModel):
    tokens: list[str] = Field(min_length=1, max_length=100)


class DeleteBatchInput(BaseModel):
    tokens: list[str] = Field(min_length=1, max_length=500)


Category = Literal["hospedagem", "gastronomia", "praia"]
PartnerStatus = Literal["nao_contatado", "contatado", "interessado", "parceiro"]
Priority = Literal["baixa", "media", "alta"]


class PartnerUpdate(BaseModel):
    neighborhood: str | None = Field(default=None, max_length=120)
    address: str | None = Field(default=None, max_length=240)
    phone: str | None = Field(default=None, max_length=40)
    whatsapp: str | None = Field(default=None, max_length=40)
    instagram: str | None = Field(default=None, max_length=120)
    website: str | None = Field(default=None, max_length=240)
    manager: str | None = Field(default=None, max_length=120)
    estimated_rooms: int | None = Field(default=None, ge=0, le=10000)
    priority: Priority | None = None
    status: PartnerStatus | None = None


class DrinkInput(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    price: float = Field(gt=0)
    dosage: str = Field(pattern=r"^(dose|garrafa|lata|unidade)$")


class DrinkUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    price: float | None = Field(default=None, gt=0)
    dosage: str | None = Field(default=None, pattern=r"^(dose|garrafa|lata|unidade)$")
    active: bool | None = None


class BarOrderItemInput(BaseModel):
    drink_id: int
    quantity: int = Field(default=1, ge=1, le=100)


class BarOrderInput(BaseModel):
    card: str = Field(min_length=1, max_length=512)
    items: list[BarOrderItemInput] = Field(min_length=1, max_length=50)


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
        if request.url.path.startswith(("/api/", "/p/", "/static/", "/admin/")):
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

    def admin_read(staff: Actor = Depends(actor)) -> Actor:
        if staff.role != "admin":
            raise HTTPException(403, "Ação permitida apenas ao administrador")
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

    def make_card_image(card: dict) -> Image.Image:
        bg_path = FRONTEND / "card-bg.jpg"
        if bg_path.exists():
            base = Image.open(bg_path).convert("RGBA")
        else:
            base = Image.new("RGBA", (1024, 619), "#0b0a10")

        qr = qrcode.QRCode(
            version=1,
            error_correction=qrcode.constants.ERROR_CORRECT_M,
            box_size=10,
            border=1,
        )
        qr.add_data(f"{settings.public_base_url}/{card['token']}")
        qr.make(fit=True)
        qr_img = qr.make_image(fill_color="black", back_color="white").convert("RGBA")
        qr_img = qr_img.resize((122, 122), Image.Resampling.LANCZOS)
        base.paste(qr_img, (830, 411))

        draw = ImageDraw.Draw(base)
        font_num = None
        font_meta = None
        font_small = None
        font_candidates_mono = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf",
            "C:\\Windows\\Fonts\\consola.ttf",
            "C:\\Windows\\Fonts\\arialbd.ttf",
        ]
        font_candidates_sans = [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "C:\\Windows\\Fonts\\arialbd.ttf",
            "C:\\Windows\\Fonts\\arial.ttf",
        ]
        for fp in font_candidates_mono:
            if os.path.exists(fp):
                try:
                    font_num = ImageFont.truetype(fp, 20)
                    break
                except Exception:
                    pass

        for fp in font_candidates_sans:
            if os.path.exists(fp):
                try:
                    font_meta = ImageFont.truetype(fp, 12)
                    font_small = ImageFont.truetype(fp, 11)
                    break
                except Exception:
                    pass

        if font_num is None:
            font_num = font_meta = font_small = ImageFont.load_default()

        num = card.get("number", "VIBZ-000000")
        origem = card.get("origin_name", "VIBZ TOURIST PASS")
        validade = card.get("valid_until")

        # Alinhamento harmônico à direita das barras diagonais neon (///)
        draw.text((160, 542), num, fill="#ffffff", font=font_num)
        draw.text((160, 568), str(origem)[:30], fill="#ff9e73", font=font_meta)
        if validade:
            draw.text((160, 586), f"VÁLIDO ATÉ {validade}", fill="#a8a0b0", font=font_small)
        else:
            draw.text((160, 586), "ENTRADA CORTESIA", fill="#a8a0b0", font=font_small)

        return base.convert("RGB")

    def card_png_bytes(card: dict) -> bytes:
        img = make_card_image(card)
        output = BytesIO()
        img.save(output, format="PNG")
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

    @app.get("/api/users")
    def users(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
              _staff: Actor = Depends(admin_read)):
        return store.list_users(page, page_size)

    @app.post("/api/users", status_code=201)
    def create_user(data: NewUserInput, _staff: Actor = Depends(admin)):
        return store_call(store.create_user, data.username, hash_password(data.password), data.role)

    @app.get("/api/origins")
    def origins(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                _staff: Actor = Depends(actor)):
        return store.list_origins(page, page_size)

    @app.get("/api/origins/options")
    def origin_options(_staff: Actor = Depends(actor)):
        return store.origin_options()

    @app.post("/api/origins", status_code=201)
    def create_origin(data: OriginInput, staff: Actor = Depends(admin)):
        return store_call(store.create_origin, data.name, data.category, str(staff.id))

    @app.get("/api/cards")
    def cards(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
              origin_id: str | None = None, status: str | None = None, _staff: Actor = Depends(actor)):
        result = store.list_cards(page, page_size, origin_id=origin_id, status=status)
        result["items"] = [card_response(card) for card in result["items"]]
        return result

    @app.get("/api/partners")
    def partners(page: int = Query(1, ge=1), page_size: int = Query(20, ge=1, le=100),
                 category: Category | None = None, status: PartnerStatus | None = None,
                 q: str = Query("", max_length=120), _staff: Actor = Depends(actor)):
        return store.list_partners(page, page_size, category, status, q)

    @app.patch("/api/partners/{identifier}")
    def update_partner(identifier: str, data: PartnerUpdate, _staff: Actor = Depends(admin)):
        changes = data.model_dump(exclude_unset=True)
        for key, value in list(changes.items()):
            if key != "estimated_rooms":
                changes[key] = (value or "").strip()
        return store_call(store.update_partner, identifier, changes)

    @app.post("/api/cards", status_code=201)
    def issue_cards(data: IssueInput, staff: Actor = Depends(admin)):
        issued = store_call(store.issue, data.origin_id, data.count, data.valid_until, str(staff.id))
        res = []
        for card in issued:
            png_data = card_png_bytes(card)
            res.append({
                **card_response(card),
                "qr_data_url": "data:image/svg+xml;base64," + base64.b64encode(qr_bytes(card["token"])).decode("ascii"),
                "card_data_url": "data:image/png;base64," + base64.b64encode(png_data).decode("ascii"),
                "card_image_url": f"cards/{card['token']}/card.png",
            })
        return res

    @app.post("/api/lookup")
    def lookup(data: LookupInput, _staff: Actor = Depends(actor)):
        token = store_call(parse_qr, data.qr, settings.public_base_url)
        return card_response(store_call(store.find, token))

    @app.post("/api/cards/{token}/redeem")
    def redeem(token: str, data: RedeemInput, staff: Actor = Depends(csrf_actor)):
        return card_response(store_call(store.redeem, token, data.wristband, str(staff.id)))

    @app.delete("/api/cards/{token}")
    def delete_single_card(token: str, _staff: Actor = Depends(csrf_actor)):
        deleted = store_call(store.delete_card, token)
        return {"ok": True, "number": deleted["number"], "token": deleted["token"]}

    @app.post("/api/cards/delete-batch")
    def delete_cards_batch(data: DeleteBatchInput, _staff: Actor = Depends(csrf_actor)):
        count = store_call(store.delete_cards_batch, data.tokens)
        return {"ok": True, "deleted_count": count}

    @app.get("/api/cards/{token}/qr.svg")
    def qr_svg(token: str, _staff: Actor = Depends(actor)):
        card = store_call(store.find, token)
        return Response(qr_bytes(card["token"]), media_type="image/svg+xml")

    @app.get("/api/cards/{token}/card.png")
    def card_png(token: str, _staff: Actor = Depends(actor)):
        card = store_call(store.find, token)
        return Response(
            card_png_bytes(card),
            media_type="image/png",
            headers={"Content-Disposition": f'inline; filename="{card["number"]}.png"'},
        )

    @app.post("/api/cards/export.zip")
    def export_zip(data: ExportInput, _staff: Actor = Depends(actor)):
        """Gera ZIP com imagens PNG completas de cada cartão, PDF unificado, SVG e CSV."""
        valid_tokens = [t for t in data.tokens if TOKEN_RE.fullmatch(t)]
        if not valid_tokens:
            raise HTTPException(400, "Nenhum token válido informado")
        buf = BytesIO()
        csv_rows = ["Numero,Origem,Validade,Token,Link_Publico"]
        bg_path = FRONTEND / "card-bg.jpg"
        bg_bytes = bg_path.read_bytes() if bg_path.exists() else b""

        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            cards_html_parts = []
            pdf_images = []
            for token in valid_tokens:
                card = store_call(store.find, token)
                num = card["number"]
                origem = card.get("origin_name", "")
                validade = card.get("valid_until") or "Sem validade"
                public_link = f"{settings.public_base_url}/{token}"

                # 1. Cartão completo montado em PNG (1024x619) de alta definição
                card_img = make_card_image(card)
                pdf_images.append(card_img)
                png_buf = BytesIO()
                card_img.save(png_buf, format="PNG")
                card_png_data = png_buf.getvalue()
                zf.writestr(f"{num}-CARTAO-VIP-PRONTO.png", card_png_data)
                zf.writestr(f"cartoes-completos-png/{num}.png", card_png_data)

                # 2. QR Code individual em SVG vetorial
                svg_data = qr_bytes(token)
                zf.writestr(f"qrcodes-svg/{num}.svg", svg_data)

                csv_rows.append(f'"{num}","{origem}","{validade}","{token}","{public_link}"')
                card_b64 = base64.b64encode(card_png_data).decode("ascii")
                cards_html_parts.append(f"""
                <div class="card-item">
                  <img src="data:image/png;base64,{card_b64}" alt="{num}">
                </div>""")

            # 3. PDF de todos os cartões reunidos para bureau e impressão direta
            if pdf_images:
                pdf_buf = BytesIO()
                pdf_images[0].save(pdf_buf, format="PDF", save_all=True, append_images=pdf_images[1:])
                zf.writestr("TODOS-OS-CARTOES-IMPRESSAO.pdf", pdf_buf.getvalue())

            if bg_bytes:
                zf.writestr("matriz-opcional/arte-cartao-vip-matriz-sem-dados.jpg", bg_bytes)

            zf.writestr("relacao-cartoes-lote.csv", "\ufeff" + "\n".join(csv_rows))
            zf.writestr(
                "especificacoes-grafica.txt",
                "ESPECIFICAÇÕES PARA A GRÁFICA - VIBZ TOURIST PASS / VIP MEMBER\n"
                "----------------------------------------------------------\n"
                "- Padrão físico: Cartão PVC formato CR-80 (85.60 mm x 53.98 mm)\n"
                "- Cantos: Arredondados raio 3.18 mm\n"
                "- Arquivos na raiz do ZIP: '{num}-CARTAO-VIP-PRONTO.png' (cada cartão montado pronto para produção)\n"
                "- Pasta /cartoes-completos-png/: Cada cartão montado em alta resolução (1024x619) com fundo, logo, chip e QR Code pronto para impressão\n"
                "- Arquivo TODOS-OS-CARTOES-IMPRESSAO.pdf: Todos os cartões reunidos em um único PDF multipágina para bureau/gráfica\n"
                "- Pasta /qrcodes-svg/: SVGs vetoriais dos QR Codes de cada cartão\n"
                "- Arquivo relacao-cartoes-lote.csv: Relação de todos os números, tokens e links de acesso\n"
                "- Arquivo visualizador-para-impressao.html: Visualizador para impressão direta em papel ou PDF\n"
            )

            html_viewer = f"""<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>VIBZ Tourist Pass - Amostra para Gráfica ({len(valid_tokens)} cartões)</title>
<style>
  @page {{ size: A4; margin: 10mm; }}
  * {{ box-sizing: border-box; }}
  body {{ font-family: Inter, Arial, sans-serif; background: #0c0b12; color: #fff; margin: 0; padding: 20px; }}
  .header {{ text-align: center; margin-bottom: 24px; }}
  .header h1 {{ margin: 0 0 6px; font-size: 22px; color: #ff9e73; }}
  .header p {{ margin: 0; font-size: 13px; color: #b8b4bf; }}
  .sheet {{ display: grid; grid-template-columns: repeat(2, 85.6mm); gap: 8mm; justify-content: center; }}
  .card-item {{ width: 85.6mm; height: 53.98mm; border-radius: 12px; overflow: hidden; page-break-inside: avoid; }}
  .card-item img {{ width: 100%; height: 100%; object-fit: cover; display: block; border-radius: 12px; }}
  @media print {{
    body {{ background: #fff; color: #000; padding: 0; }}
    .header {{ display: none; }}
    .card-item img {{ border: 1px solid #111; }}
  }}
</style>
</head>
<body>
  <div class="header">
    <h1>VIBZ TOURIST PASS · LOTE PARA GRÁFICA</h1>
    <p>{len(valid_tokens)} cartões completos montados em alta definição. Use Ctrl+P para imprimir ou gerar PDF.</p>
  </div>
  <div class="sheet">
    {"".join(cards_html_parts)}
  </div>
</body>
</html>"""
            zf.writestr("visualizador-para-impressao.html", html_viewer)

        buf.seek(0)
        filename = f"vibz-lote-grafica-{len(valid_tokens)}.zip"
        return Response(
            buf.read(),
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename={filename}"},
        )

    @app.get("/api/reports/admissions")
    def get_admissions_report(days: int = 30, origin_id: str | None = None, _staff: Actor = Depends(actor)):
        return store_call(
            store.report_admissions,
            days=days,
            origin_id=(origin_id or None) if origin_id != "all" else None
        )

    # -------------------------------------------------------------
    # ENDPOINTS BAR & CARDÁPIO DE BEBIDAS
    # -------------------------------------------------------------
    @app.get("/api/bar/drinks")
    def list_drinks(active_only: bool = False, _staff: Actor = Depends(actor)):
        return store.list_drinks(active_only=active_only)

    @app.post("/api/bar/drinks", status_code=201)
    def create_drink(data: DrinkInput, _staff: Actor = Depends(admin)):
        return store_call(store.create_drink, data.name, data.price, data.dosage)

    @app.patch("/api/bar/drinks/{drink_id}")
    def update_drink(drink_id: int, data: DrinkUpdate, _staff: Actor = Depends(admin)):
        changes = data.model_dump(exclude_unset=True)
        return store_call(store.update_drink, drink_id, changes)

    @app.delete("/api/bar/drinks/{drink_id}")
    def delete_drink(drink_id: int, _staff: Actor = Depends(admin)):
        store_call(store.delete_drink, drink_id)
        return {"ok": True, "drink_id": drink_id}

    @app.get("/api/bar/card/{identifier}")
    def get_bar_card_consumption(identifier: str, _staff: Actor = Depends(actor)):
        return store_call(store.get_card_consumption, identifier, settings.public_base_url)

    @app.post("/api/bar/order", status_code=201)
    def create_bar_order(data: BarOrderInput, staff: Actor = Depends(csrf_actor)):
        items_dict = [it.model_dump() for it in data.items]
        return store_call(
            store.create_bar_order,
            data.card,
            items_dict,
            str(staff.id),
            staff.username,
            settings.public_base_url,
        )

    @app.get("/api/bar/reports/consumption")
    def bar_consumption_report(
        page: int = Query(1, ge=1),
        page_size: int = Query(20, ge=1, le=100),
        q: str = Query("", max_length=120),
        _staff: Actor = Depends(actor),
    ):
        return store.list_all_consumption(page=page, page_size=page_size, q=q)

    @app.get("/api/bar/reports/daily")
    def bar_daily_report(date: str | None = None, _staff: Actor = Depends(actor)):
        return store.daily_bar_report(date_str=date)

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
