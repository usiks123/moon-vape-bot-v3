import os, re, hmac, hashlib, json, time, html, asyncio, logging
from datetime import datetime, timezone, timedelta
from contextlib import asynccontextmanager
from typing import Optional, Literal
from urllib.parse import parse_qsl
from uuid import UUID
import httpx
from fastapi import FastAPI, Request, HTTPException, Depends, Header, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from aiogram import Bot, Dispatcher, Router, F
from aiogram.client.default import DefaultBotProperties
from aiogram.filters import CommandStart
from aiogram.exceptions import TelegramForbiddenError, TelegramRetryAfter
from aiogram.types import Update, InlineKeyboardMarkup, InlineKeyboardButton, CallbackQuery, Message, WebAppInfo

log = logging.getLogger("moonvape")
BOT_TOKEN = os.environ["BOT_TOKEN"]; SB = os.environ["SUPABASE_URL"].rstrip("/"); KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
WEBAPP = os.environ["WEBAPP_URL"].rstrip("/")
# Роли хранятся в таблице admins (миграция 0003). OWNER_* — только для ссылки «Написать менеджеру» по умолчанию.
OWNER_USERNAME = os.getenv("OWNER_USERNAME", "").lstrip("@")
OWNER_ID = int(os.getenv("OWNER_TELEGRAM_ID", "7858672760"))
PUBLIC = (os.getenv("BACKEND_URL") or os.getenv("RENDER_EXTERNAL_URL") or "").rstrip("/")
SECRET = hashlib.sha256(BOT_TOKEN.encode()).hexdigest()
H = {"apikey": KEY, "Authorization": f"Bearer {KEY}", "Content-Type": "application/json"}
http = httpx.AsyncClient(timeout=20)
bot = Bot(BOT_TOKEN, default=DefaultBotProperties(parse_mode="HTML"))
router = Router(); dp = Dispatcher(); dp.include_router(router)
STATUS = {"new": "Новый", "confirmed": "Подтверждён", "prepared": "Подготовлен", "issued": "Выдан", "cancelled": "Отменён", "returned": "Возвращён"}
CUSTOMER_MSG = {
    "new": "Заказ #{n} создан. Ожидайте подтверждения.",
    "confirmed": "Заказ #{n} подтверждён.",
    "prepared": "Заказ #{n} подготовлен.",
    "issued": "Заказ #{n} выдан. Спасибо за покупку!",
    "cancelled": "Заказ #{n} отменён.",
    "returned": "Оформлен возврат по заказу #{n}.",
}
# Какие кнопки видит администратор для каждого статуса (переходы дополнительно проверяет БД).
ADMIN_ACTIONS = {
    "new": [("✅ Подтвердить", "confirmed"), ("❌ Отменить", "cancelled")],
    "confirmed": [("📦 Подготовлен", "prepared"), ("❌ Отменить", "cancelled")],
    "prepared": [("🤝 Выдан", "issued"), ("❌ Отменить", "cancelled")],
    "issued": [("↩️ Возврат", "returned")],
}
RPC_ERR = {
    "forbidden": "Нет доступа", "bad_transition": "Этот переход статуса недопустим", "already_paid": "Заказ уже отмечен оплаченным",
    "bad_status": "В этом статусе оплату отметить нельзя", "order_not_found": "Заказ не найден",
    "below_reserved": "Нельзя установить остаток меньше резерва", "exceeds_balance": "Сумма больше задолженности",
}
MAX_ATTEMPTS = 8
LEASE = timedelta(seconds=120)
_SNAKE = re.compile(r"^[a-z_]{3,60}$")

def now_iso(): return datetime.now(timezone.utc).isoformat()
def eur(x) -> str: return f"{float(x or 0):.2f}".replace(".", ",") + " €"
def e(s): return html.escape(str(s if s is not None else ""))

# ----------------------------------------------------------------- БД (PostgREST)
def _map_error(code: int, msg: str):
    if msg == "forbidden": return 403, "forbidden"
    if msg in {"order_not_found", "item_not_found", "user_not_found"}: return 404, msg
    if code == 400: return 409, (msg if _SNAKE.match(msg or "") else "conflict")
    if code == 409: return 409, "conflict"
    log.error("db error %s: %s", code, (msg or "")[:200])
    return 500, "db_error"

async def db(method, path, prefer=None, **kw):
    h = dict(H)
    if prefer: h["Prefer"] = prefer
    r = await http.request(method, f"{SB}/rest/v1/{path}", headers=h, **kw)
    if r.status_code >= 400:
        try: msg = r.json().get("message", "")
        except Exception: msg = ""
        raise HTTPException(*_map_error(r.status_code, msg))
    return r.json() if r.content else None

async def rpc(name, args):
    # PostgREST отдаёт jsonb-результат функции как есть: объект или массив. Не разворачиваем массивы —
    # иначе get_cart и admin_inventory вернули бы только первую позицию.
    return await db("POST", f"rpc/{name}", json=args)

# ----------------------------------------------------------------- Авторизация Telegram
def verify(init: str) -> dict:
    d = dict(parse_qsl(init, keep_blank_values=True)); h = d.pop("hash", None)
    if not h or "user" not in d: raise HTTPException(401, "invalid_init_data")
    chk = "\n".join(f"{k}={v}" for k, v in sorted(d.items()))
    sk = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
    if not hmac.compare_digest(hmac.new(sk, chk.encode(), hashlib.sha256).hexdigest(), h): raise HTTPException(401, "bad_signature")
    if time.time() - int(d.get("auth_date", "0")) > 86400: raise HTTPException(401, "expired")
    return json.loads(d["user"])

