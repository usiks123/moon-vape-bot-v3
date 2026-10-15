'use client'
import { useEffect, useState } from 'react'
import { Notify, adminApi as api } from '@/lib/shared'
import { Confirm, Empty, Icon, Loading, Sheet } from '../ui'
import { BrandChips, CategoryChips, SearchField, brandOf, countByCategory, matchText } from './Filters'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; catalog: any; onNotify: Notify; onRefresh: () => void }
type Status = 'all' | 'in' | 'low' | 'out'
type Mode = 'view' | 'receipt' | 'bulk'

const OP: Record<string, string> = { receipt: 'Поступление', writeoff: 'Продажа (выдача)', reserve: 'Резерв под заказ', release: 'Снятие резерва', adjust: 'Корректировка', transfer: 'Перемещение' }
const MODES: [Mode, string][] = [['view', 'Просмотр'], ['receipt', 'Приёмка'], ['bulk', 'Массовое']]

// Остатки храним отдельно по каждому городу: изменение в одном городе не трогает другой.
export default function InventorySection({ role, cityId, cities, catalog, onNotify }: Props) {
  const [city, setCity] = useState<string>(role === 'city_admin' ? (cityId || '') : (cities[0]?.id || ''))
  const [rows, setRows] = useState<any[] | null>(null)
  const [search, setSearch] = useState(''), [cat, setCat] = useState(''), [brand, setBrand] = useState(''), [status, setStatus] = useState<Status>('all')
  const [mode, setMode] = useState<Mode>('view'), [reason, setReason] = useState('')
  const [bulk, setBulk] = useState<Record<string, number>>({})
  const [confirmBulk, setConfirmBulk] = useState(false), [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<{ row: any; items: any[] } | null>(null)
  const [transfer, setTransfer] = useState<any>(null)

  const cats = catalog?.categories || []
  const catName = (id: any) => cats.find((c: any) => String(c.id) === String(id))?.name || ''
  const other = cities.filter(c => c.id !== city)
  const cityName = cities.find(c => c.id === city)?.name || ''

  const fetchRows = (c: string) => api(`/api/admin/inventory?city=${c}`).then(setRows)
    .catch(e => onNotify('Не удалось загрузить наличие: ' + e.message, 'err'))
  useEffect(() => { setBulk({}); setRows(null); if (city) fetchRows(city) }, [city])

  // Локальное обновление строки: список не перезагружается и не мигает.
  const setLocal = (id: string, qty: number) =>
    setRows(rs => (rs || []).map(r => r.inventory_id === id ? { ...r, quantity: qty, available: qty - r.reserved } : r))
  const writeStock = (id: string, qty: number, prev: number, why: string) => api('/api/admin/inventory', { method: 'POST',
    body: JSON.stringify({ inventory_id: id, quantity: qty, kind: qty > prev ? 'receipt' : 'adjust', reason: why }) })

  const save = async (row: any, qty: number) => {
    if (qty === row.quantity || qty < 0) return
    setLocal(row.inventory_id, qty)
    try { await writeStock(row.inventory_id, qty, row.quantity, reason.trim()) }
    catch (e: any) { setLocal(row.inventory_id, row.quantity); onNotify('Не сохранено: ' + e.message, 'err') }
  }

  const changes: { row: any; qty: number }[] = Object.entries(bulk).flatMap(([id, qty]: [string, number]) => {
    const row = rows?.find(r => r.inventory_id === id)
    return row && row.quantity !== qty ? [{ row, qty }] : []
  })

  const saveBulk = async () => {
    setConfirmBulk(false); setBusy(true)
    let ok = 0
    try {
      for (const { row, qty } of changes) { await writeStock(row.inventory_id, qty, row.quantity, reason.trim()); setLocal(row.inventory_id, qty); ok++ }
      setBulk({}); setMode('view'); onNotify(`Обновлено позиций: ${ok}`)
    } catch (e: any) {
      onNotify(`Сохранено ${ok} из ${changes.length}. Ошибка: ${e.message}`, 'err'); fetchRows(city)
    } finally { setBusy(false) }
  }

  const openHistory = async (row: any) => {
    try { setHistory({ row, items: await api(`/api/admin/inventory/${row.inventory_id}/history?limit=50`) }) }
    catch (e: any) { onNotify('Журнал недоступен: ' + e.message, 'err') }
  }

  const all = rows || []
  const counts = countByCategory(all)
  const brandCounts: Record<string, number> = {}
  all.forEach(r => { const b = brandOf(r.product_name) || 'other'; brandCounts[b] = (brandCounts[b] || 0) + 1 })
  const statusOk = (r: any, s: Status) => s === 'all' || (s === 'in' ? r.available > 0 : s === 'out' ? r.available <= 0 : r.available > 0 && r.available <= 2)
  const statusCount: Record<Status, number> = { all: all.length, in: all.filter(r => statusOk(r, 'in')).length, low: all.filter(r => statusOk(r, 'low')).length, out: all.filter(r => statusOk(r, 'out')).length }
  const shown = all
    .filter(r => (!cat || String(r.category_id) === cat) && (!brand || (brand === 'other' ? !brandOf(r.product_name) : brandOf(r.product_name) === brand)) && statusOk(r, status) && matchText(search, r.product_name, r.variant_name, catName(r.category_id)))
    .sort((a, b) => `${a.product_name}${a.variant_name || ''}`.localeCompare(`${b.product_name}${b.variant_name || ''}`))

  return (<>
    <h1 className="mv-h1">Наличие</h1>
    {role === 'owner' && <select className="mv-input" style={{ marginTop: 8 }} value={city} onChange={e => setCity(e.target.value)}>
      {cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <div className="mv-seg" style={{ margin: '10px 0' }}>{MODES.map(([k, l]) =>
      <button key={k} className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setBulk({}) }}>{l}</button>)}</div>
    {mode !== 'view' && <input className="mv-input" style={{ marginBottom: 10 }} placeholder="Причина (попадёт в журнал)" value={reason} onChange={e => setReason(e.target.value)} />}

    <div className="mv-toolbar"><div className="mv-col">
      <SearchField value={search} onChange={setSearch} placeholder="Товар или вкус, например «mint»" />
      <CategoryChips cats={cats} value={cat} onChange={setCat} counts={counts} allCount={all.length} />
      <BrandChips value={brand} onChange={setBrand} counts={brandCounts} allCount={all.length} />
      <div className="mv-chips">{([['all', 'Все'], ['in', 'В наличии'], ['low', 'Мало'], ['out', 'Нет']] as [Status, string][]).map(([k, l]) =>
        <button key={k} className={'mv-pill' + (status === k ? ' on' : '')} onClick={() => setStatus(k)}>{l}<em>{statusCount[k]}</em></button>)}</div>
    </div></div>

    <div className="mv-count">{cityName ? `${cityName} · ` : ''}показано {shown.length} из {all.length}</div>
    {rows === null && <Loading />}
    <div className="mv-col">{shown.map(row => (
      <InvRow key={row.inventory_id} row={row} mode={mode} busy={busy} bulkQty={bulk[row.inventory_id] ?? row.quantity}
        onBulk={q => setBulk(b => ({ ...b, [row.inventory_id]: q }))} onSave={q => save(row, q)} onHistory={() => openHistory(row)}
        onTransfer={role === 'owner' && other.length ? () => setTransfer({ row, to: other[0].id, qty: 1 }) : undefined} />))}</div>
    {rows && !shown.length && <Empty icon={Icon.search(30)} title="Ничего не найдено" text={search || cat || brand || status !== 'all' ? 'Измените фильтр или запрос' : undefined} />}

    {mode === 'bulk' && changes.length > 0 && <div className="mv-sticky"><button className="mv-btn" disabled={busy} onClick={() => setConfirmBulk(true)}>Сохранить изменения ({changes.length})</button></div>}
    {confirmBulk && <Confirm title={`Сохранить ${changes.length} изменений?`} text={`Остатки ${cityName} будут обновлены, каждое изменение попадёт в журнал.`} ok="Сохранить" onOk={saveBulk} onCancel={() => setConfirmBulk(false)} />}

    {history && <Sheet onClose={() => setHistory(null)}>
      <h3 className="mv-sheet-title" style={{ fontSize: 18 }}>Журнал: {history.row.product_name}</h3>
      <div className="mv-sub" style={{ marginBottom: 12 }}>{history.row.variant_name || 'Стандарт'} · {cityName}</div>
      {!history.items.length && <div className="mv-sub">Операций пока не было</div>}
      <div className="mv-col" style={{ gap: 8, paddingBottom: 8 }}>{history.items.map((t: any, i: number) => (
        <div key={i} className="mv-card" style={{ padding: 10, fontSize: 13 }}>
          <div className="mv-row mv-between"><b>{OP[t.op] || t.op}</b><span>{t.qty_before} → {t.qty_after}</span></div>
          <div className="mv-sub">{new Date(t.created_at).toLocaleString('ru-RU')}{t.reason ? ' · ' + t.reason : ''}</div>
        </div>))}</div>
    </Sheet>}

    {transfer && <Sheet onClose={() => setTransfer(null)}>
      <h3 className="mv-sheet-title" style={{ fontSize: 18 }}>Перемещение между городами</h3>
      <div className="mv-sub" style={{ marginBottom: 12 }}>{transfer.row.product_name} · {transfer.row.variant_name || 'Стандарт'}. Себестоимость сохраняется.</div>
      <div className="mv-col" style={{ gap: 10 }}>
        <select className="mv-input" value={transfer.to} onChange={e => setTransfer({ ...transfer, to: e.target.value })}>{other.map(c => <option key={c.id} value={c.id}>В {c.name}</option>)}</select>
        <input className="mv-input" type="number" min={1} inputMode="numeric" value={transfer.qty} onChange={e => setTransfer({ ...transfer, qty: Math.max(1, Math.floor(+e.target.value || 1)) })} />
        <div className="mv-sub">Доступно в {cityName}: {transfer.row.available} шт.</div>
        <button className="mv-btn" disabled={busy || transfer.qty > transfer.row.available} onClick={async () => {
          setBusy(true)
          try {
            const target = (await api(`/api/admin/inventory?city=${transfer.to}`)).find((r: any) => r.product_id === transfer.row.product_id && (r.variant_name || '') === (transfer.row.variant_name || ''))
            if (!target) throw new Error('В городе назначения нет такой позиции')
            await api('/api/admin/transfers', { method: 'POST', body: JSON.stringify({ from_inventory_id: transfer.row.inventory_id, to_inventory_id: target.inventory_id, quantity: transfer.qty, reason: reason.trim() }) })
            onNotify('Перемещение выполнено'); setTransfer(null); fetchRows(city)
          } catch (e: any) { onNotify('Перемещение не выполнено: ' + e.message, 'err') } finally { setBusy(false) }
        }}>Переместить</button>
      </div>
    </Sheet>}
  </>)
}

function InvRow({ row, mode, busy, bulkQty, onBulk, onSave, onHistory, onTransfer }: any) {
  const label = row.variant_name || 'Стандарт'
  const color = row.available <= 0 ? 'var(--danger)' : row.available <= 2 ? 'var(--warning)' : 'var(--success)'
  const [draft, setDraft] = useState(String(row.quantity))
  useEffect(() => setDraft(String(row.quantity)), [row.quantity])
  const commit = () => { const n = Math.max(0, Math.floor(+draft)); if (Number.isFinite(n) && n !== row.quantity) onSave(n); else setDraft(String(row.quantity)) }
  const head = <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 15 }} className="mv-trunc">{row.product_name}</div>
    <div className="mv-sub mv-trunc">{label} · доступно <b style={{ color }}>{row.available}</b>{row.reserved > 0 ? ` · резерв ${row.reserved}` : ''}{row.price == null ? ' · цена не задана' : ''}</div></div>

  if (mode === 'bulk') return <div className="mv-card mv-row" style={{ padding: 12 }}>{head}
    <input type="number" min={0} inputMode="numeric" className="mv-input sm" style={{ width: 84, textAlign: 'center', borderColor: bulkQty !== row.quantity ? 'var(--accent)' : undefined }}
      value={bulkQty} onChange={e => onBulk(Math.max(0, Math.floor(+e.target.value || 0)))} /></div>
  if (mode === 'receipt') return (
    <div className="mv-card" style={{ padding: 12 }}><div className="mv-row">{head}<span className="mv-price" style={{ color }}>{row.quantity}</span></div>
      <div className="mv-row" style={{ marginTop: 10, gap: 8 }}>{[1, 5, 10, 50].map(n => <button key={n} className="mv-btn ghost" style={{ flex: 1, padding: 0, minHeight: 44 }} onClick={() => onSave(row.quantity + n)}>+{n}</button>)}</div></div>)
  return (
    <div className="mv-card" style={{ padding: 12 }}>
      <div className="mv-row">{head}
        <div className="mv-qty"><button aria-label="Минус" disabled={busy || row.quantity === 0} onClick={() => onSave(Math.max(0, row.quantity - 1))}>{Icon.minus(16)}</button>
          <input type="number" min={0} inputMode="numeric" className="mv-input sm" style={{ width: 60, padding: 0, textAlign: 'center', fontWeight: 800, color }} value={draft}
            onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <button aria-label="Плюс" disabled={busy} onClick={() => onSave(row.quantity + 1)}>{Icon.plus(16)}</button></div></div>
      <div className="mv-row" style={{ marginTop: 6, justifyContent: 'flex-end', gap: 6 }}>
        <button className="mv-link" onClick={onHistory}>Журнал</button>
        {onTransfer && <button className="mv-link" onClick={onTransfer}>Переместить</button>}
      </div>
    </div>)
}
