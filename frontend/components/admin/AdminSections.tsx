'use client'
import { useEffect, useState } from 'react'
import { Notify, ST, adminApi as api, eur } from '@/lib/shared'
import { Confirm, Empty, Icon, Loading, Price, Sheet, StatusBadge } from '../ui'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; catalog: any; onNotify: Notify; onRefresh: () => void }

// Допустимые переходы совпадают с change_order_status в БД.
const NEXT: Record<string, string[]> = { new: ['confirmed', 'cancelled'], confirmed: ['prepared', 'cancelled'], prepared: ['issued', 'cancelled'], issued: ['returned'] }
const ACTION: Record<string, string> = { confirmed: 'Подтвердить', prepared: 'Отметить подготовленным', issued: 'Выдать покупателю', cancelled: 'Отменить заказ', returned: 'Оформить возврат' }
const FILTERS: [string, string][] = [['', 'Все'], ['new', 'Новые'], ['confirmed', 'Подтверждены'], ['prepared', 'Подготовлены'], ['issued', 'Выданы'], ['cancelled', 'Отменены'], ['returned', 'Возвраты']]
const Kv = ({ l, v }: any) => <div className="mv-row mv-between" style={{ alignItems: 'flex-start', fontSize: 14 }}><span className="mv-muted">{l}</span><span style={{ textAlign: 'right', maxWidth: '65%', overflowWrap: 'anywhere' }}>{v}</span></div>

// Действия над товаром. Цены и себестоимость — отдельным аудируемым эндпоинтом, остальное — PATCH.
function productActions(onNotify: Notify, onRefresh: () => void, id: string) {
  const call = async (path: string, method: string, body: any, ok: string): Promise<boolean> => {
    try { await api(path, { method, body: JSON.stringify(body) }); onNotify(ok); onRefresh(); return true }
    catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err'); return false }
  }
  return {
    onSaveProduct: (body: any) => call(`/api/admin/products/${id}`, 'PATCH', body, 'Товар сохранён'),
    onSavePrices: (body: any) => call(`/api/admin/products/${id}/prices`, 'PUT', body, 'Цены сохранены'),
    onSaveTiers: (tiers: any[]) => call(`/api/admin/products/${id}/tiers`, 'PUT', { tiers }, 'Оптовые цены сохранены'),
    onVariantPrice: (vid: string, price: number | null) => call(`/api/admin/variants/${vid}`, 'PATCH', { price }, 'Цена варианта сохранена'),
    onAddVariant: (name: string, price: number | null) => call(`/api/admin/products/${id}/variants`, 'POST', { name, price }, 'Вариант добавлен (остаток 0 в каждом городе)'),
  }
}

