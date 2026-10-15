'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { API, ERR, ST, eur, haptic, tg, variantLabel } from '@/lib/shared'
import {
  BottomNav, CategoryBar, Confirm, Empty, Header, Icon, Loading, Moon, Pic, Price, ProductCard, Qty, Sheet, StatusBadge, Toast,
} from '../ui'

async function api(path: string, opt: any = {}) {
  const r = await fetch(API + path, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + tg().initData } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(ERR[j.detail] || j.detail || 'Ошибка сети')
  return j
}

// Текст из ТЗ, раздел 3 — показываем при первом входе, пока город не выбран.
const CITY_PROMPT = 'Выберите город, в котором вы хотите посмотреть доступные товары. Изменить город можно будет в любой момент в профиле или на странице товара.'
const FLOW = ['new', 'prepared', 'issued']
const FLOW_LABEL: Record<string, string> = { new: 'Создан', prepared: 'Подготовлен', issued: 'Выдан' }

// Строки корзины: позиции другого города сохраняются (не переносятся молча), текущего — только если есть в наличии.
function keepLines(c: any, qty: Record<string, number>, meta: Record<string, string>, cityId: string) {
  const visible = new Set<string>(); c.products.forEach((p: any) => p.items.forEach((i: any) => visible.add(i.id)))
  return Object.fromEntries(Object.entries(qty).filter(([id, n]) => n > 0 && (meta[id] !== cityId || visible.has(id)))) as Record<string, number>
}