async def current_user(authorization: str = Header("")):
    if not authorization.startswith("tma "): raise HTTPException(401, "no_auth")
    u = verify(authorization[4:])
    rows = await db("POST", "users?on_conflict=telegram_id", prefer="resolution=merge-duplicates,return=representation", json={
        "telegram_id": u["id"], "username": u.get("username"), "first_name": u.get("first_name"), "last_name": u.get("last_name"),
        "photo_url": u.get("photo_url"), "updated_at": now_iso()})
    return rows[0]

async def admin_ctx(authorization: str = Header("")) -> dict:
    """Роль берётся из таблицы admins по Telegram ID из проверенного initData. Клиенту роль не доверяем."""
    if not authorization.startswith("tma "): raise HTTPException(401, "no_auth")
    u = verify(authorization[4:])
    rows = await db("GET", "admins", params={"telegram_id": f"eq.{u['id']}", "is_active": "eq.true", "select": "telegram_id,role,city_id"})
    if not rows: raise HTTPException(403, "not_admin")
    return {"telegram_id": u["id"], "role": rows[0]["role"], "city_id": rows[0]["city_id"]}

def scope_city(ctx: dict, requested: Optional[str]) -> Optional[str]:
    """Владелец: любой город или None (вся сеть). Admin города: только свой город."""
    if ctx["role"] == "owner": return requested or None
    if requested and requested != ctx["city_id"]: raise HTTPException(403, "forbidden")
    return ctx["city_id"]

def require_owner(ctx: dict):
    if ctx["role"] != "owner": raise HTTPException(403, "forbidden")

async def city_name_map() -> dict:
    rows = await db("GET", "cities", params={"select": "id,name,manager_link,active", "order": "sort.asc"}) or []
    return {c["id"]: c for c in rows}

# ----------------------------------------------------------------- Заказы: тексты и клавиатуры
ORDER_SELECT = "*,users(first_name,last_name,username,telegram_id),order_items(id,inventory_id,product_id,product_name,variant_name,flavor_name,quantity,unit_price,base_price,is_wholesale,tier_label),cities(name)"

async def fetch_order(oid):
    rows = await db("GET", "orders", params={"id": f"eq.{oid}", "select": ORDER_SELECT})
    if not rows: raise HTTPException(404, "order_not_found")
    return rows[0]

def city_title(o) -> str:
    # Город — первая строка уведомления, крупно и текстом (не только цветом).
    name = ((o.get("cities") or {}).get("name") or "").strip()
    return f"📍 <b>{e(name.upper())}</b>" if name else "📍 <b>ГОРОД НЕ УКАЗАН</b>"

def order_text(o) -> str:
    u = o.get("users") or {}
    buyer = " ".join(x for x in [u.get("first_name"), u.get("last_name")] if x) or "—"
    items = "\n".join(
        f"• {e(i['product_name'])}"
        + (f" · {e(i['variant_name'])}" if i.get("variant_name") else "")
        + f" — {i['quantity']} шт."
        + (" (опт)" if i.get("is_wholesale") else "")
        for i in o.get("order_items", []))
    header = "🛒 <b>Новый заказ</b>" if o["status"] == "new" else "🛒 <b>Заказ</b>"
    paid = "✅ оплачен" if o.get("paid_at") else "⏳ не оплачен"
    approval = "\n⚠️ <b>Требует согласования цены</b> (крупный заказ, итог не назначен)" if o.get("approval_required") else ""
    return (f"{city_title(o)}\n\n{header} №{e(o['number'])}\n"
            f"Единиц: {o.get('total_units', 0)} · ступень: {e(o.get('tier_label') or '—')}{approval}\n\n"
            f"Покупатель: {e(buyer)} {('@' + e(u['username'])) if u.get('username') else ''}\n"
            f"Telegram ID: <code>{o['telegram_id']}</code>\n\n"
            f"Товары:\n{items}\n\n"
            f"Сумма: <b>{eur(o['total'])}</b>\n"
            f"Оплата: {paid}\n"
            f"Статус: <b>{STATUS.get(o['status'], o['status'])}</b>")

def order_kb(o) -> Optional[InlineKeyboardMarkup]:
    rows = []
    btns = [InlineKeyboardButton(text=t, callback_data=f"st:{o['id']}:{s}") for t, s in ADMIN_ACTIONS.get(o["status"], [])]
    if btns: rows.append(btns)
    if o["status"] not in ("cancelled", "returned") and not o.get("paid_at"):
        rows.append([InlineKeyboardButton(text="💶 Отметить оплаченным", callback_data=f"pd:{o['id']}")])
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None

# ----------------------------------------------------------------- Очередь уведомлений
async def enqueue(rows: list):
    if rows: await db("POST", "outbox", json=rows)

async def enqueue_admins(order_id: str, city_id):
    """Владелец и администратор ТОГО ЖЕ города. Чужой город не получает уведомление."""
    admins = await db("GET", "admins", params={"is_active": "eq.true", "select": "telegram_id,role,city_id"}) or []
    rows = [{"chat_id": a["telegram_id"], "kind": "order_admin", "order_id": order_id}
            for a in admins if a["role"] == "owner" or (city_id and a["city_id"] == city_id)]
    await enqueue(rows)