// ============================ ЗАКАЗЫ ============================
export function OrdersSection({ role, cityId, cities, onNotify }: Props) {
  const [city, setCity] = useState<string>(role === 'city_admin' ? (cityId || '') : '')
  const [status, setStatus] = useState(''), [search, setSearch] = useState('')
  const [orders, setOrders] = useState<any[] | null>(null)
  const [sel, setSel] = useState<any>(null), [pending, setPending] = useState<{ order: any; to: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [ap, setAp] = useState<Record<string, string>>({})
  const cityLabel = (id?: string | null) => (id ? cities.find(c => c.id === id)?.name || id : 'Город не указан').toUpperCase()

  const load = () => {
    setOrders(null)
    const qs = new URLSearchParams(); if (city) qs.set('city', city); if (status) qs.set('status', status)
    api('/api/admin/orders?' + qs.toString()).then(setOrders).catch(e => { setOrders([]); onNotify('Не удалось загрузить заказы: ' + e.message, 'err') })
  }
  useEffect(load, [city, status])

  const filtered = (orders || []).filter(o => {
    const s = search.trim().toLowerCase(); if (!s) return true
    return String(o.number).toLowerCase().includes(s) || String(o.contact || '').toLowerCase().includes(s) || String(o.telegram_id).includes(s)
  })

  const act = async (o: any, body: any, path: string, ok: string) => {
    setPending(null); setBusy(true)
    try {
      await api(path.replace('{id}', o.id), { method: body ? 'PATCH' : 'POST', body: body ? JSON.stringify(body) : undefined })
      onNotify(ok); setSel(await api('/api/admin/orders/' + o.id)); load()
    }
    catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setBusy(false) }
  }

  const approve = async () => {
    setBusy(true)
    try {
      await api(`/api/admin/orders/${sel.id}/approve`, { method: 'POST', body: JSON.stringify({ prices: sel.order_items.map((i: any) => ({ order_item_id: i.id, unit_price: Number(String(ap[i.id]).replace(',', '.')) })) }) })
      onNotify('Цены назначены, заказ можно подтверждать'); setSel(await api('/api/admin/orders/' + sel.id)); load()
    } catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setBusy(false) }
  }

  return (<>
    <h1 className="mv-h1">Заказы</h1>
    {role === 'owner' && <select className="mv-input sm" style={{ margin: '8px 0 10px' }} value={city} onChange={e => setCity(e.target.value)}>
      <option value="">Все города</option>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <input className="mv-input" placeholder="Поиск: номер, контакт, Telegram ID…" value={search} onChange={e => setSearch(e.target.value)} style={{ margin: '8px 0 12px' }} />
    <div className="mv-seg" style={{ marginBottom: 14, flexWrap: 'wrap' }}>{FILTERS.map(([k, l]) => <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{l}</button>)}</div>
    {orders === null && <Loading />}
    <div className="mv-col">{filtered.map(o => (
      <button key={o.id} className="mv-card tap mv-row mv-between" onClick={() => setSel(o)}>
        <div className="mv-grow">
          <div className="mv-city-tag">{cityLabel(o.city_id)}</div>
          <b>#{o.number}</b><div className="mv-sub mv-trunc">{o.contact}</div><div className="mv-sub">{new Date(o.created_at).toLocaleString('ru-RU')}</div>
        </div>
        <div style={{ textAlign: 'right' }}><div style={{ fontWeight: 800, marginBottom: 6 }}>{eur(+o.total)}</div><StatusBadge status={o.status} />
          <div className="mv-sub" style={{ marginTop: 4, fontSize: 11 }}>{o.paid_at ? 'оплачен' : 'не оплачен'}</div></div>
      </button>))}</div>
    {orders && !filtered.length && <Empty icon={Icon.list(30)} title="Заказов нет" text={status || search ? 'Измените фильтр или запрос' : undefined} />}

    {sel && <Sheet onClose={() => setSel(null)}>
      <div className="mv-city-tag" style={{ marginTop: 16 }}>{cityLabel(sel.city_id)}</div>
      <div className="mv-row mv-between" style={{ margin: '6px 0 12px' }}><div><h2 style={{ margin: 0, fontSize: 22, fontWeight: 800 }}>№ {sel.number}</h2><div className="mv-sub">{new Date(sel.created_at).toLocaleString('ru-RU')}</div></div><StatusBadge status={sel.status} /></div>
      <div className="mv-card mv-col" style={{ gap: 8 }}>
        <Kv l="Покупатель" v={sel.contact} /><Kv l="Telegram ID" v={sel.telegram_id} />
        <Kv l="Оплата" v={sel.paid_at ? `оплачен · ${eur(+sel.paid_amount)}` : 'не оплачен'} />
        {sel.refunded_amount > 0 && <Kv l="Возврат покупателю" v={eur(+sel.refunded_amount)} />}
        <Kv l="Комментарий" v={sel.comment || '—'} />
      </div>
      <h3 style={{ margin: '16px 0 8px', fontSize: 15, fontWeight: 800 }}>Товары</h3>
      <div className="mv-col" style={{ gap: 8 }}>{sel.order_items?.map((i: any) => (
        <div key={i.id} className="mv-card mv-row mv-between" style={{ padding: 12 }}>
          <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 14 }} className="mv-trunc">{i.product_name}</div><div className="mv-sub mv-trunc">{[i.variant_name, i.flavor_name].filter(Boolean).join(' · ')}{i.is_wholesale ? ' · опт' : ''}</div></div>
          <div style={{ fontSize: 13 }}>{i.quantity} шт. × {eur(+i.unit_price)}</div></div>))}</div>
      {sel.approval_required ? (role === 'owner' ? <div className="mv-card mv-col" style={{ gap: 8, margin: '14px 0' }}>
        <b>Крупный заказ: назначьте цену каждой позиции</b>
        {sel.order_items?.map((i: any) => (<div key={i.id} className="mv-row mv-between" style={{ gap: 8 }}>
          <span className="mv-trunc" style={{ flex: 1, fontSize: 14 }}>{i.product_name} · {i.quantity} шт.</span>
          <input className="mv-input sm" style={{ width: 100, textAlign: 'right' }} type="text" inputMode="decimal" placeholder="€/шт" value={ap[i.id] ?? ''} onChange={e => setAp({ ...ap, [i.id]: e.target.value })} />
        </div>))}
        <button className="mv-btn" disabled={busy || !sel.order_items?.every((i: any) => ap[i.id] !== undefined && ap[i.id] !== '' && Number(String(ap[i.id]).replace(',', '.')) >= 0)} onClick={approve}>Назначить цены</button>
      </div> : <div className="mv-card mv-sub" style={{ margin: '14px 0' }}>Крупный заказ (50+): итог назначает владелец. Подтвердить до согласования нельзя.</div>)
      : <div className="mv-row mv-between" style={{ margin: '14px 0' }}><b style={{ fontSize: 18 }}>Итого</b><Price v={+sel.total} lg /></div>}
      <div className="mv-col">
        {!sel.paid_at && !['cancelled', 'returned'].includes(sel.status) && <button className="mv-btn ghost" disabled={busy} onClick={() => act(sel, null, '/api/admin/orders/{id}/paid', 'Оплата отмечена')}>Отметить оплаченным</button>}
        {(NEXT[sel.status] || []).map(s => <button key={s} disabled={busy} className={'mv-btn' + (s === 'cancelled' || s === 'returned' ? ' danger' : '')} onClick={() => setPending({ order: sel, to: s })}>{ACTION[s]}</button>)}
        {!NEXT[sel.status] && <div className="mv-sub" style={{ textAlign: 'center' }}>Статус: {ST[sel.status]}. Дальше менять нельзя.</div>}
      </div>
    </Sheet>}
    {pending && <Confirm danger={['cancelled', 'returned'].includes(pending.to)} title={`${ACTION[pending.to]}?`}
      text={pending.to === 'cancelled' ? 'Резерв товара будет освобождён. Если заказ оплачен, сумма будет отмечена к возврату покупателю.' : pending.to === 'issued' ? 'Товар будет списан со склада этого города.' : pending.to === 'returned' ? 'Товар вернётся на склад этого города, оплаченная сумма — к возврату.' : undefined}
      onCancel={() => setPending(null)} onOk={() => act(pending.order, { status: pending.to }, '/api/admin/orders/{id}', 'Статус обновлён')} />}
  </>)
}