export default function CustomerApp() {
  const [ready, setReady] = useState(false), [tab, setTab] = useState('catalog'), [err, setErr] = useState('')
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [me, setMe] = useState<any>(null), [all, setAll] = useState<any>(null), [shown, setShown] = useState<any[]>([])
  const [q, setQ] = useState(''), [cat, setCat] = useState(0), [sheet, setSheet] = useState<any>(null)
  const [cart, setCart] = useState<Record<string, number>>({}), [cartCity, setCartCity] = useState<Record<string, string>>({})
  const [orders, setOrders] = useState<any[] | null>(null), [order, setOrder] = useState<any>(null)
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false), [confirmCity, setConfirmCity] = useState<any>(null)
  const [cityPicker, setCityPicker] = useState(false), [confirmForeign, setConfirmForeign] = useState(false)
  const hydrated = useRef(false)
  const [editing, setEditing] = useState(false)

  const fail = (m: string) => { setToast({ kind: 'err', text: m }); haptic('error') }
  const done = (m: string) => setToast({ kind: 'ok', text: m })
  const city = me?.city || null

  // Загрузка каталога и корзины для выбранного города. Город берётся из профиля на сервере.
  async function refresh(m: any) {
    if (!m?.city) return
    const [c, sc] = await Promise.all([api('/api/catalog'), api('/api/cart').catch(() => [])])
    const qty: Record<string, number> = {}, meta: Record<string, string> = {}
    ;(sc || []).forEach((r: any) => { qty[r.inventory_id] = r.quantity; meta[r.inventory_id] = r.city_id })
    setAll(c); setShown(c.products); setCartCity(meta); setCart(keepLines(c, qty, meta, m.city.id))
    hydrated.current = true
  }

  useEffect(() => {
    const w = tg(); if (!w?.initData) { setErr('Откройте приложение из Telegram'); return }
    w.ready(); w.expand(); w.setHeaderColor?.('#08080c'); w.setBackgroundColor?.('#08080c')
    api('/api/me').then(async m => { setMe(m); await refresh(m); setReady(true) }).catch(e => setErr(e.message))
  }, [])

  // Сохранение корзины на сервере (не только localStorage). Отправляем все строки, включая позиции другого города.
  useEffect(() => {
    if (!hydrated.current) return
    const t = setTimeout(() => {
      api('/api/cart', { method: 'PUT', body: JSON.stringify({ items: Object.entries(cart).map(([inventory_id, quantity]) => ({ inventory_id, quantity })) }) }).catch(() => {})
    }, 600)
    return () => clearTimeout(t)
  }, [cart])

  useEffect(() => {
    if (!ready || !city) return
    const t = setTimeout(() => api('/api/catalog' + (q.trim() ? '?q=' + encodeURIComponent(q.trim()) : '')).then(c => setShown(c.products)).catch(e => fail(e.message)), 250)
    return () => clearTimeout(t)
  }, [q, ready, city?.id])

  useEffect(() => { if (tab === 'profile' && ready && city) api('/api/orders').then(setOrders).catch(e => { setOrders([]); fail(e.message) }) }, [tab, ready])

  const idx = useMemo(() => { const m = new Map<string, any>(); all?.products.forEach((p: any) => p.items.forEach((i: any) => m.set(i.id, { p, item: i }))); return m }, [all])
  const lines = useMemo(() => Object.entries(cart).map(([id, qty]) => { const x = idx.get(id); return x && { ...x, qty: Math.min(qty, x.item.available) } }).filter((l: any) => l && l.qty > 0) as any[], [cart, idx])
  const foreign = useMemo(() => Object.keys(cart).filter(id => city && cartCity[id] && cartCity[id] !== city.id), [cart, cartCity, city?.id])
  const count = lines.reduce((s, l) => s + l.qty, 0)
  // Цены и ступень считает сервер (единая логика с оформлением заказа). Клиент цены не вычисляет.
  const [pv, setPv] = useState<any>(null), [pvErr, setPvErr] = useState('')
  const linesKey = lines.map(l => l.item.id + ':' + l.qty).join('|')
  useEffect(() => {
    if (!ready || !city || !lines.length) { setPv(null); return }
    const t = setTimeout(() => api('/api/pricing/preview', { method: 'POST', body: JSON.stringify({ items: lines.map(l => ({ inventory_id: l.item.id, quantity: l.qty })) }) })
      .then(p => { setPv(p); setPvErr('') }).catch(e => { setPv(null); setPvErr(e.message) }), 250)
    return () => clearTimeout(t)
  }, [linesKey, ready, city?.id])
  const pvLine = (id: string) => pv?.lines?.find((x: any) => x.inventory_id === id)
  const unit = (l: any) => pvLine(l.item.id)?.unit_price ?? null
  const total = pv?.total ?? 0
  const discount = pv?.discount ?? 0
  const tierLabel: string | null = pv?.tier_label ?? null
  const manager = !!pv?.approval_required
  const setQty = (id: string, n: number) => setCart(c => { const x = idx.get(id), v = Math.max(0, Math.min(n, x?.item.available ?? 0)); const nc = { ...c }; v ? (nc[id] = v) : delete nc[id]; return nc })
  const pop = (shown || []).filter(p => p.sold > 0).sort((a, b) => b.sold - a.sold).slice(0, 6)
  const list = shown.filter(p => !cat || p.category_id === cat)
  const catName = cat ? all?.categories.find((c: any) => c.id === cat)?.name : null

  async function changeCity(id: string) {
    try {
      await api('/api/me/city', { method: 'PUT', body: JSON.stringify({ city_id: id }) })
      const m = await api('/api/me'); setMe(m); await refresh(m)
      setCityPicker(false); setConfirmCity(null); setSheet(null)
      setToast({ kind: 'ok', text: `Город: ${m.city?.name}` })
    } catch (e: any) { fail(e.message) }
  }
  const requestCity = (id: string) => {
    if (id === city?.id) return setCityPicker(false)
    // Корзина не переносится на другой склад автоматически — предупреждаем.
    if (Object.keys(cart).length > 0) return setConfirmCity(id)
    changeCity(id)
  }

  async function submit() {
    if (busy || !city) return; setBusy(true)
    const k = key || crypto.randomUUID(); setKey(k)
    try {
      const r = await api('/api/orders', { method: 'POST', body: JSON.stringify({ comment: '', idempotency_key: k, items: lines.map(l => ({ inventory_id: l.item.id, quantity: l.qty })) }) })
      setKey(''); haptic('success')
      await refresh(me)
      setOrder(await api('/api/orders/' + r.id)); setTab('order')
      setToast({ kind: 'ok', text: 'Заказ успешно оформлен' })
    } catch (e: any) { fail(e.message); await refresh(me).catch(() => {}) } finally { setBusy(false) }
  }

  const open = async (id: string) => { try { setOrder(await api('/api/orders/' + id)); setTab('order') } catch (e: any) { fail(e.message) } }
  const go = (k: string) => { setTab(k); window.scrollTo({ top: 0 }) }
  const openProduct = async (p: any) => {
    try { const c = await api('/api/catalog'); setAll(c); const fresh = c.products.find((x: any) => x.id === p.id); if (!fresh) return fail('Товар больше недоступен'); setSheet(fresh) }
    catch (e: any) { fail(e.message) }
  }

  if (err && !ready) return <div className="mv-app"><div className="mv-center"><Moon s={56} />{err}</div></div>
  if (!ready) return <div className="mv-app"><Loading /></div>

  // Первый вход: город не выбран — показываем выбор до каталога.
  if (!city) return (<div className="mv-app">
    {toast && <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} />}
    <div className="mv-page"><Header />
      <h1 className="mv-h1">Выбор города</h1>
      <div className="mv-card mv-col" style={{ gap: 12, marginTop: 12 }}><p style={{ margin: 0, lineHeight: 1.5 }}>{CITY_PROMPT}</p>
        {(me?.cities || []).map((c: any) => <button key={c.id} className="mv-btn" onClick={() => changeCity(c.id)}>{c.name}</button>)}
        {!(me?.cities || []).length && <div className="mv-sub">Города пока не настроены</div>}
      </div>
    </div>
  </div>)

  const Line = ({ l }: any) => (
    <div className="mv-row">
      <Pic p={l.p} style={{ width: 56, height: 56, borderRadius: 14, flexShrink: 0 }} />
      <div className="mv-grow"><div style={{ fontWeight: 800 }} className="mv-trunc">{l.p.name}</div><div className="mv-sub mv-trunc">{variantLabel(l.item) || 'Стандарт'}</div></div>
      <div style={{ fontSize: 13, textAlign: 'right' }}>{l.qty} × {unit(l) == null ? '—' : eur(unit(l))}</div>
    </div>
  )

  const user = me?.user || {}
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || 'Покупатель'
  const active = (orders || []).filter(o => ['new', 'prepared'].includes(o.status))
  const history = (orders || []).filter(o => ['issued', 'cancelled'].includes(o.status))
  const orderCard = (o: any) => (
    <button key={o.id} className="mv-card tap mv-row mv-between" onClick={() => open(o.id)}>
      <div className="mv-grow"><div style={{ fontWeight: 800 }}>#{o.number}</div><div className="mv-sub">{o.cities?.name || 'Город не указан'} · {new Date(o.created_at).toLocaleString('ru-RU')}</div></div>
      <div style={{ textAlign: 'right' }}><div style={{ fontWeight: 800, marginBottom: 6 }}>{eur(+o.total)}</div><StatusBadge status={o.status} /></div>
    </button>
  )
  const managerLink: string | null = me?.manager_link || null

  return (<div className="mv-app">
    {toast && <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} />}

    {tab === 'catalog' && <div className="mv-page" key="catalog">
      <Header onProfile={() => go('profile')} />
      <div className="mv-city-line"><span className="mv-city">{city.name}</span><span className="mv-sub">Вы просматриваете наличие в {city.name}</span>
        <button className="mv-link" onClick={() => setCityPicker(true)}>Сменить</button></div>
      <h1 className="mv-h1">Добро пожаловать</h1>
      <div className="mv-sub" style={{ marginBottom: 16 }}>Выберите категорию и найдите нужный товар</div>
      <input type="text" placeholder="Поиск товара…" value={q} onChange={e => setQ(e.target.value)} className="mv-input" />
      {!q && !cat && <div className="mv-banner" style={{ marginTop: 16 }}><h3>MoonVape</h3><p>Выберите категорию, найдите нужный товар и добавьте его в корзину.</p><Moon s={120} /></div>}
      <h2 className="mv-h2">Категории</h2>
      <CategoryBar cats={all?.categories || []} value={cat} onChange={setCat} />
      {!q && !cat && pop.length > 0 && <><h2 className="mv-h2">Популярное</h2><div className="mv-products">{pop.map(p => <ProductCard key={'pop' + p.id} p={p} onOpen={() => openProduct(p)} />)}</div></>}
      {list.length > 0 && <><h2 className="mv-h2">{catName || (q ? `Найдено: ${list.length}` : 'Все товары')}</h2><div className="mv-products">{list.map(p => <ProductCard key={p.id} p={p} onOpen={() => openProduct(p)} />)}</div></>}
      {!list.length && <Empty icon={Icon.search(30)} title="Ничего не найдено" text={`Сейчас в ${city.name} нет доступных товаров по этому запросу`} />}
    </div>}

    {tab === 'cart' && <div className="mv-page" key="cart">
      <Header onProfile={() => go('profile')} />
      <div className="mv-row mv-between"><h1 className="mv-h1" style={{ margin: '8px 0' }}>Корзина</h1>{Object.keys(cart).length > 0 && <button className="mv-link" onClick={() => setConfirmClear(true)}>Очистить</button>}</div>
      <div className="mv-sub" style={{ marginBottom: 10 }}>Склад: {city.name}</div>
      {foreign.length > 0 && <div className="mv-card mv-col" style={{ gap: 8, marginBottom: 12, borderColor: 'rgba(245,166,74,.4)' }}>
        <b>Позиции из другого города: {foreign.length}</b>
        <div className="mv-sub">Они не переносятся в {city.name} и не будут оформлены. Чтобы их оформить, выберите город, где они есть.</div>
        <button className="mv-btn ghost sm" onClick={() => setConfirmForeign(true)}>Удалить их из корзины</button></div>}
      {!lines.length && <Empty icon={Icon.cart(30)} title="Корзина пуста" text={`Добавьте товары, которые есть в ${city.name}`} />}
      {lines.length > 0 && <>
        <div className="mv-col">{lines.map(l => <div key={l.item.id} className="mv-card" style={{ padding: 12 }}><Line l={l} /><div className="mv-divider" />
          <div className="mv-row mv-between"><Qty n={l.qty} onMinus={() => setQty(l.item.id, l.qty - 1)} onPlus={() => setQty(l.item.id, l.qty + 1)} maxed={l.qty >= l.item.available} />
            <div className="mv-row"><button className="mv-link mv-danger" aria-label="Удалить" onClick={() => setQty(l.item.id, 0)}>{Icon.trash(18)}</button><b>{unit(l) == null ? '—' : eur(unit(l) * l.qty)}</b></div></div></div>)}</div>
        <div className="mv-card" style={{ marginTop: 14 }}>
          {tierLabel && <div className="mv-sub" style={{ marginBottom: 10 }}>{manager ? 'Крупный заказ (50+ шт.): цену назначит менеджер, итог появится после согласования.' : `Ступень ${tierLabel} — для всех позиций заказа`}</div>}
          {pvErr && <div className="mv-sub mv-danger" style={{ marginBottom: 10 }}>{pvErr}</div>}
          <div className="mv-row mv-between mv-sub"><span>Товаров</span><span>{count} шт.</span></div>
          {discount > 0 && <div className="mv-row mv-between mv-success" style={{ marginTop: 8, fontSize: 14 }}><span>Скидка</span><span>−{eur(discount)}</span></div>}
          <div className="mv-row mv-between" style={{ margin: '10px 0 16px' }}><span style={{ fontSize: 22, fontWeight: 800 }}>Итого</span>{manager ? <span className="mv-price lg">—</span> : <Price v={total} lg />}</div>
          <button className="mv-btn" disabled={manager || busy} onClick={submit}>{manager ? 'Свяжитесь с менеджером' : busy ? 'Оформляем…' : `Оформить заказ · ${city.name}`}</button>
        </div></>}
    </div>}

    {tab === 'profile' && <div className="mv-page" key="profile">
      <Header />
      <div className="mv-card mv-row" style={{ padding: 18 }}>
        {user.photo_url ? <img src={user.photo_url} alt="" style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }} /> : <div className="mv-iconbtn" style={{ width: 64, height: 64, borderRadius: '50%' }}>{Icon.user(30)}</div>}
        <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 18 }} className="mv-trunc">{fullName}</div><div className="mv-sub mv-trunc">{user.username ? '@' + user.username : 'Покупатель MoonVape'}</div></div>
      </div>
      <div className="mv-card mv-row mv-between" style={{ marginTop: 12 }}>
        <div><div className="mv-sub">Город</div><b>{city.name}</b></div>
        <button className="mv-btn ghost sm" onClick={() => setCityPicker(true)}>Сменить город</button>
      </div>
      <ReferralCard fail={fail} done={done} />
      {orders === null && <Loading />}
      {orders && <>
        <h2 className="mv-h2">Активные заказы</h2>
        {!active.length && <div className="mv-card mv-sub">Нет активных заказов</div>}
        <div className="mv-col">{active.map(o => { const si = FLOW.indexOf(o.status); return (
          <button key={o.id} className="mv-card tap" style={{ borderColor: 'rgba(90,169,255,.4)', boxShadow: 'var(--shadow-glow)' }} onClick={() => open(o.id)}>
            <div className="mv-row mv-between"><div><div style={{ fontWeight: 800 }}>#{o.number}</div><div className="mv-sub">{o.cities?.name || ''} · {new Date(o.created_at).toLocaleString('ru-RU')}</div></div><Price v={+o.total} /></div>
            <div className="mv-row" style={{ gap: 6, margin: '14px 0 8px' }}>{FLOW.map((s, i) => <div key={s} style={{ flex: 1, height: 4, borderRadius: 2, background: i <= si ? 'var(--accent)' : 'var(--surface-3)', transition: 'background .3s' }} />)}</div>
            <div className="mv-row mv-between"><StatusBadge status={o.status} /><span className="mv-sub">Этап: {FLOW_LABEL[o.status]}</span></div>
          </button>) })}</div>
        <h2 className="mv-h2">История заказов</h2>
        {!history.length && <Empty icon={Icon.list(30)} title="У вас пока нет завершённых заказов" text="Выданные и отменённые заказы появятся здесь" />}
        <div className="mv-col">{history.map(orderCard)}</div>
      </>}
    </div>}

    {tab === 'order' && order && <div className="mv-page" key="order">
      <Header left={<button className="mv-iconbtn" aria-label="Назад" onClick={() => go('profile')}>{Icon.back(20)}</button>} onProfile={undefined} />
      <div className="mv-row mv-between" style={{ margin: '4px 0 14px' }}><h1 className="mv-h1" style={{ margin: 0 }}>#{order.number}</h1><StatusBadge status={order.status} /></div>
      <div className="mv-sub" style={{ marginBottom: 12 }}>{new Date(order.created_at).toLocaleString('ru-RU')}</div>
      <div className="mv-card mv-col">{order.order_items.map((i: any) => <div key={i.id} className="mv-row"><Pic p={i.products} style={{ width: 56, height: 56, borderRadius: 14, flexShrink: 0 }} />
        <div className="mv-grow"><div style={{ fontWeight: 800 }} className="mv-trunc">{i.product_name}</div><div className="mv-sub mv-trunc">{[i.variant_name, i.flavor_name].filter(Boolean).join(' · ')}{i.is_wholesale ? ' · опт' : ''}</div></div><div style={{ fontSize: 13 }}>{i.quantity} × {eur(+i.unit_price)}</div></div>)}
        {(() => { const d = order.order_items.reduce((s: number, i: any) => s + (+i.base_price - +i.unit_price) * i.quantity, 0); return d > 0 && <div className="mv-row mv-between mv-success" style={{ fontSize: 14 }}><span>Оптовая скидка</span><span>−{eur(d)}</span></div> })()}
        <div className="mv-divider" style={{ margin: 0 }} /><div className="mv-row mv-between"><b style={{ fontSize: 20 }}>Итого</b><Price v={+order.total} lg /></div></div>
      <div className="mv-card mv-col" style={{ gap: 8, fontSize: 14, marginTop: 12 }}>
        {([['Город', order.cities?.name], ['Ступень', order.tier_label], ['Согласование', order.approval_required ? 'требуется: итог назначит менеджер' : null], ['Оплата', order.paid_at ? 'принята' : 'ожидает подтверждения менеджером'], ['Комментарий', order.comment]] as const).filter(([, v]) => v && v !== '—').map(([l, v]) =>
          <div key={l} className="mv-row mv-between" style={{ alignItems: 'flex-start' }}><span className="mv-muted">{l}</span><span style={{ textAlign: 'right', maxWidth: '65%', overflowWrap: 'anywhere' }}>{v}</span></div>)}
      </div>
      {order.editable && <button className="mv-btn ghost" style={{ marginTop: 12 }} onClick={() => setEditing(true)}>Изменить заказ</button>}
      <button className="mv-btn" style={{ marginTop: 16 }} disabled={!managerLink} onClick={() => managerLink && (managerLink.startsWith('https://t.me') ? tg().openTelegramLink(managerLink) : tg().openLink(managerLink))}>
        {Icon.chat(18)}{managerLink ? `Написать менеджеру · ${city.name}` : 'Контакт менеджера не настроен'}</button>
    </div>}

    {sheet && <ProductSheet p={sheet} cityName={city.name} cart={cart} onChangeCity={() => { setSheet(null); setCityPicker(true) }} onClose={() => setSheet(null)}
      onAdd={(id: string, n: number) => { setQty(id, (cart[id] || 0) + n); setCartCity(m => ({ ...m, [id]: city.id })); setSheet(null); haptic('light'); setToast({ kind: 'ok', text: 'Добавлено в корзину' }) }} />}
    {editing && order && <OrderEditor order={order} catalog={all} onClose={() => setEditing(false)}
      onSaved={async (fresh: any) => { setOrder(fresh); setEditing(false); setToast({ kind: 'ok', text: 'Заказ обновлён' }); try { await refresh(me) } catch {} }} />}
    {cityPicker && <Sheet onClose={() => setCityPicker(false)}>
      <h3 style={{ margin: '16px 0 6px', fontWeight: 800 }}>Город</h3>
      <p className="mv-sub" style={{ margin: '0 0 12px' }}>{CITY_PROMPT}</p>
      <div className="mv-col">{(me?.cities || []).map((c: any) => <button key={c.id} className={'mv-card tap mv-row mv-between' + (c.id === city.id ? ' on' : '')} onClick={() => requestCity(c.id)}><b>{c.name}</b>{c.id === city.id && <span className="mv-accent">{Icon.check(18)}</span>}</button>)}</div>
    </Sheet>}
    {confirmCity && <Confirm title="Сменить город?" text={`Корзина привязана к городу. Позиции не переносятся в ${me.cities.find((c: any) => c.id === confirmCity)?.name} автоматически: они останутся в корзине, но не будут оформлены в новом городе.`} ok="Сменить" onCancel={() => setConfirmCity(null)} onOk={() => changeCity(confirmCity)} />}
    {confirmForeign && <Confirm danger title="Удалить позиции другого города?" text="Они будут удалены из корзины." ok="Удалить" onCancel={() => setConfirmForeign(false)}
      onOk={() => { setCart(c => Object.fromEntries(Object.entries(c).filter(([id]) => !foreign.includes(id)))); setConfirmForeign(false) }} />}
    {confirmClear && <Confirm danger title="Очистить корзину?" text="Все товары будут удалены из корзины." ok="Очистить" onCancel={() => setConfirmClear(false)} onOk={() => { setCart({}); setConfirmClear(false) }} />}

    <BottomNav active={tab === 'order' ? 'profile' : tab} onSelect={go} items={[
      { key: 'catalog', label: 'Каталог', icon: Icon.home(22) },
      { key: 'cart', label: 'Корзина', icon: Icon.cart(22), count: count },
      { key: 'profile', label: 'Профиль', icon: Icon.user(22) },
    ]} />
  </div>)
}

