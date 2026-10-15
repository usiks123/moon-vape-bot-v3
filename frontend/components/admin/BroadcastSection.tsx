'use client'
import { useState } from 'react'
import { Notify, adminApi as api } from '@/lib/shared'
import { Confirm } from '../ui'
import { CategoryChips, SearchField, countByCategory, matchProduct } from './Filters'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; catalog: any; onNotify: Notify }
type Mode = 'products' | 'categories' | 'new'

const plain = (html: string) => html.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

// Рассылка только вручную: предпросмотр → подтверждение → отправка. Автоматики при изменении остатков нет.
export default function BroadcastSection({ role, cityId, cities, catalog, onNotify }: Props) {
  const [city, setCity] = useState(role === 'city_admin' ? (cityId || '') : (cities[0]?.id || ''))
  const [mode, setMode] = useState<Mode>('new')
  const [pick, setPick] = useState<string[]>([])
  const [preview, setPreview] = useState<any>(null)
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [search, setSearch] = useState(''), [cat, setCat] = useState('')

  const products = (catalog?.products || []).filter((p: any) => p.active)
  const cats = catalog?.categories || []
  const cityName = cities.find(c => c.id === city)?.name || ''
  const catName = (id: number) => cats.find((c: any) => c.id === id)?.name || ''
  const counts = countByCategory(products)
  const shownProducts = products
    .map((p: any) => ({ p, m: matchProduct(p, catName(p.category_id), search) }))
    .filter(x => x.m.ok && (!cat || String(x.p.category_id) === cat))

  const changeMode = (m: Mode) => { setMode(m); setPick([]); setPreview(null) }
  const togglePick = (id: string) => { setPick(p => p.includes(id) ? p.filter(x => x !== id) : [...p, id]); setPreview(null) }

  const doPreview = async () => {
    setBusy(true); setPreview(null); setResult(null)
    const qs = new URLSearchParams({ mode, city })
    if (mode !== 'new') { if (!pick.length) { setBusy(false); return onNotify('Выберите хотя бы один пункт', 'err') }; qs.set(mode === 'products' ? 'product_ids' : 'category_ids', pick.join(',')) }
    try { setPreview(await api('/api/admin/broadcast/preview?' + qs.toString())) }
    catch (e: any) { onNotify(e.message, 'err') } finally { setBusy(false) }
  }

  const send = async () => {
    setConfirm(false); setBusy(true)
    try {
      const r = await api('/api/admin/broadcasts', { method: 'POST', body: JSON.stringify({
        city_id: city, mode, product_ids: mode === 'products' ? pick : [], category_ids: mode === 'categories' ? pick.map(Number) : [],
        text_hash: preview.text_hash, idempotency_key: key }) })
      onNotify('Рассылка запущена'); setPreview(null); setKey(crypto.randomUUID())
      for (let i = 0; i < 20; i++) {
        const s = await api('/api/admin/broadcasts/' + r.id); setResult(s)
        if (s.pending === 0) break
        await new Promise(res => setTimeout(res, 3000))
      }
    } catch (e: any) { onNotify('Не отправлено: ' + e.message, 'err') } finally { setBusy(false) }
  }

  return (<>
    <h1 className="mv-h1">Оповещение о наличии</h1>
    <div className="mv-sub" style={{ margin: '4px 0 12px' }}>Сообщение уходит только по вашей команде. Пользователям, которые выбрали этот город и разрешили уведомления.</div>
    {role === 'owner' && <select className="mv-input sm" style={{ marginBottom: 10 }} value={city} onChange={e => { setCity(e.target.value); setPreview(null) }}>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <div className="mv-seg" style={{ marginBottom: 12 }}>{([['new', 'Новое поступление'], ['products', 'Товары'], ['categories', 'Категории']] as [Mode, string][]).map(([k, l]) =>
      <button key={k} className={mode === k ? 'on' : ''} onClick={() => changeMode(k)}>{l}</button>)}</div>

    {mode === 'new' && <div className="mv-sub" style={{ marginBottom: 12 }}>Товары, поступившие в {cityName} после последней рассылки этого города (или за 7 дней).</div>}
    {mode === 'products' && <div className="mv-col" style={{ marginBottom: 12 }}>
      <SearchField value={search} onChange={setSearch} placeholder="Товар или вкус…" />
      <CategoryChips cats={cats} value={cat} onChange={setCat} counts={counts} allCount={products.length} />
      <div className="mv-col" style={{ gap: 6, maxHeight: 360, overflowY: 'auto' }}>{shownProducts.map(({ p, m }: any) =>
        <button key={p.id} className={'mv-chip mv-tap' + (pick.includes(p.id) ? ' on' : '')} onClick={() => togglePick(p.id)}>
          <span>{p.name}{m.flavors.length ? ` · ${m.flavors.slice(0, 2).join(', ')}` : ''}</span>{pick.includes(p.id) && <b>✓</b>}</button>)}</div>
    </div>}
    {mode === 'categories' && <div className="mv-flavors" style={{ marginBottom: 12 }}>{cats.map((c: any) =>
      <button key={c.id} className={'mv-chip' + (pick.includes(String(c.id)) ? ' on' : '')} onClick={() => togglePick(String(c.id))}><span>{c.name}</span></button>)}</div>}

    <button className="mv-btn ghost" disabled={busy} onClick={doPreview}>Показать предпросмотр</button>

    {preview && <div className="mv-card" style={{ marginTop: 14 }}>
      <div className="mv-city-tag">{cityName.toUpperCase()}</div>
      <div style={{ whiteSpace: 'pre-wrap', fontSize: 14, lineHeight: 1.5, margin: '8px 0 12px' }}>{plain(preview.text)}</div>
      <div className="mv-sub" style={{ marginBottom: 10 }}>Получателей: {preview.recipients}. Включено товаров: {preview.items.length}. Нулевые остатки в текст не попадают.</div>
      <button className="mv-btn" disabled={busy || preview.recipients === 0} onClick={() => setConfirm(true)}>
        {preview.recipients === 0 ? 'Нет получателей' : `Отправить ${preview.recipients} получателям`}</button>
    </div>}

    {result && <div className="mv-card" style={{ marginTop: 14 }}>
      <b>Результат рассылки #{result.id}</b>
      <div className="mv-grid2" style={{ marginTop: 10 }}>
        <div className="mv-stat"><div className="l">Отправлено</div><div className="v">{result.sent}</div></div>
        <div className="mv-stat"><div className="l">Ошибки</div><div className="v">{result.failed}</div></div>
      </div>
      <div className="mv-sub" style={{ marginTop: 8 }}>В очереди: {result.pending}. Ошибки — пользователи, заблокировавшие бота, и временные сбои Telegram.</div>
    </div>}

    {confirm && preview && <Confirm title="Отправить рассылку?" text={`Город: ${cityName}. Получателей: ${preview.recipients}. Отмена после отправки невозможна.`} ok="Отправить" onOk={send} onCancel={() => setConfirm(false)} />}
  </>)
}
