'use client'
import { useEffect, useRef, useState } from 'react'
import { Notify, ST, adminApi as api, eur } from '@/lib/shared'
import { Confirm, Empty, Icon, Loading, Price, Sheet, StatusBadge } from '../ui'
import { CategoryChips, SearchField, countByCategory, matchProduct, norm } from './Filters'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; catalog: any; onNotify: Notify; onRefresh: () => void }

// Допустимые переходы совпадают с change_order_status в БД.
const NEXT: Record<string, string[]> = { new: ['prepared', 'cancelled'], prepared: ['issued', 'cancelled'], issued: [] }
const ACTION: Record<string, string> = { prepared: 'Отметить подготовленным', issued: 'Выдать покупателю', cancelled: 'Отменить заказ' }
const FILTERS: [string, string][] = [['', 'Все'], ['new', 'Новые'], ['prepared', 'Подготовлены'], ['issued', 'Выданы'], ['cancelled', 'Отменены']]
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
    // Пакетно: обновление каталога один раз в конце. Возвращает строки, которые не добавились.
    onAddVariants: async (items: { raw: string; name: string; price: number | null }[], skipped: number): Promise<string[]> => {
      const failed: string[] = []; let ok = 0
      for (const it of items) {
        try { await api(`/api/admin/products/${id}/variants`, { method: 'POST', body: JSON.stringify({ name: it.name, price: it.price }) }); ok++ }
        catch { failed.push(it.raw) }
      }
      if (ok) onRefresh()
      const extra = skipped ? `, уже были: ${skipped}` : ''
      if (failed.length) onNotify(`Добавлено ${ok}, не удалось: ${failed.length}${extra}`, 'err')
      else onNotify(`Вкусов добавлено: ${ok}${extra}`)
      return failed
    },
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

  // Старый список остаётся на экране до прихода нового: без мигания.
  const load = () => {
    const qs = new URLSearchParams(); if (city) qs.set('city', city); if (status) qs.set('status', status)
    api('/api/admin/orders?' + qs.toString()).then(setOrders).catch(e => { setOrders(o => o ?? []); onNotify('Не удалось загрузить заказы: ' + e.message, 'err') })
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
    {role === 'owner' && <select className="mv-input" style={{ marginTop: 8 }} value={city} onChange={e => setCity(e.target.value)}>
      <option value="">Все города</option>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <div className="mv-toolbar"><div className="mv-col">
      <SearchField value={search} onChange={setSearch} placeholder="Номер, контакт, Telegram ID" />
      <div className="mv-chips">{FILTERS.map(([k, l]) => <button key={k || 'all'} className={'mv-pill' + (status === k ? ' on' : '')} onClick={() => setStatus(k)}>{l}</button>)}</div>
    </div></div>

    {orders === null && <Loading />}
    <div className="mv-col" style={{ marginTop: 10 }}>{filtered.map(o => (
      <button key={o.id} className="mv-card tap mv-row mv-between mv-tap" onClick={() => setSel(o)}>
        <div className="mv-grow">
          <div className="mv-city-tag">{cityLabel(o.city_id)}</div>
          <b>#{o.number}</b><div className="mv-sub mv-trunc">{o.contact}</div><div className="mv-sub">{new Date(o.created_at).toLocaleString('ru-RU')}</div>
        </div>
        <div style={{ textAlign: 'right', flexShrink: 0 }}><div style={{ fontWeight: 800, marginBottom: 6 }}>{eur(+o.total)}</div><StatusBadge status={o.status} />
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
      <h3 className="mv-section-h">Товары</h3>
      <div className="mv-col" style={{ gap: 8 }}>{sel.order_items?.map((i: any) => (
        <div key={i.id} className="mv-card mv-row mv-between" style={{ padding: 12 }}>
          <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 14 }} className="mv-trunc">{i.product_name}</div><div className="mv-sub mv-trunc">{[i.variant_name, i.flavor_name].filter(Boolean).join(' · ')}{i.is_wholesale ? ' · опт' : ''}</div></div>
          <div style={{ fontSize: 13, flexShrink: 0 }}>{i.quantity} шт. × {eur(+i.unit_price)}</div></div>))}</div>
      {sel.approval_required ? (role === 'owner' ? <div className="mv-card mv-col" style={{ gap: 8, margin: '14px 0' }}>
        <b>Крупный заказ: назначьте цену каждой позиции</b>
        {sel.order_items?.map((i: any) => (<div key={i.id} className="mv-row mv-between" style={{ gap: 8 }}>
          <span className="mv-trunc" style={{ flex: 1, fontSize: 14 }}>{i.product_name} · {i.quantity} шт.</span>
          <input className="mv-input sm" style={{ width: 110, textAlign: 'right' }} type="text" inputMode="decimal" placeholder="€/шт" value={ap[i.id] ?? ''} onChange={e => setAp({ ...ap, [i.id]: e.target.value })} />
        </div>))}
        <button className="mv-btn" disabled={busy || !sel.order_items?.every((i: any) => ap[i.id] !== undefined && ap[i.id] !== '' && Number(String(ap[i.id]).replace(',', '.')) >= 0)} onClick={approve}>Назначить цены</button>
      </div> : <div className="mv-card mv-sub" style={{ margin: '14px 0' }}>Крупный заказ (50+): итог назначает владелец. Подготовить и выдать до согласования нельзя.</div>)
        : <div className="mv-row mv-between" style={{ margin: '14px 0' }}><b style={{ fontSize: 18 }}>Итого</b><Price v={+sel.total} lg /></div>}
      <div className="mv-col">
        {(NEXT[sel.status] || []).map(s => <button key={s} disabled={busy} className={'mv-btn' + (s === 'cancelled' ? ' danger' : '')} onClick={() => setPending({ order: sel, to: s })}>{ACTION[s]}</button>)}
        {!NEXT[sel.status] && <div className="mv-sub" style={{ textAlign: 'center' }}>Статус: {ST[sel.status]}. Дальше менять нельзя.</div>}
      </div>
    </Sheet>}
    {pending && <Confirm danger={pending.to === 'cancelled'} title={`${ACTION[pending.to]}?`}
      text={pending.to === 'cancelled' ? 'Резерв товара будет освобождён. Если заказ оплачен, сумма будет отмечена к возврату покупателю.' : pending.to === 'issued' ? `Товар будет списан со склада этого города. Заказ сразу станет оплаченным: ${eur(+pending.order.total)}.` : undefined}
      onCancel={() => setPending(null)} onOk={() => act(pending.order, { status: pending.to }, '/api/admin/orders/{id}', 'Статус обновлён')} />}
  </>)
}

