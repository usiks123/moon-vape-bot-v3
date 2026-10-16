import os, sys, json, hmac, hashlib, time, asyncio
from types import SimpleNamespace
from urllib.parse import urlencode

os.environ.update(BOT_TOKEN="123456:TESTtokenTESTtokenTESTtoken", SUPABASE_URL="http://sb.local", SUPABASE_SERVICE_ROLE_KEY="svc",
                  WEBAPP_URL="https://app.example.com", OWNER_TELEGRAM_ID="7858672760")
os.environ.pop("RENDER_EXTERNAL_URL", None); os.environ.pop("BACKEND_URL", None)
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
import main

client = TestClient(main.app)  # без `with`: lifespan (webhook, retry loop) не запускается
CUSTOMER = {"id": 555, "first_name": "Ann", "username": "ann"}
OWNER = {"id": 7858672760, "first_name": "Owner"}
HANN_ADMIN = {"id": 7050120446, "first_name": "Hann"}
UID = "11111111-1111-1111-1111-111111111111"
IID = "33333333-3333-3333-3333-333333333333"

def init_data(user=CUSTOMER, auth_date=None, token=None):
    d = {"user": json.dumps(user), "auth_date": str(auth_date or int(time.time())), "query_id": "AAA"}
    chk = "\n".join(f"{k}={v}" for k, v in sorted(d.items()))
    sk = hmac.new(b"WebAppData", (token or main.BOT_TOKEN).encode(), hashlib.sha256).digest()
    d["hash"] = hmac.new(sk, chk.encode(), hashlib.sha256).hexdigest()
    return urlencode(d)

def auth(user=CUSTOMER, **kw): return {"Authorization": "tma " + init_data(user=user, **kw)}

ADMINS = {7858672760: {"telegram_id": 7858672760, "role": "owner", "city_id": None},
          7050120446: {"telegram_id": 7050120446, "role": "city_admin", "city_id": "hannover"}}

@pytest.fixture
def fake(monkeypatch):
    state = {"city": "hannover", "calls": [], "rpc": {}, "age": "2026-01-01T00:00:00+00:00"}
    async def db(method, path, prefer=None, **kw):
        state["calls"].append((method, path, kw.get("params"), kw.get("json")))
        if path.startswith("users"):
            return [{"id": UID, "telegram_id": 555, "first_name": "Ann", "username": "ann", "city_id": state["city"],
                     "age_confirmed_at": state["age"]}]
        if path.startswith("admins"):
            tid = int(kw["params"]["telegram_id"].split(".", 1)[1])
            return [ADMINS[tid]] if tid in ADMINS else []
        return []
    async def rpc(name, args):
        state["calls"].append(("rpc", name, args))
        if name in state["rpc"]:
            v = state["rpc"][name]
            if isinstance(v, Exception): raise v
            return v
        return {"id": "22222222-2222-2222-2222-222222222222", "number": "MOON-20261012-0001", "duplicate": False}
    async def noop(*a, **k): return None
    monkeypatch.setattr(main, "db", db); monkeypatch.setattr(main, "rpc", rpc)
    monkeypatch.setattr(main, "_after_order", noop)
    return state

def rpc_calls(state, name): return [c for c in state["calls"] if c[0] == "rpc" and c[1] == name]

# ---------------------------------------------------------------- авторизация
def test_health(): assert client.get("/health").json() == {"ok": True}

def test_no_auth_rejected():
    assert client.get("/api/orders").status_code == 401
    assert client.get("/api/me").status_code == 401

def test_forged_signature_rejected():
    assert client.get("/api/me", headers={"Authorization": "tma " + init_data(token="999:otherTOKENotherTOKEN")}).status_code == 401

def test_expired_rejected():
    assert client.get("/api/me", headers=auth(auth_date=int(time.time()) - 90000)).status_code == 401

def test_webhook_requires_secret():
    assert client.post("/telegram/webhook", json={}).status_code == 403