function ProductSheet({ p, cityName, tier, cart, onClose, onAdd, onChangeCity }: any) {
  const single = p.items.length === 1
  const [sel, setSel] = useState<any>(single && p.items[0].available > 0 ? p.items[0] : null), [n, setN] = useState(1)
  const [fq, setFq] = useState(''), [allv, setAllv] = useState(false)
  const left = sel ? sel.available - (cart[sel.id] || 0) : 0
  const inStock = p.items.filter((i: any) => i.available > 0)
  const total = inStock.reduce((s: number, i: any) => s + i.available, 0)
  const filtered = inStock.filter((i: any) => !fq || variantLabel(i).toLowerCase().includes(fq.toLowerCase()))
  const visible = allv || fq || inStock.length <= 12 ? filtered : filtered.slice(0, 12)
  const price = sel ? sel.price : (inStock.length ? Math.min(...inStock.map((i: any) => i.price)) : 0)
  const tierLabel = (t: any) => (t.min === t.max ? `${t.min} шт.` : `${t.min}–${t.max} шт.`)

  return (<Sheet onClose={onClose}>
    <Pic p={p} />
    <div className="mv-row mv-between" style={{ margin: '16px 0 2px' }}><h2 style={{ margin: 0, fontSize: 24, fontWeight: 800 }}>{p.name}</h2><button className="mv-iconbtn" aria-label="Закрыть" onClick={onClose} style={{ width: 36, height: 36 }}>{Icon.close(18)}</button></div>
    <div className="mv-city-line" style={{ margin: '8px 0 0' }}><span className="mv-sub">Вы просматриваете наличие в <b>{cityName}</b></span><button className="mv-link" onClick={onChangeCity}>Сменить</button></div>

    {!single && <>
      <div className="mv-row mv-between" style={{ margin: '18px 0 10px' }}><b>Вкус / цвет / вариант</b><span className="mv-sub" style={{ fontSize: 11 }}>{total} в наличии</span></div>
      {p.items.length > 8 && <input className="mv-input sm" placeholder="Поиск вкуса или цвета…" value={fq} onChange={e => setFq(e.target.value)} style={{ marginBottom: 10 }} />}
      <div className="mv-flavors">{visible.map((i: any) => <button key={i.id} className={'mv-chip' + (sel?.id === i.id ? ' on' : '')} onClick={() => { setSel(i); setN(1); haptic('light') }}>
        <span>{variantLabel(i) || 'Стандарт'}</span><em className={i.available <= 3 ? 'low' : ''}>{i.available}</em></button>)}</div>
      {!filtered.length && <div className="mv-sub" style={{ padding: 12, textAlign: 'center' }}>Ничего не найдено</div>}
      {!allv && !fq && inStock.length > 12 && <button className="mv-btn ghost sm" style={{ width: '100%', marginTop: 8 }} onClick={() => setAllv(true)}>Показать все {inStock.length} вариантов</button>}
    </>}

    <div className="mv-row mv-between" style={{ margin: '20px 0 0' }}><span className="mv-muted">Цена</span><Price v={price} lg /></div>
    <div className="mv-divider" />
    <b style={{ fontSize: 15 }}>Оптовая цена</b>
    <div style={{ marginTop: 10 }}>
      {(p.tiers || []).map((t: any, k: number) => <div key={k} className="mv-tier"><span className="mv-muted">{tierLabel(t)}</span><b>{eur(t.price)} / шт.</b></div>)}
      <div className="mv-tier"><span className="mv-muted">50+ шт.</span><b>По согласованию с менеджером</b></div>
      <div className="mv-sub" style={{ fontSize: 11, marginTop: 6 }}>Ступень считается по общему количеству единиц во всём заказе, а не по одному товару.</div>
    </div>

    {sel && sel.available > 0 && <div className="mv-row mv-between" style={{ marginTop: 18 }}><Qty n={n} onMinus={() => setN(Math.max(1, n - 1))} onPlus={() => setN(n + 1)} maxed={n >= left} /><Price v={sel.price * n} /></div>}
    <button className="mv-btn" style={{ marginTop: 16 }} disabled={!sel || left <= 0} onClick={() => sel && onAdd(sel.id, n)}>
      {!sel ? (total > 0 ? 'Выберите вариант' : 'Нет в наличии') : left <= 0 ? 'Весь остаток в корзине' : 'Добавить в корзину'}</button>
  </Sheet>)
}