// ============================ ТОВАРЫ ============================
// Строки из текста: «Название» или «Название; цена» (разделители ; | Tab). Одна запись на строку.
export function parseLines(text: string): { raw: string; name: string; price: number | null }[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(raw => {
    const m = raw.match(/^(.*?)\s*[;|\t]\s*(\d+(?:[.,]\d+)?)\s*(?:€|eur)?$/i)
    if (m && m[1].trim()) return { raw, name: m[1].trim(), price: Number(m[2].replace(',', '.')) }
    return { raw, name: raw, price: null }
  })
}
const toNum = (v: string) => (v === '' || v == null ? null : Number(String(v).replace(',', '.')))

// Фильтр товаров: категория + поиск по названию, категории и вкусам (вариантам).
function filterProducts(all: any[], cats: any[], search: string, cat: string) {
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || ''
  const shown = all
    .map(p => ({ p, m: matchProduct(p, catName(p.category_id), search) }))
    .filter(x => x.m.ok && (!cat || String(x.p.category_id) === cat))
  return { shown, counts: countByCategory(all) }
}

export function ProductsSection({ role, catalog, onNotify, onRefresh }: Props) {
  const [search, setSearch] = useState(''), [cat, setCat] = useState(''), [openId, setOpenId] = useState<string | null>(null)
  const [adding, setAdding] = useState(false), [addCat, setAddCat] = useState('')
  const owner = role === 'owner'
  const cats = catalog?.categories || []
  const all: any[] = catalog?.products || []
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || '—'
  const { shown, counts } = filterProducts(all, cats, search, cat)
  // Шторка всегда берёт свежий товар из каталога: после сохранения видны новые варианты.
  const openProduct = all.find(p => p.id === openId) || null

  return (<>
    <div className="mv-row mv-between" style={{ marginTop: 8 }}>
      <h1 className="mv-h1">Товары</h1>
      {owner && <button className="mv-btn sm" style={{ width: 'auto', padding: '0 16px' }} onClick={() => setAdding(true)}>+ Добавить</button>}
    </div>
    <div className="mv-toolbar"><div className="mv-col">
      <SearchField value={search} onChange={setSearch} placeholder="Товар или вкус, например «mint»" />
      <CategoryChips cats={cats} value={cat} onChange={setCat} counts={counts} allCount={all.length} />
    </div></div>

    <div className="mv-count">Показано: {shown.length} из {all.length}</div>
    <div className="mv-col">{shown.map(({ p, m }) => (
      <button key={p.id} className="mv-card tap mv-row mv-between mv-tap" style={{ opacity: p.active ? 1 : .6 }} onClick={() => setOpenId(p.id)}>
        <div className="mv-grow"><b className="mv-trunc" style={{ display: 'block' }}>{p.name}</b>
          <div className="mv-sub">{catName(p.category_id)} · {p.variants?.length || 0} вар. · {p.price == null ? <span style={{ color: 'var(--warning)' }}>цена не задана</span> : eur(+p.price)}</div>
          {m.flavors.length > 0 && <div className="mv-match">Вкус: {m.flavors.slice(0, 3).join(', ')}{m.flavors.length > 3 ? ` и ещё ${m.flavors.length - 3}` : ''}</div>}
        </div>
        <span className={'mv-badge ' + (p.active ? 'completed' : 'cancelled')}>{p.active ? 'Активен' : 'Архив'}</span>
      </button>))}</div>
    {!shown.length && <Empty icon={Icon.tag(30)} title={all.length ? 'Ничего не найдено' : 'Товаров нет'} text={search || cat ? 'Измените категорию или запрос' : undefined} />}

    {openProduct && <ProductSheet key={openProduct.id} product={openProduct} owner={owner} catName={catName(openProduct.category_id)}
      onClose={() => setOpenId(null)} actions={productActions(onNotify, onRefresh, openProduct.id)} />}
    {adding && owner && <AddProductsSheet catalog={catalog} cat={addCat} setCat={setAddCat} onNotify={onNotify} onRefresh={onRefresh} onClose={() => setAdding(false)} />}
  </>)
}