// ============================ ТОВАРЫ ============================
export function ProductsSection({ role, catalog, onNotify, onRefresh }: Props) {
  const [search, setSearch] = useState(''), [open, setOpen] = useState<any>(null)
  const [np, setNp] = useState({ name: '', price: '', category_id: '', wholesale: false })
  const [adding, setAdding] = useState(false), [creating, setCreating] = useState(false)
  const owner = role === 'owner'
  const cats = catalog?.categories || []
  const products = (catalog?.products || []).filter((p: any) => p.name.toLowerCase().includes(search.toLowerCase()))
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || '—'

  const patch = async (path: string, body: any, ok: string) => {
    setAdding(true)
    try { await api(path, { method: 'PATCH', body: JSON.stringify(body) }); onNotify(ok); onRefresh() }
    catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setAdding(false) }
  }
  const createProduct = async () => {
    if (!np.name.trim() || !np.category_id) return onNotify('Укажите название и категорию', 'err')
    setCreating(true)
    try {
      await api('/api/admin/products', { method: 'POST', body: JSON.stringify({ name: np.name.trim(), category_id: +np.category_id, price: np.price === '' ? null : +np.price, wholesale_enabled: np.wholesale }) })
      setNp({ name: '', price: '', category_id: '', wholesale: false }); onNotify('Товар создан. Добавьте варианты и цену.'); onRefresh()
    } catch (e: any) { onNotify('Не создано: ' + e.message, 'err') } finally { setCreating(false) }
  }

  return (<>
    <h1 className="mv-h1">Товары</h1>
    <input className="mv-input" placeholder="Поиск товара…" value={search} onChange={e => setSearch(e.target.value)} style={{ margin: '8px 0 14px' }} />
    {owner && <details className="mv-card" style={{ marginBottom: 14 }}><summary style={{ fontWeight: 800, cursor: 'pointer' }}>Новый товар</summary>
      <div className="mv-col" style={{ marginTop: 12 }}>
        <input className="mv-input" placeholder="Название" value={np.name} onChange={e => setNp({ ...np, name: e.target.value })} />
        <select className="mv-input" value={np.category_id} onChange={e => setNp({ ...np, category_id: e.target.value })}><option value="">Категория</option>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input className="mv-input" type="number" inputMode="decimal" placeholder="Цена (€) — можно оставить пустой" value={np.price} onChange={e => setNp({ ...np, price: e.target.value })} />
        <label className="mv-sub" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={np.wholesale} onChange={e => setNp({ ...np, wholesale: e.target.checked })} />Суммируется для оптовых цен</label>
        <button className="mv-btn" disabled={creating} onClick={createProduct}>{creating ? 'Создаём…' : 'Создать'}</button>
      </div></details>}
    <div className="mv-col">{products.map((p: any) => (
      <button key={p.id} className="mv-card tap mv-row mv-between" style={{ opacity: p.active ? 1 : .6 }} onClick={() => setOpen(p)}>
        <div className="mv-grow"><b className="mv-trunc" style={{ display: 'block' }}>{p.name}</b>
          <div className="mv-sub">{catName(p.category_id)} · {p.variants?.length || 0} вариантов · {p.price == null ? <span style={{ color: 'var(--warning)' }}>цена не задана</span> : eur(+p.price)}</div></div>
        <span className={'mv-badge ' + (p.active ? 'completed' : 'cancelled')}>{p.active ? 'Активен' : 'В архиве'}</span>
      </button>))}</div>
    {!products.length && <Empty icon={Icon.tag(30)} title="Товаров нет" />}

    {open && <ProductSheet product={open} owner={owner} busy={adding} catName={catName(open.category_id)} onClose={() => setOpen(null)}
      actions={productActions(onNotify, onRefresh, open.id)} />}
  </>)
}