def test_check_admin_roles(fake):
    assert client.get("/api/check-admin", headers=auth(OWNER)).json()["role"] == "owner"
    r = client.get("/api/check-admin", headers=auth(HANN_ADMIN)).json()
    assert r == {"isAdmin": True, "role": "city_admin", "city_id": "hannover"}
    assert client.get("/api/check-admin", headers=auth(CUSTOMER)).json()["isAdmin"] is False

def test_customer_cannot_use_admin_endpoints(fake):
    assert client.get("/api/admin/dashboard", headers=auth(CUSTOMER)).status_code == 403

# ---------------------------------------------------------------- город и каталог
def test_catalog_requires_city(fake):
    fake["city"] = None
    assert client.get("/api/catalog", headers=auth()).status_code == 409

def test_catalog_uses_profile_city_not_client_city(fake):
    client.get("/api/catalog?q=elf", headers=auth())
    assert rpc_calls(fake, "get_catalog")[0][2]["p_city"] == "hannover"

def test_order_uses_profile_city(fake):
    r = client.post("/api/orders", headers=auth(), json={"items": [{"inventory_id": IID, "quantity": 2}], "idempotency_key": "12345678",
                                                         "comment": "", "city_id": "muenchen"})
    assert r.status_code == 200
    args = rpc_calls(fake, "create_order")[0][2]
    assert args["p_city"] == "hannover" and args["p_user"] == UID
    assert args["p_contact"] == "@ann" and args["p_key"].endswith(":12345678")
    assert "p_address" not in args and "p_delivery" not in args

def test_order_validation(fake):
    base = {"comment": "", "idempotency_key": "12345678"}
    assert client.post("/api/orders", headers=auth(), json={**base, "items": []}).status_code == 422
    assert client.post("/api/orders", headers=auth(), json={**base, "items": [{"inventory_id": IID, "quantity": 0}]}).status_code == 422
    assert client.post("/api/orders", headers=auth(), json={**base, "items": [{"inventory_id": "x", "quantity": 1}]}).status_code == 422

def test_city_change_rejects_unknown_city(fake):
    # В тестовой БД-заглушке нет таблицы cities → любой город неизвестен → 400
    assert client.put("/api/me/city", headers=auth(), json={"city_id": "nowhere"}).status_code == 400

def test_city_change_writes_profile_not_client_side(fake, monkeypatch):
    async def cities(): return {"hannover": {"id": "hannover", "name": "Hannover", "active": True}}
    monkeypatch.setattr(main, "city_name_map", cities)
    assert client.put("/api/me/city", headers=auth(), json={"city_id": "hannover"}).status_code == 200
    patch = [c for c in fake["calls"] if c[0] == "PATCH" and c[1] == "users"]
    assert patch and patch[0][3]["city_id"] == "hannover"

def test_cart_saved(fake):
    assert client.put("/api/cart", headers=auth(), json={"items": [{"inventory_id": IID, "quantity": 3}]}).status_code == 200
    assert rpc_calls(fake, "save_cart")[0][2]["p_items"] == [{"inventory_id": IID, "quantity": 3}]

# ---------------------------------------------------------------- роли и область видимости
def test_city_admin_cannot_read_other_city(fake):
    r = client.get("/api/admin/inventory?city=muenchen", headers=auth(HANN_ADMIN))
    assert r.status_code == 403

def test_city_admin_is_forced_to_own_city(fake):
    client.get("/api/admin/inventory", headers=auth(HANN_ADMIN))
    assert rpc_calls(fake, "admin_inventory")[0][2] == {"p_actor": 7050120446, "p_city": "hannover"}

def test_owner_must_choose_city_for_inventory(fake):
    assert client.get("/api/admin/inventory", headers=auth(OWNER)).status_code == 400

def test_transfer_is_owner_only(fake):
    body = {"from_inventory_id": IID, "to_inventory_id": "44444444-4444-4444-4444-444444444444", "quantity": 1}
    assert client.post("/api/admin/transfers", headers=auth(HANN_ADMIN), json=body).status_code == 403
    assert not rpc_calls(fake, "admin_transfer_stock")