// Редактор заказа покупателя. Разрешён только в статусах «Новый» и «Подтверждён» (= «В обработке»).
// Итог считает сервер (customer_edit_preview), сохранение атомарно (customer_edit_order).
function OrderEditor({ order, catalog, onClose, onSaved }: any) {
  const orig: Record<string, number> = {}
  order.order_items.forEach((i: any) => { orig[i.inventory_id] = (orig[i.inventory_id] || 0) + i.quantity })
  const [qty, setQty] = useState<Record<string, number>>({ ...orig })
  const [pv, setPv] = useState<any>(null), [err, setErr] = useState(''), [busy, setBusy] = useState(false)
  const [key] = useState(() => crypto.randomUUID())
  const [adding, setAdding] = useState(false)

  const avail: Record<string, any> = {}
  catalog?.products.forEach((p: any) => p.items.forEach((i: any) => { avail[i.id] = { p, item: i } }))
  // Доступно = свободный остаток + то, что уже зарезервировано этим заказом
  const maxFor = (id: string) => (avail[id] ? avail[id].item.available : 0) + (orig[id] || 0)
  const items = Object.entries(qty).filter(([, n]) => n > 0).map(([id, n]) => ({ inventory_id: id, quantity: n }))
  const k = JSON.stringify(items)
  const nameOf = (id: string) => { const x = avail[id]; if (x) return { name: x.p.name, v: x.item.variant }; const o = order.order_items.find((i: any) => i.inventory_id === id); return { name: o?.product_name || '—', v: o?.variant_name || '' } }

  useEffect(() => {
    if (!items.length) { setPv(null); return }
    const t = setTimeout(() => api(`/api/orders/${order.id}/edit/preview`, { method: 'POST', body: JSON.stringify({ items }) })
      .then(p => { setPv(p); setErr('') }).catch(e => { setPv(null); setErr(e.message) }), 250)
    return () => clearTimeout(t)
  }, [k])

  const set = (id: string, n: number) => setQty(q => { const nq = { ...q }; const v = Math.max(0, Math.min(n, maxFor(id))); if (v) nq[id] = v; else delete nq[id]; return nq })
  const save = async () => {
    if (busy || !items.length) return
    setBusy(true)
    try { await api(`/api/orders/${order.id}/edit`, { method: 'POST', body: JSON.stringify({ items, idempotency_key: key }) }); onSaved(await api('/api/orders/' + order.id)) }
    catch (e: any) { setErr(e.message) } finally { setBusy(false) }
  }
  const addable = Object.values(avail).filter((x: any) => !qty[x.item.id] && x.item.available > 0)

  return (<Sheet onClose={onClose}>
    <h2 style={{ margin: '16px 0 4px', fontSize: 22, fontWeight: 800 }}>Изменить заказ #{order.number}</h2>
    <div className="mv-sub" style={{ marginBottom: 12 }}>Можно менять количество и состав, пока заказ не подготовлен. Цена пересчитается для всего заказа.</div>
    <div className="mv-col" style={{ gap: 8 }}>{Object.keys(qty).filter(id => qty[id] > 0).map(id => { const n = nameOf(id); return (
      <div key={id} className="mv-card mv-row" style={{ padding: 10 }}>
        <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 14 }} className="mv-trunc">{n.name}</div><div className="mv-sub mv-trunc">{n.v || 'Стандарт'}</div></div>
        <div className="mv-qty"><button onClick={() => set(id, qty[id] - 1)}>{Icon.minus(16)}</button><span style={{ minWidth: 28, textAlign: 'center', fontWeight: 800 }}>{qty[id]}</span>
          <button disabled={qty[id] >= maxFor(id)} onClick={() => set(id, qty[id] + 1)}>{Icon.plus(16)}</button></div>
        <button className="mv-link mv-danger" aria-label="Удалить" onClick={() => set(id, 0)}>{Icon.trash(18)}</button>
      </div>) })}</div>

    <button className="mv-btn ghost sm" style={{ marginTop: 12, width: '100%' }} onClick={() => setAdding(a => !a)}>{adding ? 'Скрыть список' : '+ Добавить товар'}</button>
    {adding && <div className="mv-col" style={{ gap: 6, marginTop: 10, maxHeight: 220, overflowY: 'auto' }}>{addable.map((x: any) => (
      <button key={x.item.id} className="mv-card tap mv-row mv-between" style={{ padding: 10 }} onClick={() => set(x.item.id, 1)}>
        <span className="mv-trunc">{x.p.name} · {x.item.variant || 'Стандарт'}</span><span className="mv-sub">{x.item.available} шт.</span></button>))}
      {!addable.length && <div className="mv-sub">Нет других товаров в наличии</div>}</div>}

    <div className="mv-card mv-col" style={{ gap: 6, marginTop: 14 }}>
      {pv?.approval_required ? <div className="mv-sub">Крупный заказ (50+): итог назначит менеджер.</div>
        : pv ? <><div className="mv-row mv-between"><span className="mv-muted">Единиц</span><span>{pv.total_units} · ступень {pv.tier_label}</span></div>
          {pv.discount > 0 && <div className="mv-row mv-between mv-success"><span>Скидка</span><span>−{eur(pv.discount)}</span></div>}
          <div className="mv-row mv-between"><b style={{ fontSize: 18 }}>Итого</b><Price v={+pv.total} lg /></div>
          {order.paid_at && <div className="mv-sub">Оплачено {eur(+order.paid_amount)}. Разница: {pv.total - order.paid_amount >= 0 ? `доплата ${eur(pv.total - order.paid_amount)}` : `переплата ${eur(order.paid_amount - pv.total)} (решит менеджер)`}</div>}</>
        : <div className="mv-sub">{items.length ? 'Считаем…' : 'Добавьте хотя бы один товар. Чтобы убрать заказ целиком, отмените его.'}</div>}
      {err && <div className="mv-sub mv-danger">{err}</div>}
    </div>
    <button className="mv-btn" style={{ marginTop: 14 }} disabled={busy || !items.length || !!err} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить изменения'}</button>
  </Sheet>)
}