function ProductSheet({ product, owner, catName, onClose, actions }: any) {
  const [price, setPrice] = useState(product.price == null ? '' : String(product.price))
  const [cost, setCost] = useState(product.cost_price == null ? '' : String(product.cost_price))
  const [active, setActive] = useState(!!product.active)
  const [tiers, setTiers] = useState<any[]>((product.tiers || []).map((t: any) => ({ min: t.min, max: t.max, price: String(t.price) })))
  const [vname, setVname] = useState(''), [vprice, setVprice] = useState(''), [vp, setVp] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const num = (v: string) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')))
  const tierLbl = (t: any) => (t.min === t.max ? `${t.min} шт.` : `${t.min}–${t.max} шт.`)
  const run = async (fn: () => Promise<boolean>) => { setSaving(true); await fn(); setSaving(false) }

  return (<Sheet onClose={onClose}>
    <h2 style={{ margin: '16px 0 4px', fontSize: 20, fontWeight: 800 }}>{product.name}</h2>
    <div className="mv-sub" style={{ marginBottom: 12 }}>{catName} · {product.variants?.length || 0} вариантов</div>
    {!owner && <div className="mv-sub" style={{ marginBottom: 10 }}>Изменения доступны владельцу. Цены показаны для справки.</div>}

    <h3 style={{ margin: '6px 0 8px', fontSize: 15, fontWeight: 800 }}>Цены</h3>
    <div className="mv-col" style={{ gap: 10 }}>
      <label className="mv-sub">Розничная цена за единицу (€). Пусто = товар не продаётся.</label>
      <input className="mv-input" type="text" inputMode="decimal" disabled={!owner} value={price} onChange={e => setPrice(e.target.value)} />
      {owner && <>
        <label className="mv-sub">Себестоимость за единицу (€). Видна только владельцу.</label>
        <input className="mv-input" type="text" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} />
        <label className="mv-sub" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Активен (выключите, чтобы убрать из продажи, без удаления)</label>
        <div className="mv-row" style={{ gap: 8 }}>
          <button className="mv-btn" disabled={saving} onClick={() => run(() => actions.onSavePrices({ price: num(price), cost_price: num(cost) }))}>Сохранить цены</button>
          <button className="mv-btn ghost" disabled={saving} onClick={() => run(() => actions.onSaveProduct({ active }))}>{active ? 'Активен' : 'Включить'}</button>
        </div></>}
    </div>

    <h3 style={{ margin: '18px 0 4px', fontSize: 15, fontWeight: 800 }}>Оптовые цены по ступеням</h3>
    <div className="mv-sub" style={{ marginBottom: 8 }}>Ступень считается по общему количеству единиц во всём заказе. 50+ — по согласованию.</div>
    <div className="mv-col" style={{ gap: 6 }}>{tiers.map((t, i) => (
      <div key={i} className="mv-row mv-between" style={{ fontSize: 14 }}>
        <span>{tierLbl(t)}</span>
        <input className="mv-input sm" style={{ width: 110, textAlign: 'right' }} type="text" inputMode="decimal" disabled={!owner} value={t.price}
          onChange={e => setTiers(ts => ts.map((x, k) => k === i ? { ...x, price: e.target.value } : x))} />
      </div>))}</div>
    {owner && <button className="mv-btn ghost" style={{ marginTop: 10, width: '100%' }} disabled={saving}
      onClick={() => run(() => actions.onSaveTiers(tiers.map(t => ({ min: t.min, price: num(t.price) ?? -1 }))))}>Сохранить ступени</button>}

    <h3 style={{ margin: '18px 0 8px', fontSize: 15, fontWeight: 800 }}>Варианты</h3>
    <div className="mv-col" style={{ gap: 6, maxHeight: 260, overflowY: 'auto' }}>{(product.variants || []).map((v: any) => (
      <div key={v.id} className="mv-row mv-between" style={{ fontSize: 14, gap: 8 }}>
        <span className="mv-trunc" style={{ flex: 1 }}>{v.name}</span>
        {owner ? <div className="mv-row" style={{ gap: 6 }}>
          <input className="mv-input sm" style={{ width: 84 }} type="text" inputMode="decimal" placeholder={product.price == null ? 'цена' : String(product.price)}
            value={vp[v.id] ?? (v.price == null ? '' : String(v.price))} onChange={e => setVp({ ...vp, [v.id]: e.target.value })} />
          <button className="mv-btn ghost sm" disabled={saving} onClick={() => run(() => actions.onVariantPrice(v.id, num(vp[v.id] ?? (v.price == null ? '' : String(v.price)))))}>ок</button>
        </div> : <span className="mv-sub">{v.price == null ? '—' : eur(+v.price)}</span>}
      </div>))}</div>
    {owner && <div className="mv-col" style={{ gap: 8, marginTop: 14 }}>
      <input className="mv-input" placeholder="Новый вариант (вкус / цвет / сопротивление)" value={vname} onChange={e => setVname(e.target.value)} />
      <input className="mv-input" type="text" inputMode="decimal" placeholder="Цена варианта (необязательно)" value={vprice} onChange={e => setVprice(e.target.value)} />
      <button className="mv-btn ghost" disabled={!vname.trim() || saving} onClick={() => run(() => actions.onAddVariant(vname.trim(), num(vprice)))}>Добавить вариант</button>
    </div>}
  </Sheet>)
}