def test_transfer_chooses_bigint_actor(fake):
    body = {"from_inventory_id": IID, "to_inventory_id": "44444444-4444-4444-4444-444444444444", "quantity": 1}
    client.post("/api/admin/transfers", headers=auth(OWNER), json=body)
    assert rpc_calls(fake, "admin_transfer_stock")[0][2]["p_actor"] == 7858672760

def test_settlement_transfer_is_owner_only(fake):
    body = {"city_id": "hannover", "amount": 10, "note": "x", "idempotency_key": "tr-000001"}
    assert client.post("/api/admin/settlement/transfers", headers=auth(HANN_ADMIN), json=body).status_code == 403
    assert client.post("/api/admin/settlement/transfers", headers=auth(OWNER), json=body).status_code == 200
    assert rpc_calls(fake, "record_cash_transfer")[0][2]["p_amount"] == 10.0

def test_city_admin_settlement_is_own_city_only(fake):
    assert client.get("/api/admin/settlement?city=muenchen", headers=auth(HANN_ADMIN)).status_code == 403

def test_order_status_error_mapped_to_403(fake):
    fake["rpc"]["change_order_status"] = HTTPException(403, "forbidden")
    r = client.patch("/api/admin/orders/44444444-4444-4444-4444-444444444444", headers=auth(HANN_ADMIN), json={"status": "issued"})
    assert r.status_code == 403

def test_bad_status_value_rejected(fake):
    r = client.patch("/api/admin/orders/44444444-4444-4444-4444-444444444444", headers=auth(OWNER), json={"status": "new"})
    assert r.status_code == 422

def test_admin_setup_endpoint_removed():
    assert client.post("/api/admin/setup?telegram_id=1").status_code in (404, 405)

# ---------------------------------------------------------------- Telegram-бот и уведомления
def test_bot_callback_forbidden_for_non_admin(fake):
    answers = []
    async def answer(text=None, show_alert=False): answers.append((text, show_alert))
    fake["rpc"]["change_order_status"] = HTTPException(403, "forbidden")
    c = SimpleNamespace(from_user=SimpleNamespace(id=123), data="st:44444444-4444-4444-4444-444444444444:issued", answer=answer)
    asyncio.run(main.on_status(c))
    assert answers == [("Нет доступа", True)]

def test_order_text_city_is_first_line():
    o = {"number": "MOON-1", "telegram_id": 1, "status": "new", "total": 45, "paid_at": None, "cities": {"name": "Hannover"},
         "users": {"first_name": "A", "last_name": None, "username": "u"},
         "order_items": [{"product_name": "XROS 5", "variant_name": "Black", "quantity": 1, "is_wholesale": False}]}
    lines = main.order_text(o).splitlines()
    assert lines[0] == "📍 <b>HANNOVER</b>"
    assert "45,00 €" in main.order_text(o) and "не оплачен" in main.order_text(o)

def test_order_text_escapes_html():
    o = {"number": "MOON-1", "telegram_id": 1, "status": "new", "total": 10, "paid_at": None, "cities": {"name": "München"},
         "users": {"first_name": "<i>A</i>", "last_name": None, "username": None},
         "order_items": [{"product_name": "<b>P</b>", "variant_name": None, "quantity": 2, "is_wholesale": True}]}
    t = main.order_text(o)
    assert "<i>A</i>" not in t and "&lt;i&gt;A&lt;/i&gt;" in t and "&lt;b&gt;P&lt;/b&gt;" in t
    assert t.splitlines()[0] == "📍 <b>MÜNCHEN</b>"

def test_order_keyboard_matches_status():
    o = {"id": "44444444-4444-4444-4444-444444444444", "status": "new", "paid_at": None}
    cbs = [b.callback_data for row in main.order_kb(o).inline_keyboard for b in row]
    assert "st:44444444-4444-4444-4444-444444444444:prepared" in cbs and not any(c.startswith("pd:") for c in cbs)
    assert main.order_kb({"id": "x", "status": "cancelled", "paid_at": None}) is None