async def enqueue_order_created(order_id: str):
    o = await fetch_order(order_id)
    await enqueue_admins(order_id, o.get("city_id"))
    await enqueue([{"chat_id": o["telegram_id"], "kind": "order_customer", "text": CUSTOMER_MSG["new"].format(n=o["number"])}])

async def enqueue_customer_status(o_id: str, status: str):
    o = await fetch_order(o_id)
    await enqueue([{"chat_id": o["telegram_id"], "kind": "order_customer", "text": CUSTOMER_MSG[status].format(n=o["number"])}])

async def mark_blocked(chat_id: int):
    try: await db("PATCH", "users", params={"telegram_id": f"eq.{chat_id}"}, json={"bot_blocked": True})
    except Exception: log.warning("could not mark user blocked")

async def deliver_one(row: dict):
    # «Аренда» строки: два процесса не отправят одно сообщение дважды.
    lease_until = (datetime.now(timezone.utc) + LEASE).isoformat()
    claimed = await db("PATCH", "outbox", prefer="return=representation",
                       params={"id": f"eq.{row['id']}", "status": "eq.pending", "next_attempt_at": f"lte.{now_iso()}"},
                       json={"next_attempt_at": lease_until})
    if not claimed: return
    attempts = int(row.get("attempts") or 0) + 1
    try:
        if row["kind"] == "order_admin":
            o = await fetch_order(row["order_id"]); text, kb = order_text(o), order_kb(o)
        else:
            text, kb = row["text"], None
        await bot.send_message(row["chat_id"], text, reply_markup=kb)
        await db("PATCH", "outbox", params={"id": f"eq.{row['id']}"}, json={"status": "sent", "attempts": attempts, "sent_at": now_iso(), "last_error": None})
    except TelegramForbiddenError:
        if row["kind"] != "order_admin": await mark_blocked(row["chat_id"])
        await db("PATCH", "outbox", params={"id": f"eq.{row['id']}"}, json={"status": "failed", "attempts": attempts, "last_error": "forbidden"})
    except TelegramRetryAfter as ex:
        await db("PATCH", "outbox", params={"id": f"eq.{row['id']}"}, json={"attempts": attempts,
                 "next_attempt_at": (datetime.now(timezone.utc) + timedelta(seconds=ex.retry_after + 1)).isoformat(), "last_error": "rate_limited"})
    except HTTPException as ex:
        await db("PATCH", "outbox", params={"id": f"eq.{row['id']}"}, json={"status": "failed" if attempts >= MAX_ATTEMPTS else "pending",
                 "attempts": attempts, "last_error": str(ex.detail)[:200], "next_attempt_at": (datetime.now(timezone.utc) + timedelta(seconds=min(3600, 30 * 2 ** attempts))).isoformat()})
    except Exception as ex:
        log.warning("send failed: %s", type(ex).__name__)
        await db("PATCH", "outbox", params={"id": f"eq.{row['id']}"}, json={"status": "failed" if attempts >= MAX_ATTEMPTS else "pending",
                 "attempts": attempts, "last_error": type(ex).__name__[:200],
                 "next_attempt_at": (datetime.now(timezone.utc) + timedelta(seconds=min(3600, 30 * 2 ** attempts))).isoformat()})

async def deliver_pending(limit: int = 100, broadcast_id: Optional[int] = None):
    params = {"status": "eq.pending", "next_attempt_at": f"lte.{now_iso()}", "order": "id.asc", "limit": str(limit)}
    if broadcast_id is not None: params["broadcast_id"] = f"eq.{broadcast_id}"
    for row in await db("GET", "outbox", params=params) or []:
        await deliver_one(row)
        await asyncio.sleep(0.05)  # ~20 сообщений в секунду: ниже лимита Telegram

async def retry_loop():
    while True:
        try: await deliver_pending()
        except Exception: log.exception("retry loop iteration failed")
        await asyncio.sleep(30)

def bg(coro):
    t = asyncio.create_task(coro)
    t.add_done_callback(lambda f: f.exception() and log.warning("background task failed: %s", type(f.exception()).__name__))
    return t

# ----------------------------------------------------------------- Бот
@router.message(CommandStart())
async def start(m: Message):
    # Фиксируем, что бот может писать пользователю (для рассылок).
    try:
        await db("POST", "users?on_conflict=telegram_id", prefer="resolution=merge-duplicates,return=minimal", json={
            "telegram_id": m.from_user.id, "username": m.from_user.username, "first_name": m.from_user.first_name,
            "bot_started_at": now_iso(), "bot_blocked": False})
    except Exception: log.warning("could not record bot start")
    await m.answer("Добро пожаловать в <b>MoonVape</b>!", reply_markup=InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="Открыть магазин", web_app=WebAppInfo(url=WEBAPP))]]))

async def _refresh_card(c: CallbackQuery, oid: str):
    o = await fetch_order(oid)
    try: await c.message.edit_text(order_text(o), reply_markup=order_kb(o))
    except Exception: pass  # сообщение не изменилось или устарело — не критично

@router.callback_query(F.data.startswith("st:"))
async def on_status(c: CallbackQuery):
    parts = (c.data or "").split(":")
    if len(parts) != 3 or parts[2] not in ("confirmed", "prepared", "issued", "cancelled", "returned"):
        return await c.answer("Некорректная команда", show_alert=True)
    oid, st = parts[1], parts[2]
    try: await rpc("change_order_status", {"p_order": oid, "p_new": st, "p_actor": c.from_user.id})
    except HTTPException as ex: return await c.answer(RPC_ERR.get(str(ex.detail), "Ошибка"), show_alert=True)
    await enqueue_customer_status(oid, st)
    bg(deliver_pending())
    await _refresh_card(c, oid)
    await c.answer("Статус обновлён")

