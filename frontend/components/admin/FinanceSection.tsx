'use client'
import { ReactNode, useEffect, useState } from 'react'
import { Notify, adminApi as api, eur } from '@/lib/shared'
import { Confirm, Loading } from '../ui'

type Props = { cities: any[]; catalog: any; onNotify: Notify }

// Финансы видит только владелец (backend тоже проверяет роль). Все даты — по берлинскому времени бизнеса.
const LOW_MARGIN = 20 // % — порог «низкая маржа» в таблице товаров
const OPS: Record<string, string> = { expense: 'Расход', cash_in: 'Внесение в кассу', cash_out: 'Изъятие из кассы' }
const todayBerlin = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Berlin' })
const addDays = (s: string, n: number) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10) }
const presetRange = (p: string): [string, string] => {
  const t = todayBerlin()
  if (p === 'today') return [t, t]
  if (p === '7d') return [addDays(t, -6), t]
  if (p === '30d') return [addDays(t, -29), t]
  if (p === 'month') return [t.slice(0, 8) + '01', t]
  return [t, t]
}
const PRESETS: [string, string][] = [['today', 'Сегодня'], ['7d', '7 дней'], ['30d', '30 дней'], ['month', 'Месяц'], ['custom', 'Период']]
const money = (v: any) => (v == null ? '—' : eur(+v))
// Изменение к предыдущему периоду в процентах; null, если сравнивать не с чем.
const pct = (cur: any, prev: any): number | null => {
  if (cur == null || prev == null || +prev === 0) return null
  return Math.round(((+cur - +prev) / Math.abs(+prev)) * 1000) / 10
}

function Delta({ cur, prev }: { cur: any; prev: any }) {
  const d = pct(cur, prev)
  if (d === null) return <span className="mv-sub" style={{ fontSize: 12 }}>нет сравнения</span>
  return <span style={{ fontSize: 12, color: d >= 0 ? 'var(--success, #4caf50)' : 'var(--danger, #e05555)' }}>{d >= 0 ? '▲' : '▼'} {Math.abs(d)}% к прошлому периоду</span>
}

function Kpi({ label, value, delta, hint }: { label: string; value: string; delta?: ReactNode; hint?: string }) {
  return (<div className="mv-card" style={{ padding: 14 }}>
    <div className="mv-sub" style={{ fontSize: 13 }}>{label}</div>
    <div className="mv-price" style={{ marginTop: 4, fontSize: 20 }}>{value}</div>
    {delta && <div style={{ marginTop: 4 }}>{delta}</div>}
    {hint && <div className="mv-sub" style={{ fontSize: 12, marginTop: 4 }}>{hint}</div>}
  </div>)
}

function Chart({ series }: { series: any[] }) {
  if (!series.length) return <div className="mv-sub">Нет выданных заказов за период</div>
  const W = 320, H = 150, pad = 12
  const max = Math.max(1, ...series.map(d => +d.revenue || 0))
  const bw = (W - pad * 2) / series.length
  return (<>
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Выручка и валовая прибыль по дням">
      <line x1={pad} x2={W - pad} y1={H - 18} y2={H - 18} stroke="currentColor" opacity={0.25} />
      {series.map((d, i) => {
        const x = pad + i * bw
        const hR = ((+d.revenue || 0) / max) * (H - 30)
        const hG = (Math.max(+d.gross_profit || 0, 0) / max) * (H - 30)
        return (<g key={d.day}>
          <rect x={x + bw * 0.1} y={H - 18 - hR} width={Math.max(bw * 0.4, 1)} height={hR} fill="var(--accent)" rx="2">
            <title>{`${d.day}: выручка ${eur(d.revenue)}, валовая прибыль ${eur(d.gross_profit)}`}</title></rect>
          <rect x={x + bw * 0.5} y={H - 18 - hG} width={Math.max(bw * 0.4, 1)} height={hG} fill="var(--success, #4caf50)" rx="2" />
        </g>)
      })}
    </svg>
    <div className="mv-sub" style={{ fontSize: 12 }}>Синий — выручка, зелёный — валовая прибыль</div>
  </>)
}