def test_deliver_claims_row_before_sending(fake, monkeypatch):
    sent = []
    async def send(chat, text, reply_markup=None): sent.append((chat, text))
    monkeypatch.setattr(main, "bot", SimpleNamespace(send_message=send))
    async def db2(method, path, prefer=None, **kw):
        fake["calls"].append((method, path, kw.get("params"), kw.get("json")))
        if method == "PATCH" and path == "outbox" and "lte." in str(kw.get("params", {}).get("next_attempt_at", "")):
            return []  # строку уже забрал другой процесс
        return []
    monkeypatch.setattr(main, "db", db2)
    asyncio.run(main.deliver_one({"id": 7, "kind": "order_customer", "text": "hi", "chat_id": 555, "attempts": 0}))
    assert sent == []  # повторной отправки не будет

def test_deliver_sends_and_marks_sent(fake, monkeypatch):
    sent = []
    async def send(chat, text, reply_markup=None): sent.append((chat, text))
    monkeypatch.setattr(main, "bot", SimpleNamespace(send_message=send))
    asyncio.run(main.deliver_one({"id": 8, "kind": "order_customer", "text": "hi", "chat_id": 555, "attempts": 0}))
    assert sent == [(555, "hi")]
    assert any(c[0] == "PATCH" and c[3] and c[3].get("status") == "sent" for c in fake["calls"])

def test_broadcast_hash_mismatch_rejected(fake, monkeypatch):
    async def build(city, mode, pids, cids): return {"text": "new text", "items": ["a"], "product_ids": []}
    monkeypatch.setattr(main, "build_broadcast", build)
    body = {"mode": "new", "city_id": "hannover", "text_hash": "0" * 64, "idempotency_key": "bc-000001"}
    assert client.post("/api/admin/broadcasts", headers=auth(OWNER), json=body).status_code == 409
    assert not rpc_calls(fake, "create_broadcast")

def test_no_catalog_filter_in_python(fake):
    # Фильтрация по наличию выполняется в БД (get_catalog). Python не должен переписывать ответ.
    fake["rpc"]["get_catalog"] = {"city": "hannover", "categories": [], "products": [{"id": "p", "items": []}], "wholesale": []}
    out = client.get("/api/catalog", headers=auth()).json()
    assert out["products"] == [{"id": "p", "items": []}]

def test_owner_text_has_no_address_fields():
    o = {"number": "MOON-1", "telegram_id": 1, "status": "new", "total": 1, "paid_at": None, "cities": {"name": "Hannover"},
         "users": {}, "order_items": []}
    assert "Адрес" not in main.order_text(o) and "Доставка" not in main.order_text(o)


def test_rpc_returns_full_array_results(monkeypatch):
    # get_cart / admin_inventory возвращают jsonb-массив: нельзя отрезать его до первого элемента
    async def db(method, path, prefer=None, **kw): return [{"inventory_id": "a"}, {"inventory_id": "b"}]
    monkeypatch.setattr(main, "db", db)
    assert asyncio.run(main.rpc("get_cart", {"p_user": "x"})) == [{"inventory_id": "a"}, {"inventory_id": "b"}]

# ---------------------------------------------------------------- v3: цены, ступени, редактирование, согласование
def test_hannover_cannot_set_prices_or_tiers(fake):
    pid = "55555555-5555-5555-5555-555555555555"
    assert client.put(f"/api/admin/products/{pid}/prices", headers=auth(HANN_ADMIN), json={"price": 1}).status_code == 403
    assert client.put(f"/api/admin/products/{pid}/tiers", headers=auth(HANN_ADMIN), json={"tiers": [{"min": 3, "price": 1}]}).status_code == 403
    assert not rpc_calls(fake, "admin_set_product_prices")
    assert not rpc_calls(fake, "admin_set_tiers")

def test_owner_price_change_goes_through_audited_rpc(fake):
    pid = "55555555-5555-5555-5555-555555555555"
    r = client.put(f"/api/admin/products/{pid}/prices", headers=auth(OWNER), json={"price": 15, "cost_price": 3.4})
    assert r.status_code == 200
    assert rpc_calls(fake, "admin_set_product_prices")[0][2]["p_cost"] == 3.4

