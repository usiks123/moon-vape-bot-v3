'use client'
import { useEffect, useMemo, useState } from 'react'
import { Notify, adminApi as api } from '@/lib/shared'
import { Confirm, Empty, Icon, Loading, Sheet } from '../ui'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; onNotify: Notify; onRefresh: () => void }

// Остатки храним отдельно по каждому городу: изменение в одном городе не трогает другой.
export default function InventorySection({ role, cityId, cities, onNotify }: Props) {
  const [city, setCity] = useState<string>(role === 'city_admin' ? (cityId || '') : (cities[0]?.id || ''))
  const [rows, setRows] = useState<any[] | null>(null)
  const [search, setSearch] = useState(''), [filter, setFilter] = useState('all'), [mode, setMode] = useState('view')
  const [reason, setReason] = useState('')
  const [bulk, setBulk] = useState<Record<string, number>>({})
  const [confirmBulk, setConfirmBulk] = useState(false), [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<{ row: any; items: any[] } | null>(null)
  const [transfer, setTransfer] = useState<any>(null)

  const load = () => {
    if (!city) return
    setRows(null)
    api(`/api/admin/inventory?city=${city}`).then(setRows).catch(e => onNotify('Не удалось загрузить наличие: ' + e.message, 'err'))
  }
  useEffect(() => { setBulk({}); load() }, [city])

  // kind: receipt — поступление (только увеличение); adjust — ручная корректировка. Пишется в журнал.
  const save = async (row: any, qty: number) => {
    if (busy) return
    setBusy(true)
    const kind = qty > row.quantity ? 'receipt' : 'adjust'
    try {
      await api('/api/admin/inventory', { method: 'POST', body: JSON.stringify({ inventory_id: row.inventory_id, quantity: qty, kind, reason: reason.trim() }) })
      onNotify('Наличие обновлено'); load()
    } catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err'); load() } finally { setBusy(false) }
  }

  const saveBulk = async () => {
    setConfirmBulk(false); setBusy(true)
    const entries = Object.entries(bulk)
    let ok = 0
    try {
      for (const [id, qty] of entries) {
        const row = rows?.find(r => r.inventory_id === id)
        if (!row) continue
        const kind = qty > row.quantity ? 'receipt' : 'adjust'
        await api('/api/admin/inventory', { method: 'POST', body: JSON.stringify({ inventory_id: id, quantity: qty, kind, reason: reason.trim() }) })
        ok++
      }
      setBulk({}); setMode('view'); onNotify(`Обновлено позиций: ${ok}`)
    } catch (e: any) { onNotify(`Сохранено ${ok} из ${entries.length}. Ошибка: ${e.message}`, 'err') } finally { setBusy(false); load() }
  }

  const openHistory = async (row: any) => {
    try { setHistory({ row, items: await api(`/api/admin/inventory/${row.inventory_id}/history?limit=50`) }) }
    catch (e: any) { onNotify('Журнал недоступен: ' + e.message, 'err') }
  }

  const other = cities.filter(c => c.id !== city)
  const shown = useMemo(() => {
    let r = rows || []
    if (filter === 'in') r = r.filter(x => x.available > 0)
    else if (filter === 'out') r = r.filter(x => x.available <= 0)
    else if (filter === 'low') r = r.filter(x => x.available > 0 && x.available <= 2)
    if (search.trim()) { const q = search.toLowerCase(); r = r.filter(x => `${x.product_name} ${x.variant_name || ''}`.toLowerCase().includes(q)) }
    return [...r].sort((a, b) => `${a.product_name}${a.variant_name}`.localeCompare(`${b.product_name}${b.variant_name}`))
  }, [rows, filter, search])

  const cityName = cities.find(c => c.id === city)?.name || ''
  const nb = Object.keys(bulk).length

  return (<>
    <h1 className="mv-h1">Наличие</h1>
    {role === 'owner' && <select className="mv-input sm" style={{ margin: '8px 0 10px' }} value={city} onChange={e => setCity(e.target.value)}>
      {cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    <div className="mv-city-line" style={{ margin: '4px 0 12px' }}><span className="mv-city">{cityName.toUpperCase()}</span><span className="mv-sub">Остатки этого города</span></div>
    <div className="mv-seg" style={{ marginBottom: 12 }}>{[['view', 'Просмотр'], ['receipt', 'Приёмка'], ['bulk', 'Массовое']].map(([k, l]) =>
      <button key={k} className={mode === k ? 'on' : ''} onClick={() => { setMode(k); setBulk({}) }}>{l}</button>)}</div>
    <div className="mv-col" style={{ gap: 8, marginBottom: 12 }}>
      <input className="mv-input" placeholder="Поиск товара или вкуса…" value={search} onChange={e => setSearch(e.target.value)} />
      <div className="mv-grid2">
        <select className="mv-input sm" value={filter} onChange={e => setFilter(e.target.value)}>
          <option value="all">Все (включая нулевые)</option><option value="in">В наличии</option><option value="out">Нет в наличии</option><option value="low">Мало (1–2 шт)</option></select>
        <input className="mv-input sm" placeholder="Причина (в журнал)" value={reason} onChange={e => setReason(e.target.value)} />
      </div>
    </div>
    {rows === null && <Loading />}
    <div className="mv-col">{shown.map(row => (
      <InvRow key={row.inventory_id} row={row} mode={mode} busy={busy} bulkQty={bulk[row.inventory_id] ?? row.quantity}
        onBulk={q => setBulk(b => ({ ...b, [row.inventory_id]: q }))} onSave={q => save(row, q)} onHistory={() => openHistory(row)}
        onTransfer={role === 'owner' && other.length ? () => setTransfer({ row, to: other[0].id, qty: 1 }) : undefined} />))}</div>
    {rows && !shown.length && <Empty icon={Icon.search(30)} title="Ничего не найдено" />}
    {mode === 'bulk' && nb > 0 && <div className="mv-sticky"><button className="mv-btn" disabled={busy} onClick={() => setConfirmBulk(true)}>Сохранить изменения ({nb})</button></div>}
    {confirmBulk && <Confirm title={`Сохранить ${nb} изменений?`} text={`Остатки ${cityName} будут обновлены, каждое изменение попадёт в журнал.`} ok="Сохранить" onOk={saveBulk} onCancel={() => setConfirmBulk(false)} />}

    {history && <Sheet onClose={() => setHistory(null)}>
      <h3 style={{ margin: '16px 0 4px', fontWeight: 800 }}>Журнал: {history.row.product_name}</h3>
      <div className="mv-sub" style={{ marginBottom: 12 }}>{history.row.variant_name || 'Стандарт'} · {cityName}</div>
      {!history.items.length && <div className="mv-sub">Операций пока не было</div>}
      <div className="mv-col" style={{ gap: 8, paddingBottom: 8 }}>{history.items.map((t: any, i: number) => (
        <div key={i} className="mv-card" style={{ padding: 10, fontSize: 13 }}>
          <div className="mv-row mv-between"><b>{OP[t.op] || t.op}</b><span>{t.qty_before} → {t.qty_after}</span></div>
          <div className="mv-sub">{new Date(t.created_at).toLocaleString('ru-RU')}{t.reason ? ' · ' + t.reason : ''}</div>
        </div>))}</div>
    </Sheet>}

    {transfer && <Sheet onClose={() => setTransfer(null)}>
      <h3 style={{ margin: '16px 0 4px', fontWeight: 800 }}>Перемещение между городами</h3>
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
            onNotify('Перемещение выполнено'); setTransfer(null); load()
          } catch (e: any) { onNotify('Перемещение не выполнено: ' + e.message, 'err') } finally { setBusy(false) }
        }}>Переместить</button>
      </div>
    </Sheet>}
  </>)
}