export default function FinanceSection({ cities, catalog, onNotify }: Props) {
  const [preset, setPreset] = useState('30d')
  const [[from, to], setRange] = useState<[string, string]>(presetRange('30d'))
  const [city, setCity] = useState(''), [categoryId, setCategoryId] = useState(''), [productId, setProductId] = useState('')
  const [summary, setSummary] = useState<any>(null), [products, setProducts] = useState<any>(null), [entries, setEntries] = useState<any>(null)
  const [view, setView] = useState<'all' | 'low' | 'nosales'>('all')
  const [reload, setReload] = useState(0)
  // Форма операции
  const [op, setOp] = useState<'expense' | 'cash_in' | 'cash_out'>('expense')
  const [amount, setAmount] = useState(''), [opCity, setOpCity] = useState(''), [cat, setCat] = useState(''), [desc, setDesc] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID()), [confirm, setConfirm] = useState(false)
  // Сторно
  const [revId, setRevId] = useState<number | null>(null), [revReason, setRevReason] = useState(''), [revKey, setRevKey] = useState(() => crypto.randomUUID())
  const [busy, setBusy] = useState(false)

  const badRange = !from || !to || to < from
  const cats: any[] = catalog?.categories || []
  const prods: any[] = catalog?.products || []

  useEffect(() => {
    if (badRange) return
    let alive = true
    const base = new URLSearchParams({ date_from: from, date_to: to })
    if (city) base.set('city', city)
    if (categoryId) base.set('category_id', categoryId)
    const sumQ = new URLSearchParams(base); if (productId) sumQ.set('product_id', productId)
    setSummary(null); setProducts(null); setEntries(null)
    const fail = (what: string) => (e: any) => ({ error: `${what}: ${e.message}` })
    api('/api/admin/finance/summary?' + sumQ).then(r => alive && setSummary(r)).catch(e => alive && setSummary(fail('Отчёт не загружен')(e)))
    api('/api/admin/finance/products?' + base).then(r => alive && setProducts(r)).catch(e => alive && setProducts(fail('Товары не загружены')(e)))
    api('/api/admin/finance/entries?' + base).then(r => alive && setEntries(r)).catch(e => alive && setEntries(fail('Журнал не загружен')(e)))
    return () => { alive = false }
  }, [from, to, city, categoryId, productId, reload])

  const pickPreset = (p: string) => { setPreset(p); if (p !== 'custom') setRange(presetRange(p)) }

  const amt = Number(amount.replace(',', '.'))
  const post = async () => {
    setConfirm(false); setBusy(true)
    try {
      const r = await api('/api/admin/finance/entries', { method: 'POST', body: JSON.stringify({
        op_type: op, amount: amt, city_id: opCity || null, category: op === 'expense' ? cat.trim() : '', description: desc.trim(), idempotency_key: key }) })
      onNotify(r.duplicate ? 'Эта операция уже записана — повторной записи нет' : 'Операция записана в журнал')
      setAmount(''); setDesc(''); setKey(crypto.randomUUID()); setReload(x => x + 1)
    } catch (e: any) { onNotify('Не записано: ' + e.message, 'err') } finally { setBusy(false) }
  }
  const reverse = async () => {
    if (revReason.trim().length < 5) return onNotify('Укажите причину сторно (не менее 5 символов)', 'err')
    setBusy(true)
    try {
      await api(`/api/admin/finance/entries/${revId}/reverse`, { method: 'POST', body: JSON.stringify({ reason: revReason.trim(), idempotency_key: revKey }) })
      onNotify('Сторно записано. Исходная запись остаётся в журнале')
      setRevId(null); setRevReason(''); setRevKey(crypto.randomUUID()); setReload(x => x + 1)
    } catch (e: any) { onNotify('Сторно не записано: ' + e.message, 'err') } finally { setBusy(false) }
  }

  const cur = summary?.current, prev = summary?.previous_metrics
  const rows = (products?.error ? [] : (products || [])).filter((p: any) =>
    view === 'low' ? p.units > 0 && p.margin_pct != null && p.margin_pct < LOW_MARGIN
    : view === 'nosales' ? p.units === 0 : true)
  const cityName = (id: string) => cities.find(c => c.id === id)?.name || id
  const missing = cur?.cogs_missing_lines || 0

  return (<>
    <h1 className="mv-h1">Финансы</h1>
    <div className="mv-sub" style={{ margin: '4px 0 12px' }}>Выручка — выданные заказы. Себестоимость — на момент заказа. Неоплаченные заказы в выручку не входят.</div>

    <div className="mv-row" style={{ gap: 6, flexWrap: 'wrap' }}>
      {PRESETS.map(([k, l]) => <button key={k} className={`mv-btn sm ${preset === k ? '' : 'ghost'}`} style={{ width: 'auto' }} onClick={() => pickPreset(k)}>{l}</button>)}
    </div>
    {preset === 'custom' && <div className="mv-row" style={{ gap: 8, marginTop: 8 }}>
      <input className="mv-input sm" type="date" value={from} onChange={e => setRange([e.target.value, to])} />
      <input className="mv-input sm" type="date" value={to} onChange={e => setRange([from, e.target.value])} />
    </div>}
    {badRange && <div className="mv-note" style={{ marginTop: 8 }}>Дата «по» не может быть раньше даты «с»</div>}
    <div className="mv-col" style={{ gap: 8, marginTop: 10 }}>
      <select className="mv-input sm" value={city} onChange={e => setCity(e.target.value)}>
        <option value="">Вся сеть</option>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select className="mv-input sm" value={categoryId} onChange={e => { setCategoryId(e.target.value); setProductId('') }}>
        <option value="">Все категории</option>{cats.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
      <select className="mv-input sm" value={productId} onChange={e => setProductId(e.target.value)}>
        <option value="">Все товары</option>{prods.filter(p => !categoryId || String(p.category_id) === categoryId)
          .map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
    </div>
    {(categoryId || productId) && <div className="mv-note" style={{ marginTop: 8 }}>
      Фильтр по товару или категории: расходы и чистая прибыль не считаются (расход не привязан к товару).</div>}

    {summary?.error && <div className="mv-note" style={{ marginTop: 12 }}>{summary.error}</div>}
    {!summary && !summary?.error && !badRange && <Loading />}
    {cur && <>
      {missing > 0 && <div className="mv-note" style={{ marginTop: 12 }}>
        {missing} поз. заказов без себестоимости: прибыль по ним завышена. Задайте себестоимость товаров.</div>}
      <div className="mv-grid2" style={{ marginTop: 12, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <Kpi label="Выручка" value={money(cur.revenue)} delta={<Delta cur={cur.revenue} prev={prev?.revenue} />} />
        <Kpi label="Оплаченных заказов" value={String(cur.orders)} delta={<Delta cur={cur.orders} prev={prev?.orders} />} />
        <Kpi label="Средний чек" value={money(cur.avg_check)} delta={<Delta cur={cur.avg_check} prev={prev?.avg_check} />} />
        <Kpi label="Себестоимость продаж" value={money(cur.cogs)} delta={<Delta cur={cur.cogs} prev={prev?.cogs} />} />
        <Kpi label="Валовая прибыль" value={money(cur.gross_profit)} hint={cur.margin_pct != null ? `маржа ${cur.margin_pct}%` : undefined}
          delta={<Delta cur={cur.gross_profit} prev={prev?.gross_profit} />} />
        <Kpi label="Расходы" value={money(cur.expenses)} delta={<Delta cur={cur.expenses} prev={prev?.expenses} />} />
        <Kpi label="Чистая прибыль" value={money(cur.net_profit)} delta={<Delta cur={cur.net_profit} prev={prev?.net_profit} />} />
        <Kpi label="Продано единиц" value={String(cur.units)} delta={<Delta cur={cur.units} prev={prev?.units} />} />
      </div>
      {summary.unpaid_open?.orders > 0 && <div className="mv-sub" style={{ marginTop: 10, fontSize: 13 }}>
        Открытые неоплаченные заказы: {summary.unpaid_open.orders} на {money(summary.unpaid_open.amount)} (не входят в выручку)</div>}

      <div className="mv-card" style={{ marginTop: 12 }}>
        <b>Выручка и прибыль по дням</b>
        <div style={{ marginTop: 10 }}><Chart series={summary.series || []} /></div>
      </div>

      {summary.cash && <div className="mv-card" style={{ marginTop: 12 }}>
        <b>Движение кассы за период</b>
        <div className="mv-sub" style={{ margin: '4px 0 8px', fontSize: 12 }}>Не входит в прибыль.</div>
        <div className="mv-row mv-between" style={{ fontSize: 14 }}><span className="mv-muted">Внесено</span><span>{money(summary.cash.cash_in)}</span></div>
        <div className="mv-row mv-between" style={{ fontSize: 14 }}><span className="mv-muted">Изъято</span><span>{money(summary.cash.cash_out)}</span></div>
      </div>}

      <div className="mv-card" style={{ marginTop: 12 }}>
        <b>Взаиморасчёты (на сейчас)</b>
        {(summary.settlement || []).map((s: any) => <div key={s.city_id} className="mv-row mv-between" style={{ fontSize: 14, marginTop: 8 }}>
          <span>{s.city || cityName(s.city_id)}</span><span>долг {money(s.owed)}</span></div>)}
        <div className="mv-row mv-between" style={{ fontSize: 14, marginTop: 10 }}><span className="mv-muted">Стоимость остатков (по себестоимости)</span><span>{money(summary.stock_cost)}</span></div>
      </div>
    </>}

    <h2 className="mv-h2" style={{ marginTop: 18 }}>Прибыльность товаров</h2>
    <div className="mv-row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
      {([['all', 'Все'], ['low', `Маржа < ${LOW_MARGIN}%`], ['nosales', 'Без продаж']] as [string, string][]).map(([k, l]) =>
        <button key={k} className={`mv-btn sm ${view === k ? '' : 'ghost'}`} style={{ width: 'auto' }} onClick={() => setView(k as any)}>{l}</button>)}
    </div>
    {products?.error && <div className="mv-note">{products.error}</div>}
    {!products && !products?.error && !badRange && <Loading />}
    {products && !products.error && <div className="mv-col" style={{ gap: 6 }}>
      {rows.map((p: any) => <div key={p.product_id} className="mv-card" style={{ padding: 12 }}>
        <div className="mv-row mv-between"><b className="mv-trunc">{p.name}{!p.active && ' (архив)'}</b><span>{money(p.revenue)}</span></div>
        <div className="mv-sub" style={{ fontSize: 12, marginTop: 4 }}>
          продано {p.units} шт. · прибыль {money(p.gross_profit)} · маржа {p.margin_pct != null ? p.margin_pct + '%' : '—'}
          {p.cogs_missing_lines > 0 && ' · нет себестоимости'}</div>
      </div>)}
      {!rows.length && <div className="mv-sub">Нет товаров по выбранному фильтру</div>}
    </div>}

    <h2 className="mv-h2" style={{ marginTop: 18 }}>Журнал операций</h2>
    {entries?.error && <div className="mv-note">{entries.error}</div>}
    {!entries && !entries?.error && !badRange && <Loading />}
    {entries && !entries.error && <div className="mv-col" style={{ gap: 6 }}>
      {entries.map((e: any) => {
        const isRev = !!e.reverses_id
        return (<div key={e.id} className="mv-card" style={{ padding: 12, opacity: e.status === 'reversed' ? 0.7 : 1 }}>
          <div className="mv-row mv-between"><b>{isRev ? 'Сторно' : OPS[e.op_type] || e.op_type}</b><span>{isRev ? '−' : ''}{money(e.amount)}</span></div>
          <div className="mv-sub" style={{ fontSize: 12, marginTop: 4 }}>
            {new Date(e.occurred_at).toLocaleString('ru-RU', { timeZone: 'Europe/Berlin' })}
            {e.city_id ? ' · ' + cityName(e.city_id) : ' · вся сеть'}
            {e.category ? ' · ' + e.category : ''}
            {e.status === 'reversed' ? ' · сторнировано' : ''}</div>
          {(e.description || e.reason) && <div style={{ fontSize: 13, marginTop: 4 }}>{e.description}{e.reason ? ` (причина: ${e.reason})` : ''}</div>}
          {e.status === 'posted' && !isRev && revId !== e.id && <button className="mv-link" style={{ marginTop: 6 }} onClick={() => { setRevId(e.id); setRevReason('') }}>Сторно</button>}
          {revId === e.id && <div className="mv-col" style={{ gap: 6, marginTop: 8 }}>
            <input className="mv-input sm" placeholder="Причина сторно (обязательна)" value={revReason} onChange={ev => setRevReason(ev.target.value)} />
            <div className="mv-row" style={{ gap: 6 }}>
              <button className="mv-btn sm" style={{ width: 'auto' }} disabled={busy} onClick={reverse}>Записать сторно</button>
              <button className="mv-btn ghost sm" style={{ width: 'auto' }} onClick={() => setRevId(null)}>Отмена</button>
            </div>
          </div>}
        </div>)
      })}
      {!entries.length && <div className="mv-sub">Операций за период нет</div>}
    </div>}

    <div className="mv-card" style={{ marginTop: 16 }}>
      <b>Новая операция</b>
      <div className="mv-sub" style={{ margin: '6px 0 10px' }}>Записи неизменяемы. Ошибку исправляйте сторно, а не удалением.</div>
      <div className="mv-col" style={{ gap: 10 }}>
        <select className="mv-input" value={op} onChange={e => setOp(e.target.value as any)}>
          {Object.entries(OPS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input className="mv-input" type="number" step="0.01" inputMode="decimal" placeholder="Сумма (€)" value={amount} onChange={e => setAmount(e.target.value)} />
        <select className="mv-input" value={opCity} onChange={e => setOpCity(e.target.value)}>
          <option value="">Вся сеть</option>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        {op === 'expense' && <input className="mv-input" list="fin-categories" placeholder="Категория расхода (обязательна)" value={cat} onChange={e => setCat(e.target.value)} />}
        <datalist id="fin-categories">{['Аренда', 'Реклама', 'Доставка', 'Упаковка', 'Комиссии', 'Прочее'].map(c => <option key={c} value={c} />)}</datalist>
        <input className="mv-input" placeholder="Комментарий (необязательно)" value={desc} onChange={e => setDesc(e.target.value)} />
        <button className="mv-btn" disabled={busy || !(amt > 0) || (op === 'expense' && !cat.trim())} onClick={() => setConfirm(true)}>Записать</button>
      </div>
    </div>
    {confirm && <Confirm title="Записать операцию?" text={`${OPS[op]}: ${eur(amt)}${opCity ? ' · ' + cityName(opCity) : ' · вся сеть'}. Запись нельзя изменить или удалить.`}
      ok="Записать" onOk={post} onCancel={() => setConfirm(false)} />}
  </>)
}