// Приведи друга: ссылка, статусы и выбор бонусной жидкости (только Мюнхен).
function ReferralCard({ fail, done }: { fail: (m: string) => void; done: (m: string) => void }) {
  const [info, setInfo] = useState<any>(null), [opts, setOpts] = useState<any[]>([]), [pick, setPick] = useState(''), [busy, setBusy] = useState(false), [q, setQ] = useState('')
  const load = async () => {
    try {
      const r = await api('/api/referral'); setInfo(r)
      setOpts(r.is_munich && r.reward_ready && r.subscribed ? await api('/api/referral/options') : [])
    } catch (e: any) { fail(e.message) }
  }
  useEffect(() => { load() }, [])
  if (!info) return null
  const cnt = (st: string) => info.invited.filter((r: any) => r.status === st).length
  const qn = q.trim().toLowerCase()
  const shownOpts = opts.filter(o => !qn || `${o.name} ${o.variant || ''}`.toLowerCase().includes(qn))
  const pickName = opts.find(o => o.inventory_id === pick)?.name
  const copy = async () => {
    try { await navigator.clipboard.writeText(info.link); done('Ссылка скопирована') }
    catch { fail('Не удалось скопировать. Выделите ссылку и скопируйте вручную') }
  }
  const redeem = async () => {
    if (!pick) return
    setBusy(true)
    try {
      await api('/api/referral/redeem', { method: 'POST', body: JSON.stringify({ inventory_id: pick, idempotency_key: crypto.randomUUID() }) })
      done('Бонус оформлен: заказ создан, он бесплатный'); setPick(''); setQ(''); await load()
    } catch (e: any) { fail(e.message) } finally { setBusy(false) }
  }
  return (<div className="mv-card" style={{ marginTop: 12 }}>
    <div style={{ fontWeight: 800, marginBottom: 4 }}>Приведи друга — жидкость бесплатно</div>
    {!info.is_munich ? <div className="mv-sub">Акция действует только для клиентов Мюнхена.</div> : <>
      <div className="mv-sub" style={{ marginBottom: 10 }}>Бонус получаете вы, когда друг впервые заказывает у нас и получает заказ. Заказ должен быть сделан из категорий Жидкости, Pod-системы, Снюс, Одноразки (исключение: Elf Bar 2K), но не из картриджей и Elf Bar 2000. Бонус: одна жидкость Elfliq или Vozol бесплатно. Вы и друг должны быть подписаны на канал.</div>
            <div className="mv-sub" style={{ marginBottom: 4 }}>Бот: ссылка для друга</div>
      <div className="mv-row" style={{ gap: 8 }}>
        <input className="mv-input sm" readOnly value={info.link} onFocus={e => e.target.select()} style={{ flex: 1, minWidth: 0 }} />
        <button className="mv-btn sm" style={{ width: 'auto' }} onClick={copy}>Копировать</button>
      </div>
      {info.channel_link && <>
        <div className="mv-sub" style={{ margin: '12px 0 4px' }}>Канал: подписка обязательна</div>
        <a className="mv-btn ghost sm" style={{ width: 'auto', display: 'inline-flex', alignItems: 'center' }} href={info.channel_link} target="_blank" rel="noreferrer">Открыть канал</a>
      </>}
      <div className="mv-sub" style={{ marginTop: 10 }}>Приглашено: {info.invited.length} · ждут покупки друга: {cnt('pending')} · бонус готов: {cnt('eligible')} · получено: {cnt('redeemed')}</div>
      {info.reward_ready && !info.subscribed && <div className="mv-note" style={{ marginTop: 10 }}>
        Бонус готов. Подпишитесь на канал, чтобы его получить.{' '}
        {info.channel_link && <a href={info.channel_link} target="_blank" rel="noreferrer">Открыть канал</a>}{' '}
        <button className="mv-link" onClick={load}>Проверить</button></div>}
      {info.reward_ready && info.subscribed && <div className="mv-col" style={{ marginTop: 10 }}>
        <div className="mv-sub">Выберите жидкость Elfliq или Vozol:</div>
        <input className="mv-input" placeholder="Поиск по названию или вкусу" value={q} onChange={e => setQ(e.target.value)} />
        <div className="mv-col" style={{ gap: 6, maxHeight: 320, overflowY: 'auto' }}>
          {shownOpts.map((o: any) => {
            const on = pick === o.inventory_id
            return (<button key={o.inventory_id} className="mv-card tap mv-row mv-between mv-tap" style={{ padding: 12, borderColor: on ? 'var(--accent)' : undefined }} onClick={() => setPick(o.inventory_id)}>
              <div className="mv-grow" style={{ minWidth: 0 }}><b className="mv-trunc" style={{ display: 'block' }}>{o.name}</b>{o.variant && <div className="mv-sub mv-trunc">{o.variant}</div>}</div>
              <span className="mv-sub" style={{ flexShrink: 0 }}>{on ? 'выбрано' : `есть ${o.available}`}</span>
            </button>)
          })}
          {!shownOpts.length && <div className="mv-sub">Ничего не найдено</div>}
        </div>
        <button className="mv-btn" disabled={!pick || busy} onClick={redeem}>{pickName ? `Получить бесплатно: ${pickName}` : 'Выберите жидкость из списка'}</button>
      </div>}
    </>}
  </div>)
}