// Массовое добавление. Категория, оптовый флаг и счётчик сохраняются между товарами, поля очищаются.
function AddProductsSheet({ catalog, cat, setCat, onNotify, onRefresh, onClose }: any) {
  const cats: any[] = catalog?.categories || []
  const all: any[] = catalog?.products || []
  const [mode, setMode] = useState<'one' | 'list'>('one')
  const [name, setName] = useState(''), [price, setPrice] = useState(''), [wholesale, setWholesale] = useState(false)
  const [variants, setVariants] = useState('')
  const [list, setList] = useState('')
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState('')
  const [added, setAdded] = useState(0)
  const variantsRef = useRef<HTMLTextAreaElement>(null)

  const sameName = (a: string, b: string) => norm(a) === norm(b)
  const exists = (n: string, c: string) => all.some(p => String(p.category_id) === c && sameName(p.name, n))
  const dup = !!name.trim() && !!cat && exists(name, cat)
  const vItems = parseLines(variants)
  const lItems = parseLines(list)

  const createProduct = (n: string, p: number | null) => api('/api/admin/products', { method: 'POST',
    body: JSON.stringify({ name: n, category_id: +cat, price: p, wholesale_enabled: wholesale }) })

  const submitOne = async () => {
    const n = name.trim()
    if (!n || !cat) return onNotify('Укажите название и категорию', 'err')
    if (exists(n, cat)) return onNotify(`«${n}» уже есть в этой категории`, 'err')
    // Внутри одного списка дубли вкусов не добавляем.
    const seen = new Set<string>(); const todo = vItems.filter(v => { const k = norm(v.name); if (seen.has(k)) return false; seen.add(k); return true })
    setBusy(true); setProgress('Создаём товар…')
    let id: string
    try { id = (await createProduct(n, toNum(price))).id }
    catch (e: any) { setBusy(false); setProgress(''); return onNotify('Товар не создан: ' + e.message, 'err') }

    const failed: string[] = []
    for (let i = 0; i < todo.length; i++) {
      setProgress(`Вкус ${i + 1} из ${todo.length}`)
      try { await api(`/api/admin/products/${id}/variants`, { method: 'POST', body: JSON.stringify({ name: todo[i].name, price: todo[i].price }) }) }
      catch { failed.push(todo[i].raw) }
    }
    setBusy(false); setProgress(''); setAdded(a => a + 1); onRefresh()
    if (failed.length) { setVariants(failed.join('\n')); onNotify(`«${n}» создан, вкусов не добавлено: ${failed.length}`, 'err') }
    else { setVariants(''); onNotify(`«${n}» добавлен${todo.length ? `, вкусов: ${todo.length}` : ''}`) }
    setName(''); setPrice('')
  }

  const submitList = async () => {
    if (!cat) return onNotify('Выберите категорию', 'err')
    const seen = new Set<string>(); const todo: typeof lItems = []; let skipped = 0
    for (const it of lItems) { const k = norm(it.name); if (exists(it.name, cat) || seen.has(k)) skipped++; else { seen.add(k); todo.push(it) } }
    if (!todo.length) return onNotify(skipped ? 'Все товары из списка уже есть' : 'Список пуст', 'err')
    setBusy(true)
    const failed: string[] = []; let ok = 0
    for (let i = 0; i < todo.length; i++) {
      setProgress(`${i + 1} из ${todo.length}`)
      try { await createProduct(todo[i].name, todo[i].price); ok++ } catch { failed.push(todo[i].raw) }
    }
    setBusy(false); setProgress(''); setAdded(a => a + ok); onRefresh()
    setList(failed.join('\n'))
    const extra = (skipped ? `, уже были: ${skipped}` : '')
    if (failed.length) onNotify(`Добавлено ${ok}, не удалось: ${failed.length}${extra}`, 'err')
    else onNotify(`Добавлено товаров: ${ok}${extra}`)
  }

  return (<Sheet onClose={onClose}>
    <h2 className="mv-sheet-title">Добавить товары</h2>
    <div className="mv-sub">Добавлено за сеанс: {added}</div>
    <div className="mv-seg" style={{ margin: '12px 0' }}>
      <button className={mode === 'one' ? 'on' : ''} onClick={() => setMode('one')}>Один товар</button>
      <button className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>Списком</button>
    </div>
    <div className="mv-col" style={{ gap: 10 }}>
      <label className="mv-label">Категория (запоминается для следующих товаров)</label>
      <select className="mv-input" value={cat} onChange={e => setCat(e.target.value)}>
        <option value="">Выберите категорию</option>{cats.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <label className="mv-check"><input type="checkbox" checked={wholesale} onChange={e => setWholesale(e.target.checked)} />Суммируется для оптовых цен</label>

      {mode === 'one' ? <>
        <label className="mv-label">Название</label>
        <input className="mv-input" autoFocus placeholder="Например, Elfliq Mint" value={name} enterKeyHint="next"
          onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); variantsRef.current?.focus() } }} />
        {dup && <div style={{ color: 'var(--warning)', fontSize: 13 }}>Такой товар уже есть в этой категории</div>}
        <label className="mv-label">Цена, € (необязательно: пусто — товар не продаётся)</label>
        <input className="mv-input" inputMode="decimal" placeholder="например 6,50" value={price} onChange={e => setPrice(e.target.value)} />
        <label className="mv-label">Вкусы: по одному в строке. Цену можно указать через «;»</label>
        <textarea ref={variantsRef} className="mv-input mv-area" placeholder={'Mint\nGrape; 5\nWatermelon'} value={variants} onChange={e => setVariants(e.target.value)} />
        <div className="mv-sub">Вкусов в списке: {vItems.length}</div>
        <button className="mv-btn" disabled={busy || !name.trim() || !cat || dup} onClick={submitOne}>
          {busy ? progress : `Добавить товар${vItems.length ? ` и ${vItems.length} вкус(ов)` : ''}`}</button>
      </> : <>
        <label className="mv-label">Одна строка — один товар. Цену можно указать через «;»</label>
        <textarea className="mv-input mv-area" placeholder={'Elfliq Mint; 6\nElfliq Grape; 6\nAspire Nautilus'} value={list} onChange={e => setList(e.target.value)} />
        <div className="mv-sub">Товары с таким же названием в категории пропускаются. Строки, которые не получилось добавить, остаются в поле.</div>
        <button className="mv-btn" disabled={busy || !cat || !lItems.length} onClick={submitList}>
          {busy ? progress : `Добавить ${lItems.length} товар(ов)`}</button>
      </>}
    </div>
  </Sheet>)
}