// ============================ ОПТОВЫЕ ЦЕНЫ (ступени по товарам) ============================
export function PricesSection({ role, catalog, onNotify, onRefresh }: Props) {
  const [open, setOpen] = useState<any>(null)
  const owner = role === 'owner'
  const cats = catalog?.categories || []
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || '—'
  const fmt = (n: any) => Number(n).toFixed(2).replace('.', ',') + ' €'
  return (<>
    <h1 className="mv-h1">Оптовые цены</h1>
    <div className="mv-sub" style={{ margin: '4px 0 14px' }}>Ступень выбирается по общему количеству единиц в заказе. Цены заданы по каждому товару.</div>
    <div className="mv-col" style={{ gap: 8 }}>{(catalog?.products || []).filter((p: any) => p.active).map((p: any) => (
      <button key={p.id} className="mv-card tap" onClick={() => setOpen(p)} style={{ textAlign: 'left' }}>
        <b className="mv-trunc" style={{ display: 'block' }}>{p.name}</b>
        <div className="mv-sub" style={{ marginTop: 4 }}>{(p.tiers || []).map((t: any) => `${t.min}–${t.max}: ${fmt(t.price)}`).join(' · ') || 'ступени не заданы'}</div>
      </button>))}</div>
    {open && <ProductSheet product={open} owner={owner} catName={catName(open.category_id)} onClose={() => setOpen(null)}
      actions={productActions(onNotify, onRefresh, open.id)} />}
  </>)
}