@router.callback_query(F.data.startswith("pd:"))
async def on_paid(c: CallbackQuery):
    oid = (c.data or "").split(":")[1] if ":" in (c.data or "") else ""
    try: await rpc("mark_order_paid", {"p_order": oid, "p_actor": c.from_user.id})
    except HTTPException as ex: return await c.answer(RPC_ERR.get(str(ex.detail), "Ошибка"), show_alert=True)
    await _refresh_card(c, oid)
    await c.answer("Оплата отмечена")

@asynccontextmanager
async def lifespan(app):
    if PUBLIC:
        await bot.set_webhook(f"{PUBLIC}/telegram/webhook", secret_token=SECRET, allowed_updates=["message", "callback_query"])
    task = asyncio.create_task(retry_loop())
    yield
    task.cancel()
    await http.aclose(); await bot.session.close()

app = FastAPI(lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=[WEBAPP], allow_methods=["*"], allow_headers=["*"])

@app.get("/health")
async def health(): return {"ok": True}

@app.post("/telegram/webhook")
async def webhook(req: Request):
    if req.headers.get("X-Telegram-Bot-Api-Secret-Token") != SECRET: raise HTTPException(403, "forbidden")
    await dp.feed_update(bot, Update.model_validate(await req.json()))
    return {"ok": True}

# ----------------------------------------------------------------- Покупатель
class Item(BaseModel):
    inventory_id: UUID; quantity: int = Field(gt=0, le=1000)
class CartIn(BaseModel):
    items: list[Item] = Field(max_length=200)
class OrderIn(BaseModel):
    items: list[Item] = Field(min_length=1, max_length=100)
    comment: str = Field("", max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=100)
class CityIn(BaseModel):
    city_id: str = Field(min_length=2, max_length=40)
class OrderPreviewIn(BaseModel):
    items: list[Item] = Field(min_length=1, max_length=100)
class NotifyIn(BaseModel):
    notify_stock: bool

@app.get("/api/me")
async def me(u=Depends(current_user)):
    cities = await city_name_map()
    c = cities.get(u.get("city_id")) if u.get("city_id") else None
    manager = (c or {}).get("manager_link") or (f"https://t.me/{OWNER_USERNAME}" if OWNER_USERNAME else None)
    return {"user": u, "cities": [{"id": x["id"], "name": x["name"]} for x in cities.values() if x.get("active")],
            "city": {"id": c["id"], "name": c["name"]} if c else None, "manager_link": manager}

@app.put("/api/me/city")
async def set_city(b: CityIn, u=Depends(current_user)):
    cities = await city_name_map()
    if not cities.get(b.city_id, {}).get("active"): raise HTTPException(400, "bad_city")
    await db("PATCH", "users", params={"id": f"eq.{u['id']}"}, json={"city_id": b.city_id, "updated_at": now_iso()})
    # Корзина не переносится на другой склад автоматически: фронтенд покажет предупреждение.
    return {"ok": True, "city_id": b.city_id}

@app.put("/api/me/notifications")
async def set_notifications(b: NotifyIn, u=Depends(current_user)):
    await db("PATCH", "users", params={"id": f"eq.{u['id']}"}, json={"notify_stock": b.notify_stock})
    return {"ok": True}

@app.get("/api/catalog")
async def catalog(q: str = "", u=Depends(current_user)):
    if not u.get("city_id"): raise HTTPException(409, "city_required")
    return await rpc("get_catalog", {"p_city": u["city_id"], "p_q": q.strip()[:60]})

@app.post("/api/pricing/preview")
async def pricing_preview(b: OrderPreviewIn, u=Depends(current_user)):
    if not u.get("city_id"): raise HTTPException(409, "city_required")
    return await rpc("pricing_preview", {"p_city": u["city_id"], "p_items": [{"inventory_id": str(i.inventory_id), "quantity": i.quantity} for i in b.items]})

@app.get("/api/cart")
async def get_cart(u=Depends(current_user)): return await rpc("get_cart", {"p_user": u["id"]}) or []

@app.put("/api/cart")
async def put_cart(b: CartIn, u=Depends(current_user)):
    await rpc("save_cart", {"p_user": u["id"], "p_items": [{"inventory_id": str(i.inventory_id), "quantity": i.quantity} for i in b.items]})
    return {"ok": True}

@app.post("/api/orders")
async def create_order(b: OrderIn, u=Depends(current_user)):
    if not u.get("city_id"): raise HTTPException(409, "city_required")
    # Контакт формируется на сервере из данных Telegram. Адрес и доставка не запрашиваются.
    contact = ("@" + u["username"]) if u.get("username") else (" ".join(x for x in [u.get("first_name"), u.get("last_name")] if x) or "Покупатель Telegram")
    res = await rpc("create_order", {"p_user": u["id"], "p_city": u["city_id"],
        "p_items": [{"inventory_id": str(i.inventory_id), "quantity": i.quantity} for i in b.items],
        "p_contact": contact[:200], "p_comment": b.comment.strip(), "p_key": f"{u['id']}:{b.idempotency_key}"})
    if not res.get("duplicate"):
        bg(_after_order(res["id"]))
    return res