function ProductSheet({ product, owner, catName, onClose, actions }: any) {
  const [price, setPrice] = useState(product.price == null ? '' : String(product.price))
  const [cost, setCost] = useState(product.cost_price == null ? '' : String(product.cost_price))
  const [active, setActive] = useState(!!product.active)
  const [refEx, setRefEx] = useState(!!product.referral_excluded)
  const [tiers, setTiers] = useState<any[]>((product.tiers || []).map((t: any) => ({ min: t.min, max: t.max, price: String(t.price) })))
  const [newVars, setNewVars] = useState('')
  const [vp, setVp] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)
  const num = toNum
  const tierLbl = (t: any) => (t.min === t.max ? `${t.min} шт.` : `${t.min}–${t.max} шт.`)
  const variants: any[] = product.variants || []
  const run = async (fn: () => Promise<any>) => { setSaving(true); try { return await fn() } finally { setSaving(false) } }

  const savePrices = () => run(async () => {
    const ok = await actions.onSavePrices({ price: num(price), cost_price: num(cost) })
    if (ok && active !== !!product.active) await actions.onSaveProduct({ active })
    if (ok && refEx !== !!product.referral_excluded) await actions.onSaveProduct({ referral_excluded: refEx })
  })
  const saveTiers = () => run(() => actions.onSaveTiers(tiers.map(t => ({ min: t.min, price: num(t.price) ?? -1 }))))
  // Несколько вкусов сразу: дубли (уже есть в товаре или повтор в списке) пропускаются.
  const addVariants = () => run(async () => {
    const have = new Set(variants.map(v => norm(v.name)))
    const todo: any[] = []; let skipped = 0
    for (const it of parseLines(newVars)) { const k = norm(it.name); if (have.has(k)) skipped++; else { have.add(k); todo.push(it) } }
    const failed: string[] = await actions.onAddVariants(todo, skipped)
    setNewVars(failed.join('\n'))
  })
  const saveVariant = (v: any) => run(async () => {
    if (await actions.onVariantPrice(v.id, num(vp[v.id] ?? ''))) setVp(s => { const n = { ...s }; delete n[v.id]; return n })
  })
  const parsedCount = parseLines(newVars).length

  return (<Sheet onClose={onClose}>
    <h2 className="mv-sheet-title">{product.name}</h2>
    <div className="mv-sub" style={{ marginBottom: 12 }}>{catName} · {variants.length} вариантов</div>
    {!owner && <div className="mv-note">Изменения доступны владельцу. Цены показаны для справки.</div>}

    <div className="mv-section">
      <h3>Цены</h3>
      <label className="mv-label">Розничная цена, € (пусто = товар не продаётся)</label>
      <input className="mv-input" type="text" inputMode="decimal" disabled={!owner} value={price} onChange={e => setPrice(e.target.value)} />
      {owner && <>
        <label className="mv-label">Себестоимость, € (видит только владелец)</label>
        <input className="mv-input" type="text" inputMode="decimal" value={cost} onChange={e => setCost(e.target.value)} />
        <label className="mv-check"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Товар активен (выключите — уйдёт из продажи, не удаляясь)</label>
        <label className="mv-check"><input type="checkbox" checked={refEx} onChange={e => setRefEx(e.target.checked)} />Не участвует в акции «Приведи друга» (не засчитывается как покупка и не выдаётся бонусом)</label>
        <button className="mv-btn" disabled={saving} onClick={savePrices}>Сохранить цены</button>
      </>}
    </div>

    <div className="mv-section">
      <h3>Оптовые цены</h3>
      <div className="mv-sub">Ступень считается по общему количеству единиц в заказе. 50+ — по согласованию.</div>
      {tiers.map((t, i) => (
        <div key={i} className="mv-kv"><span>{tierLbl(t)}</span>
          <input className="mv-input sm mv-w-110" type="text" inputMode="decimal" disabled={!owner} value={t.price}
            onChange={e => setTiers(ts => ts.map((x, k) => k === i ? { ...x, price: e.target.value } : x))} /></div>))}
      {owner && <button className="mv-btn ghost" disabled={saving} onClick={saveTiers}>Сохранить ступени</button>}
    </div>

    <div className="mv-section">
      <h3>Вкусы и варианты · {variants.length}</h3>
      {variants.map((v: any) => {
        const cur = v.price == null ? '' : String(v.price)
        const draft = vp[v.id] ?? cur
        return (<div key={v.id} className="mv-var">
          <span className="mv-trunc">{v.name}</span>
          {owner ? <div className="mv-row" style={{ gap: 6, flexShrink: 0 }}>
            <input className="mv-input sm" style={{ width: 100, textAlign: 'right' }} type="text" inputMode="decimal" placeholder={product.price == null ? 'цена' : String(product.price)}
              value={draft} onChange={e => setVp({ ...vp, [v.id]: e.target.value })} />
            {draft !== cur && <button className="mv-btn sm" disabled={saving} onClick={() => saveVariant(v)}>Сохранить</button>}
          </div> : <span className="mv-sub">{v.price == null ? '—' : eur(+v.price)}</span>}
        </div>)
      })}
      {owner && <div className="mv-col" style={{ marginTop: 6 }}>
        <label className="mv-label">Новые вкусы: по одному в строке, цену можно через «;»</label>
        <textarea className="mv-input mv-area" placeholder={'Mint\nGrape; 5'} value={newVars} onChange={e => setNewVars(e.target.value)} />
        <button className="mv-btn ghost" disabled={!parsedCount || saving} onClick={addVariants}>
          {saving ? 'Добавляем…' : `Добавить ${parsedCount ? parsedCount + ' вкус(ов)' : 'вкусы'}`}</button>
      </div>}
    </div>
  </Sheet>)
}