// ============================ КАТЕГОРИИ (владелец) ============================
export function CategoriesSection({ catalog, onNotify, onRefresh }: Props) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false)
  const cats = catalog?.categories || []
  const add = async () => {
    if (!name.trim()) return
    setBusy(true)
    try { await api('/api/admin/categories', { method: 'POST', body: JSON.stringify({ name: name.trim() }) }); setName(''); onNotify('Категория добавлена'); onRefresh() }
    catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setBusy(false) }
  }
  return (<>
    <h1 className="mv-h1">Категории</h1>
    <div className="mv-row" style={{ margin: '8px 0 14px' }}><input className="mv-input" placeholder="Новая категория…" value={name} onChange={e => setName(e.target.value)} />
      <button className="mv-plus" style={{ width: 50, height: 50, borderRadius: 'var(--r-lg)' }} disabled={busy} onClick={add} aria-label="Добавить">{Icon.plus(20)}</button></div>
    <div className="mv-sub" style={{ marginBottom: 10 }}>Категория скрывается в магазине, если в городе нет доступных товаров. Здесь она видна всегда.</div>
    <div className="mv-col" style={{ gap: 8 }}>{cats.map((c: any) => <div key={c.id} className="mv-card mv-row mv-between" style={{ padding: 14 }}><b>{c.name}</b><span className="mv-sub">#{c.id}</span></div>)}</div>
    {!cats.length && <Empty icon={Icon.grid(30)} title="Категорий пока нет" />}
  </>)
}