async def _after_order(order_id: str):
    try:
        await enqueue_order_created(order_id)
        await deliver_pending()
    except Exception:
        # Заказ уже сохранён в БД. Строки очереди не созданы — владелец увидит заказ в админке.
        log.exception("order notification enqueue failed for %s", order_id)

ORDER_FIELDS = "id,number,status,total,created_at,city_id,paid_at,contact,comment,total_units,tier_label,approval_required,cities(name),order_items(id,inventory_id,product_id,product_name,variant_name,flavor_name,quantity,unit_price,base_price,is_wholesale,tier_label,products(image_path))"

def _items_payload(items): return [{"inventory_id": str(i.inventory_id), "quantity": i.quantity} for i in items]

@app.post("/api/orders/{oid}/edit/preview")
async def edit_preview(oid: UUID, b: OrderPreviewIn, u=Depends(current_user)):
    # Проверка владельца и статуса выполняется в RPC (чужой заказ = not found).
    return await rpc("customer_edit_preview", {"p_user": u["id"], "p_order": str(oid), "p_items": _items_payload(b.items)})

@app.post("/api/orders/{oid}/edit")
async def edit_order(oid: UUID, b: CustomerEditIn, u=Depends(current_user)):
    res = await rpc("customer_edit_order", {"p_user": u["id"], "p_order": str(oid), "p_items": _items_payload(b.items),
                                            "p_key": f"{u['id']}:{b.idempotency_key}"})
    if not res.get("duplicate"):
        bg(_after_edit(str(oid)))
    return res

async def _after_edit(order_id: str):
    try:
        o = await fetch_order(order_id)
        await enqueue_admins(order_id, o.get("city_id"))
        await deliver_pending()
    except Exception:
        log.exception("edit notification failed for %s", order_id)

@app.get("/api/orders")
async def my_orders(u=Depends(current_user)):
    return await db("GET", "orders", params={"user_id": f"eq.{u['id']}", "select": "id,number,status,total,created_at,city_id,paid_at,cities(name)",
                                             "order": "created_at.desc", "limit": "100"}) or []

@app.get("/api/orders/{oid}")
async def my_order(oid: UUID, u=Depends(current_user)):
    rows = await db("GET", "orders", params={"id": f"eq.{oid}", "user_id": f"eq.{u['id']}", "select": ORDER_FIELDS})
    if not rows: raise HTTPException(404, "not_found")
    o = rows[0]
    o["editable"] = o["status"] in ("new", "confirmed") and bool(o.get("city_id"))
    return o

# ----------------------------------------------------------------- Админ: общее
@app.get("/api/check-admin")
async def check_admin_endpoint(authorization: str = Header("")):
    try:
        ctx = await admin_ctx(authorization)
        return {"isAdmin": True, "role": ctx["role"], "city_id": ctx["city_id"]}
    except HTTPException:
        return {"isAdmin": False, "role": None, "city_id": None}

@app.get("/api/admin/cities")
async def admin_cities(ctx=Depends(admin_ctx)):
    rows = await db("GET", "cities", params={"select": "id,name,manager_link,manager_contact,active", "order": "sort.asc"}) or []
    if ctx["role"] != "owner": rows = [r for r in rows if r["id"] == ctx["city_id"]]
    return rows

@app.get("/api/admin/dashboard")
async def admin_dashboard(city: Optional[str] = None, ctx=Depends(admin_ctx)):
    return await rpc("admin_dashboard", {"p_actor": ctx["telegram_id"], "p_city": scope_city(ctx, city)})

@app.get("/api/admin/catalog")
async def admin_catalog(ctx=Depends(admin_ctx)):
    return await rpc("admin_catalog", {"p_actor": ctx["telegram_id"]})

# ----------------------------------------------------------------- Админ: склад
class StockIn(BaseModel):
    inventory_id: UUID; quantity: int = Field(ge=0, le=100000)
    kind: Literal["receipt", "adjust"] = "adjust"; reason: str = Field("", max_length=200)
class TransferIn(BaseModel):
    from_inventory_id: UUID; to_inventory_id: UUID; quantity: int = Field(gt=0, le=100000); reason: str = Field("", max_length=200)

@app.get("/api/admin/inventory")
async def admin_inventory(city: Optional[str] = None, ctx=Depends(admin_ctx)):
    c = scope_city(ctx, city)
    if not c: raise HTTPException(400, "city_required")
    return await rpc("admin_inventory", {"p_actor": ctx["telegram_id"], "p_city": c})

@app.post("/api/admin/inventory")
async def admin_set_inventory(b: StockIn, ctx=Depends(admin_ctx)):
    # Проверка города выполняется в RPC (admin_set_stock), здесь только передача данных.
    return await rpc("admin_set_stock", {"p_actor": ctx["telegram_id"], "p_inventory": str(b.inventory_id), "p_new_qty": b.quantity,
                                         "p_kind": b.kind, "p_reason": b.reason.strip() or None})

@app.get("/api/admin/inventory/{inventory_id}/history")
async def inventory_history(inventory_id: UUID, limit: int = Query(100, ge=1, le=500), ctx=Depends(admin_ctx)):
    return await rpc("admin_stock_history", {"p_actor": ctx["telegram_id"], "p_inventory": str(inventory_id), "p_limit": limit})