// ============================ ОПТОВЫЕ ЦЕНЫ ============================
export function PricesSection({ role, catalog, onNotify, onRefresh }: Props) {
  const [search, setSearch] = useState(''), [cat, setCat] = useState(''), [openId, setOpenId] = useState<string | null>(null)
  const owner = role === 'owner'
  const cats = catalog?.categories || []
  const all: any[] = (catalog?.products || []).filter((p: any) => p.active)
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || '—'
  const { shown, counts } = filterProducts(all, cats, search, cat)
  const openProduct = all.find(p => p.id === openId) || null
  const fmt = (n: any) => Number(n).toFixed(2).replace('.', ',') + ' €'
  return (<>
    <h1 className="mv-h1">Оптовые цены</h1>
    <div className="mv-sub" style={{ margin: '4px 0 0' }}>Ступень выбирается по общему количеству единиц в заказе.</div>
    <div className="mv-toolbar"><div className="mv-col">
      <SearchField value={search} onChange={setSearch} placeholder="Товар или вкус" />
      <CategoryChips cats={cats} value={cat} onChange={setCat} counts={counts} allCount={all.length} />
    </div></div>

    <div className="mv-col" style={{ gap: 8, marginTop: 10 }}>{shown.map(({ p, m }) => (
      <button key={p.id} className="mv-card tap mv-tap" onClick={() => setOpenId(p.id)}>
        <div className="mv-row mv-between"><b className="mv-trunc">{p.name}</b><span className="mv-sub" style={{ flexShrink: 0 }}>{catName(p.category_id)}</span></div>
        <div className="mv-sub" style={{ marginTop: 4 }}>{(p.tiers || []).map((t: any) => `${t.min}–${t.max}: ${fmt(t.price)}`).join(' · ') || 'ступени не заданы'}</div>
        {m.flavors.length > 0 && <div className="mv-match">Вкус: {m.flavors.slice(0, 3).join(', ')}</div>}
      </button>))}</div>
    {!shown.length && <Empty icon={Icon.tag(30)} title="Ничего не найдено" />}

    {openProduct && <ProductSheet key={openProduct.id} product={openProduct} owner={owner} catName={catName(openProduct.category_id)}
      onClose={() => setOpenId(null)} actions={productActions(onNotify, onRefresh, openProduct.id)} />}
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