const OP: Record<string, string> = { receipt: 'Поступление', writeoff: 'Продажа (выдача)', reserve: 'Резерв под заказ', release: 'Снятие резерва', return: 'Возврат', adjust: 'Корректировка', transfer: 'Перемещение' }

function InvRow({ row, mode, busy, bulkQty, onBulk, onSave, onHistory, onTransfer }: any) {
  const label = row.variant_name || 'Стандарт'
  const color = row.available <= 0 ? 'var(--danger)' : row.available <= 2 ? 'var(--warning)' : 'var(--success)'
  const [draft, setDraft] = useState(String(row.quantity))
  useEffect(() => setDraft(String(row.quantity)), [row.quantity])
  const commit = () => { const n = Math.max(0, Math.floor(+draft)); if (Number.isFinite(n) && n !== row.quantity) onSave(n); else setDraft(String(row.quantity)) }
  const head = <div className="mv-grow"><div style={{ fontWeight: 800, fontSize: 14 }} className="mv-trunc">{row.product_name}</div>
    <div className="mv-sub mv-trunc">{label} · доступно {row.available}{row.reserved > 0 ? ` · резерв ${row.reserved}` : ''}{row.price == null ? ' · цена не задана' : ''}</div></div>

  if (mode === 'bulk') return <div className="mv-card mv-row" style={{ padding: 12 }}>{head}
    <input type="number" min={0} inputMode="numeric" className="mv-input sm" style={{ width: 76, textAlign: 'center', borderColor: bulkQty !== row.quantity ? 'var(--accent)' : undefined }}
      value={bulkQty} onChange={e => onBulk(Math.max(0, Math.floor(+e.target.value || 0)))} /></div>
  if (mode === 'receipt') return (
    <div className="mv-card" style={{ padding: 12 }}><div className="mv-row">{head}<span className="mv-price" style={{ color }}>{row.quantity}</span></div>
      <div className="mv-row" style={{ marginTop: 10 }}>{[1, 5, 10, 50].map(n => <button key={n} disabled={busy} className="mv-btn ghost sm" style={{ flex: 1, padding: 0 }} onClick={() => onSave(row.quantity + n)}>+{n}</button>)}</div></div>)
  return (
    <div className="mv-card" style={{ padding: 12 }}>
      <div className="mv-row">{head}
        <div className="mv-qty"><button disabled={busy || row.quantity === 0} onClick={() => onSave(Math.max(0, row.quantity - 1))}>{Icon.minus(16)}</button>
          <input type="number" min={0} inputMode="numeric" className="mv-input sm" style={{ width: 56, minHeight: 36, padding: 0, textAlign: 'center', fontWeight: 800, color }} value={draft}
            onChange={e => setDraft(e.target.value)} onBlur={commit} onKeyDown={e => e.key === 'Enter' && (e.target as HTMLInputElement).blur()} />
          <button disabled={busy} onClick={() => onSave(row.quantity + 1)}>{Icon.plus(16)}</button></div></div>
      <div className="mv-row" style={{ marginTop: 8, justifyContent: 'flex-end', gap: 14 }}>
        <button className="mv-link" style={{ fontSize: 13 }} onClick={onHistory}>Журнал</button>
        {onTransfer && <button className="mv-link" style={{ fontSize: 13 }} onClick={onTransfer}>Переместить</button>}
      </div>
    </div>)
}