@app.post("/api/admin/transfers")
async def transfer_stock(b: TransferIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    return await rpc("admin_transfer_stock", {"p_actor": ctx["telegram_id"], "p_from": str(b.from_inventory_id),
                                              "p_to": str(b.to_inventory_id), "p_qty": b.quantity, "p_reason": b.reason.strip() or None})

# ----------------------------------------------------------------- Админ: заказы
class StatusIn(BaseModel):
    status: Literal["confirmed", "prepared", "issued", "cancelled", "returned"]

@app.get("/api/admin/orders")
async def admin_list_orders(city: Optional[str] = None, status: Optional[str] = None, limit: int = Query(100, ge=1, le=300), ctx=Depends(admin_ctx)):
    params = {"select": ORDER_SELECT, "limit": str(limit)}
    c = scope_city(ctx, city)
    if c: params["city_id"] = f"eq.{c}"
    if status:
        if status not in STATUS: raise HTTPException(400, "bad_status")
        params["status"] = f"eq.{status}"
    params["order"] = "created_at.asc" if status == "new" else "created_at.desc"
    return await db("GET", "orders", params=params) or []

@app.get("/api/admin/orders/{order_id}")
async def admin_get_order(order_id: UUID, ctx=Depends(admin_ctx)):
    o = await fetch_order(str(order_id))
    if ctx["role"] != "owner" and o.get("city_id") != ctx["city_id"]: raise HTTPException(404, "order_not_found")
    return o

@app.patch("/api/admin/orders/{order_id}")
async def admin_update_order_status(order_id: UUID, b: StatusIn, ctx=Depends(admin_ctx)):
    res = await rpc("change_order_status", {"p_order": str(order_id), "p_new": b.status, "p_actor": ctx["telegram_id"]})
    await enqueue_customer_status(str(order_id), b.status)
    bg(deliver_pending())
    return res

@app.post("/api/admin/orders/{order_id}/approve")
async def admin_approve_prices(order_id: UUID, b: ApprovalIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    res = await rpc("approve_order_prices", {"p_order": str(order_id), "p_actor": ctx["telegram_id"],
                                             "p_prices": [{"order_item_id": str(x.order_item_id), "unit_price": x.unit_price} for x in b.prices]})
    o = await fetch_order(str(order_id))
    await enqueue([{"chat_id": o["telegram_id"], "kind": "order_customer",
                    "text": f"Заказ #{o['number']}: цена по крупному заказу согласована. Итог: {eur(res.get('total'))}."}])
    bg(deliver_pending())
    return res

@app.post("/api/admin/orders/{order_id}/paid")
async def admin_mark_paid(order_id: UUID, ctx=Depends(admin_ctx)):
    return await rpc("mark_order_paid", {"p_order": str(order_id), "p_actor": ctx["telegram_id"]})

# ----------------------------------------------------------------- Админ: взаиморасчёты
class SettlementIn(BaseModel):
    city_id: str = Field(min_length=2, max_length=40)
    amount: float = Field(gt=0, le=1000000)
    note: str = Field("", max_length=200)
    idempotency_key: str = Field(min_length=8, max_length=100)

@app.get("/api/admin/settlement")
async def admin_settlement(city: Optional[str] = None, ctx=Depends(admin_ctx)):
    c = scope_city(ctx, city)
    if c:
        return await rpc("city_settlement", {"p_actor": ctx["telegram_id"], "p_city": c})
    # Владелец без фильтра: все активные города.
    out = []
    for city_row in (await db("GET", "cities", params={"select": "id,name", "active": "eq.true", "order": "sort.asc"}) or []):
        s = await rpc("city_settlement", {"p_actor": ctx["telegram_id"], "p_city": city_row["id"]})
        out.append({**s, "city_name": city_row["name"]})
    return out

@app.post("/api/admin/settlement/transfers")
async def admin_record_transfer(b: SettlementIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    return await rpc("record_cash_transfer", {"p_actor": ctx["telegram_id"], "p_city": b.city_id,
                                              "p_amount": round(b.amount, 2), "p_note": b.note.strip(), "p_key": b.idempotency_key})

# ----------------------------------------------------------------- Админ: товары, категории, цены (владелец)
class ProductIn(BaseModel):
    name: str = Field(min_length=1, max_length=200); description: str = Field("", max_length=2000)
    category_id: int; price: Optional[float] = Field(None, ge=0, le=100000); wholesale_enabled: bool = False
class ProductPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200); description: Optional[str] = Field(None, max_length=2000)
    category_id: Optional[int] = None
    active: Optional[bool] = None; image_path: Optional[str] = Field(None, max_length=300)
class PricesIn(BaseModel):
    price: Optional[float] = Field(None, ge=0, le=100000)
    cost_price: Optional[float] = Field(None, ge=0, le=100000)
class TierRow(BaseModel):
    min: int = Field(ge=1); price: float = Field(ge=0, le=100000)
class TiersIn(BaseModel):
    tiers: list[TierRow] = Field(min_length=1, max_length=20)
class CustomerEditIn(BaseModel):
    items: list[Item] = Field(min_length=1, max_length=100)
    idempotency_key: str = Field(min_length=8, max_length=100)
class ApprovalLine(BaseModel):
    order_item_id: UUID; unit_price: float = Field(ge=0, le=100000)
class ApprovalIn(BaseModel):
    prices: list[ApprovalLine] = Field(min_length=1, max_length=100)
class VariantIn(BaseModel):
    name: str = Field(min_length=1, max_length=200); price: Optional[float] = Field(None, ge=0, le=100000)
class VariantPatch(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=200); price: Optional[float] = Field(None, ge=0, le=100000)
class CategoryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100); sort: int = 0
@app.post("/api/admin/products")
async def admin_create_product(b: ProductIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    return await rpc("admin_create_product", {"p_actor": ctx["telegram_id"], "p_name": b.name.strip(), "p_category": b.category_id,
                                              "p_price": b.price, "p_description": b.description, "p_wholesale": b.wholesale_enabled})

@app.patch("/api/admin/products/{product_id}")
async def admin_update_product(product_id: UUID, b: ProductPatch, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    fields = b.model_fields_set
    if "name" in fields and b.name is None: raise HTTPException(422, "name_required")
    if "category_id" in fields and b.category_id is None: raise HTTPException(422, "category_required")
    body = b.model_dump(exclude_unset=True)
    if not body: raise HTTPException(422, "nothing_to_update")
    if "name" in body: body["name"] = body["name"].strip()
    # Архивирование вместо удаления: active=false.
    return await db("PATCH", "products", prefer="return=representation", params={"id": f"eq.{product_id}"}, json=body)

@app.put("/api/admin/products/{product_id}/prices")
async def admin_set_prices(product_id: UUID, b: PricesIn, ctx=Depends(admin_ctx)):
    """Розничная цена и себестоимость. Только владелец. Каждое изменение пишется в audit_log (RPC)."""
    require_owner(ctx)
    return await rpc("admin_set_product_prices", {"p_actor": ctx["telegram_id"], "p_product": str(product_id),
                                                  "p_price": b.price, "p_cost": b.cost_price})

@app.put("/api/admin/products/{product_id}/tiers")
async def admin_set_tiers(product_id: UUID, b: TiersIn, ctx=Depends(admin_ctx)):
    """Оптовые цены товара по ступеням. Только владелец. Диапазоны ступеней не меняются."""
    require_owner(ctx)
    return await rpc("admin_set_tiers", {"p_actor": ctx["telegram_id"], "p_product": str(product_id),
                                         "p_tiers": [{"min": t.min, "price": t.price} for t in b.tiers]})

@app.post("/api/admin/products/{product_id}/variants")
async def admin_add_variant(product_id: UUID, b: VariantIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    return await rpc("admin_add_variant", {"p_actor": ctx["telegram_id"], "p_product": str(product_id), "p_name": b.name.strip(), "p_price": b.price})

@app.patch("/api/admin/variants/{variant_id}")
async def admin_update_variant(variant_id: UUID, b: VariantPatch, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    fields = b.model_fields_set
    if "name" in fields and b.name is None: raise HTTPException(422, "name_required")
    body = b.model_dump(exclude_unset=True)
    if not body: raise HTTPException(422, "nothing_to_update")
    if "name" in body: body["name"] = body["name"].strip()
    return await db("PATCH", "product_variants", prefer="return=representation", params={"id": f"eq.{variant_id}"}, json=body)

@app.post("/api/admin/categories")
async def admin_create_category(b: CategoryIn, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    rows = await db("POST", "categories", prefer="return=representation", json={"name": b.name.strip(), "sort": b.sort})
    return rows[0] if rows else {}

@app.patch("/api/admin/categories/{category_id}")
async def admin_update_category(category_id: int, b: dict, ctx=Depends(admin_ctx)):
    require_owner(ctx)
    allowed = {k: v for k, v in b.items() if k in ("name", "sort")}
    if not allowed: raise HTTPException(422, "nothing_to_update")
    return await db("PATCH", "categories", prefer="return=representation", params={"id": f"eq.{category_id}"}, json=allowed)

# ----------------------------------------------------------------- Админ: рассылка о наличии (вручную)
def _broadcast_text(city_name: str, mode: str, chosen: list, cat_names: dict) -> str:
    head = f"<b>Новое поступление в {e(city_name)}!</b>\n\n"
    if mode == "new":
        body = "В наличии появились новые товары. Откройте магазин, чтобы посмотреть ассортимент и актуальные остатки."
    elif mode == "categories":
        names = sorted({cat_names.get(p["category_id"], "") for p in chosen} - {""})
        body = "В наличии появились товары в категориях:\n" + "\n".join(f"• {e(n)}" for n in names)
    else:
        lines = [f"• {e(p['name'])}" for p in chosen[:30]]
        if len(chosen) > 30: lines.append(f"… и ещё {len(chosen) - 30}")
        body = "В наличии появились:\n" + "\n".join(lines)
    return head + body + f"\n\nМагазин: {WEBAPP}"

class BroadcastIn(BaseModel):
    city_id: Optional[str] = None
    mode: Literal["products", "categories", "new"]
    product_ids: list[UUID] = Field(default_factory=list, max_length=200)
    category_ids: list[int] = Field(default_factory=list, max_length=50)
    text_hash: str = Field(min_length=64, max_length=64)
    idempotency_key: str = Field(min_length=8, max_length=100)

async def build_broadcast(city_id: str, mode: str, product_ids: list, category_ids: list) -> dict:
    """Текст строится ТОЛЬКО из товаров, которые сейчас есть в городе (get_catalog). Нулевые остатки не попадают."""
    cities = await city_name_map()
    if city_id not in cities: raise HTTPException(400, "bad_city")
    cat = await rpc("get_catalog", {"p_city": city_id, "p_q": ""})
    visible = cat.get("products", [])
    if mode == "products":
        wanted = {str(p) for p in product_ids}
        chosen = [p for p in visible if p["id"] in wanted]
    elif mode == "categories":
        wanted = set(category_ids)
        chosen = [p for p in visible if p["category_id"] in wanted]
    else:  # new: поступления после последней рассылки этого города (или за 7 дней)
        last = await db("GET", "broadcasts", params={"city_id": f"eq.{city_id}", "order": "created_at.desc", "limit": "1", "select": "created_at"})
        since = last[0]["created_at"] if last else (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
        rec = await db("GET", "inventory_transactions", params={"city_id": f"eq.{city_id}", "op": "eq.receipt", "created_at": f"gte.{since}", "select": "inventory_id"}) or []
        rec_ids = {r["inventory_id"] for r in rec}
        chosen = [p for p in visible if any(i["id"] in rec_ids for i in p.get("items", []))]
    if not chosen: raise HTTPException(409, "nothing_to_announce")
    cat_names = {c["id"]: c["name"] for c in cat.get("categories", [])}
    text = _broadcast_text(cities[city_id]["name"], mode, chosen, cat_names)
    return {"text": text, "items": [p["name"] for p in chosen], "product_ids": [p["id"] for p in chosen]}

async def count_recipients(city_id: str) -> int:
    rows = await db("GET", "users", params={"city_id": f"eq.{city_id}", "bot_started_at": "not.is.null",
                                            "notify_stock": "eq.true", "bot_blocked": "eq.false", "select": "telegram_id"}) or []
    return len(rows)

@app.get("/api/admin/broadcast/preview")
async def broadcast_preview(mode: Literal["products", "categories", "new"], city: Optional[str] = None,
                            product_ids: Optional[str] = None, category_ids: Optional[str] = None, ctx=Depends(admin_ctx)):
    c = scope_city(ctx, city)
    if not c: raise HTTPException(400, "city_required")
    pids = [UUID(x) for x in (product_ids or "").split(",") if x]
    cids = [int(x) for x in (category_ids or "").split(",") if x]
    built = await build_broadcast(c, mode, pids, cids)
    return {"city_id": c, "text": built["text"], "items": built["items"],
            "text_hash": hashlib.sha256(built["text"].encode()).hexdigest(), "recipients": await count_recipients(c)}

@app.post("/api/admin/broadcasts")
async def broadcast_send(b: BroadcastIn, ctx=Depends(admin_ctx)):
    c = scope_city(ctx, b.city_id)
    if not c: raise HTTPException(400, "city_required")
    built = await build_broadcast(c, b.mode, [str(x) for x in b.product_ids], b.category_ids)
    # Админ подтверждает ТОТ текст, который видел в предпросмотре. Если каталог изменился — просим обновить.
    if hashlib.sha256(built["text"].encode()).hexdigest() != b.text_hash:
        raise HTTPException(409, "catalog_changed")
    res = await rpc("create_broadcast", {"p_actor": ctx["telegram_id"], "p_city": c, "p_text": built["text"],
                                         "p_product_ids": built["product_ids"], "p_key": b.idempotency_key})
    if not res.get("duplicate"): bg(deliver_pending(limit=1000, broadcast_id=res["id"]))
    return res

@app.get("/api/admin/broadcasts/{broadcast_id}")
async def broadcast_status(broadcast_id: int, ctx=Depends(admin_ctx)):
    rows = await db("GET", "broadcasts", params={"id": f"eq.{broadcast_id}", "select": "id,city_id,created_at,recipients,created_by"})
    if not rows: raise HTTPException(404, "not_found")
    if ctx["role"] != "owner" and rows[0]["city_id"] != ctx["city_id"]: raise HTTPException(404, "not_found")
    out = await db("GET", "outbox", params={"broadcast_id": f"eq.{broadcast_id}", "select": "status,last_error"}) or []
    counts = {"sent": 0, "failed": 0, "pending": 0}
    for r in out: counts[r["status"]] = counts.get(r["status"], 0) + 1
    return {**rows[0], "sent": counts["sent"], "failed": counts["failed"], "pending": counts["pending"]}

# ----------------------------------------------------------------- Экспорт CSV (с учётом города)
def _csv(rows: list, header: list) -> str:
    def cell(v):
        s = "" if v is None else str(v)
        return '"' + s.replace('"', '""') + '"'
    return "\n".join([",".join(header)] + [",".join(cell(r.get(h)) for h in header) for r in rows])

@app.get("/api/admin/export/inventory", response_class=PlainTextResponse)
async def export_inventory(city: Optional[str] = None, ctx=Depends(admin_ctx)):
    c = scope_city(ctx, city)
    if not c: raise HTTPException(400, "city_required")
    rows = await rpc("admin_inventory", {"p_actor": ctx["telegram_id"], "p_city": c}) or []
    return PlainTextResponse(_csv(rows, ["product_name", "variant_name", "city_id", "price", "quantity", "reserved", "available"]), media_type="text/csv")

@app.get("/api/admin/export/orders", response_class=PlainTextResponse)
async def export_orders(city: Optional[str] = None, ctx=Depends(admin_ctx)):
    params = {"select": "number,status,city_id,total,paid_at,paid_amount,refunded_amount,created_at", "order": "created_at.desc", "limit": "5000"}
    c = scope_city(ctx, city)
    if c: params["city_id"] = f"eq.{c}"
    rows = await db("GET", "orders", params=params) or []
    return PlainTextResponse(_csv(rows, ["number", "status", "city_id", "total", "paid_at", "paid_amount", "refunded_amount", "created_at"]), media_type="text/csv")
