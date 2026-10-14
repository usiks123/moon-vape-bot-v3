'use client'
import { useEffect, useState } from 'react'
import { Notify, adminApi as api, eur } from '@/lib/shared'
import { Confirm, Loading } from '../ui'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; onNotify: Notify }

// Сумма к передаче = оплаченные заказы − возвраты покупателям − уже переданное владельцу.
// Закупки, неоплаченные заказы и расходы администратора сюда не входят.
export default function SettlementSection({ role, cityId, cities, onNotify }: Props) {
  const [data, setData] = useState<any>(null)
  const [city, setCity] = useState(cities[0]?.id || '')
  const [amount, setAmount] = useState(''), [note, setNote] = useState('')
  const [key, setKey] = useState(() => crypto.randomUUID())
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false)

  const load = () => {
    setData(null)
    const path = role === 'owner' ? '/api/admin/settlement' : `/api/admin/settlement?city=${cityId || ''}`
    api(path).then(setData).catch(e => onNotify('Не удалось загрузить взаиморасчёты: ' + e.message, 'err'))
  }
  useEffect(load, [])

  const list: any[] = data ? (Array.isArray(data) ? data : [data]) : []
  const nameOf = (id: string) => cities.find(c => c.id === id)?.name || id
  const amt = Number(amount.replace(',', '.'))
  const selected = list.find(x => x.city_id === city)

  const send = async () => {
    setConfirm(false); setBusy(true)
    try {
      const r = await api('/api/admin/settlement/transfers', { method: 'POST', body: JSON.stringify({ city_id: city, amount: amt, note: note.trim(), idempotency_key: key }) })
      onNotify(r.duplicate ? 'Эта передача уже учтена — повторного списания нет' : 'Передача зафиксирована')
      setAmount(''); setNote(''); setKey(crypto.randomUUID()); load()
    } catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setBusy(false) }
  }

  return (<>
    <h1 className="mv-h1">Взаиморасчёты</h1>
    {!data && <Loading />}
    {data && <div className="mv-col" style={{ gap: 12, marginTop: 12 }}>
      {list.map(s => (
        <div key={s.city_id} className="mv-card" style={{ borderColor: s.owed > 0 ? 'rgba(245,166,74,.4)' : undefined }}>
          <div className="mv-city-tag">{(s.city_name || nameOf(s.city_id)).toUpperCase()}</div>
          <div className="mv-sub">Должен передать владельцу</div>
          <div className="mv-price lg" style={{ marginTop: 4 }}>{eur(s.owed || 0)}</div>
          <div className="mv-col" style={{ gap: 6, marginTop: 12, fontSize: 14 }}>
            <div className="mv-row mv-between"><span className="mv-muted">Получено от покупателей (оплачено)</span><span>{eur(s.collected)}</span></div>
            <div className="mv-row mv-between"><span className="mv-muted">Возвращено покупателям</span><span>−{eur(s.refunded)}</span></div>
            <div className="mv-row mv-between"><span className="mv-muted">Уже передано владельцу</span><span>−{eur(s.transferred)}</span></div>
          </div>
          {s.transfers?.length > 0 && <>
            <div className="mv-sub" style={{ margin: '12px 0 6px' }}>Передачи</div>
            {s.transfers.slice(0, 10).map((t: any) => <div key={t.id} className="mv-row mv-between" style={{ fontSize: 13, padding: '4px 0' }}>
              <span>{new Date(t.created_at).toLocaleDateString('ru-RU')}{t.note ? ' · ' + t.note : ''}</span><span>{eur(t.amount)}</span></div>)}
          </>}
        </div>))}
    </div>}

    {role === 'owner' && data && <div className="mv-card" style={{ marginTop: 16 }}>
      <b>Зафиксировать получение денег</b>
      <div className="mv-sub" style={{ margin: '6px 0 12px' }}>Уменьшает задолженность города. Повторная отправка с тем же ключом не спишет деньги дважды.</div>
      <div className="mv-col" style={{ gap: 10 }}>
        <select className="mv-input" value={city} onChange={e => setCity(e.target.value)}>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <input className="mv-input" type="number" step="0.01" inputMode="decimal" placeholder="Сумма (€)" value={amount} onChange={e => setAmount(e.target.value)} />
        <input className="mv-input" placeholder="Комментарий (необязательно)" value={note} onChange={e => setNote(e.target.value)} />
        {selected && <div className="mv-sub">Задолженность: {eur(selected.owed)}</div>}
        <button className="mv-btn" disabled={busy || !(amt > 0)} onClick={() => setConfirm(true)}>Зафиксировать</button>
      </div>
    </div>}
    {confirm && <Confirm title="Зафиксировать получение?" text={`${eur(amt)} от ${nameOf(city)}. Задолженность уменьшится. Действие попадёт в журнал.`} ok="Зафиксировать" onOk={send} onCancel={() => setConfirm(false)} />}
  </>)
}