def test_product_patch_cannot_change_price(fake):
    pid = "55555555-5555-5555-5555-555555555555"
    r = client.patch(f"/api/admin/products/{pid}", headers=auth(OWNER), json={"price": 0.01})
    assert r.status_code == 422  # поле price удалено из PATCH: цена меняется только через аудируемый эндпоинт

def test_approval_is_owner_only(fake):
    oid = "44444444-4444-4444-4444-444444444444"
    body = {"prices": [{"order_item_id": "66666666-6666-6666-6666-666666666666", "unit_price": 12}]}
    assert client.post(f"/api/admin/orders/{oid}/approve", headers=auth(HANN_ADMIN), json=body).status_code == 403
    assert not rpc_calls(fake, "approve_order_prices")

def test_customer_edit_passes_owner_uuid_and_key(fake):
    oid = "44444444-4444-4444-4444-444444444444"
    body = {"items": [{"inventory_id": IID, "quantity": 9}], "idempotency_key": "edit-000001"}
    client.post(f"/api/orders/{oid}/edit", headers=auth(), json=body)
    args = rpc_calls(fake, "customer_edit_order")[0][2]
    assert args["p_user"] == UID and args["p_order"] == oid
    assert args["p_key"].endswith(":edit-000001")

def test_customer_edit_rejects_empty_items(fake):
    oid = "44444444-4444-4444-4444-444444444444"
    assert client.post(f"/api/orders/{oid}/edit", headers=auth(), json={"items": [], "idempotency_key": "edit-000002"}).status_code == 422

def test_pricing_preview_uses_profile_city(fake):
    client.post("/api/pricing/preview", headers=auth(), json={"items": [{"inventory_id": IID, "quantity": 3}]})
    assert rpc_calls(fake, "pricing_preview")[0][2]["p_city"] == "hannover"

def test_order_selects_never_expose_unit_cost():
    assert "unit_cost" not in main.ORDER_SELECT and "unit_cost" not in main.ORDER_FIELDS

def test_order_edit_forbidden_error_is_not_leaked(fake):
    # чужой/несуществующий заказ — RPC вернёт order_not_found → 404 без деталей
    fake["rpc"]["customer_edit_order"] = HTTPException(404, "order_not_found")
    oid = "44444444-4444-4444-4444-444444444444"
    r = client.post(f"/api/orders/{oid}/edit", headers=auth(), json={"items": [{"inventory_id": IID, "quantity": 1}], "idempotency_key": "edit-000003"})
    assert r.status_code == 404


# ---------------------------------------------------------------- возраст 18+ и город по умолчанию
def test_catalog_blocked_until_age_confirmed(fake):
    fake["age"] = None
    r = client.get("/api/catalog", headers=auth())
    assert r.status_code == 403 and r.json()["detail"] == "age_required"
    assert rpc_calls(fake, "get_catalog") == []

def test_order_blocked_until_age_confirmed(fake):
    fake["age"] = None
    body = {"items": [{"inventory_id": IID, "quantity": 1}], "comment": "", "idempotency_key": "age-000001"}
    assert client.post("/api/orders", headers=auth(), json=body).status_code == 403
    assert rpc_calls(fake, "create_order") == []

def test_age_confirm_is_written_once(fake):
    assert client.post("/api/me/age-confirm", headers=auth()).status_code == 200
    patch = [c for c in fake["calls"] if c[0] == "PATCH" and c[1].startswith("users")]
    assert patch and patch[-1][2] == {"id": f"eq.{UID}", "age_confirmed_at": "is.null"}

def test_first_visit_gets_default_city_without_prompt(fake, monkeypatch):
    fake["city"] = None
    async def cities():
        return {"muenchen": {"id": "muenchen", "name": "München", "active": True, "sort": 1},
                "hannover": {"id": "hannover", "name": "Hannover", "active": True, "sort": 2}}
    monkeypatch.setattr(main, "city_name_map", cities)
    r = client.get("/api/me", headers=auth()).json()
    assert r["city"] == {"id": "muenchen", "name": "München"}
    patch = [c for c in fake["calls"] if c[0] == "PATCH" and c[1].startswith("users")]
    assert patch and patch[0][3]["city_id"] == "muenchen"
