'use client'
import { useState } from 'react'
import { Notify, adminApi as api } from '@/lib/shared'

type Props = { cities: any[]; onNotify: Notify; onRefresh: () => void }

// Владелец меняет канал каждого города. Ссылка показывается в боте, ID нужен для проверки подписки.
export default function CitiesSection({ cities, onNotify, onRefresh }: Props) {
  return (<>
    <h1 className="mv-h1">Города и каналы</h1>
    <div className="mv-sub" style={{ margin: '4px 0 12px' }}>Ссылка показывается в ответе бота. ID канала нужен только для проверки подписки в акции «Приведи друга» (сейчас это München).</div>
    <div className="mv-col" style={{ gap: 10 }}>{cities.map(c => <CityRow key={c.id} city={c} onNotify={onNotify} onRefresh={onRefresh} />)}</div>
  </>)
}

function CityRow({ city, onNotify, onRefresh }: any) {
  const [link, setLink] = useState(city.channel_link || '')
  const [cid, setCid] = useState(city.channel_id != null ? String(city.channel_id) : '')
  const [busy, setBusy] = useState(false)
  const save = async () => {
    const id = cid.trim() ? Number(cid.trim()) : null
    if (id !== null && (!Number.isInteger(id) || id >= 0)) return onNotify('ID канала начинается с минуса, например -1001234567890', 'err')
    setBusy(true)
    try {
      await api(`/api/admin/cities/${city.id}/channel`, { method: 'PATCH', body: JSON.stringify({ channel_link: link.trim() || null, channel_id: id }) })
      onNotify(`Канал «${city.name}» сохранён`); onRefresh()
    } catch (e: any) { onNotify('Не сохранено: ' + e.message, 'err') } finally { setBusy(false) }
  }
  return (<div className="mv-card" style={{ padding: 14 }}>
    <div style={{ fontWeight: 800, marginBottom: 8 }}>{city.name}</div>
    <label className="mv-label">Ссылка на канал (покупатель видит в боте)</label>
    <input className="mv-input" placeholder="https://t.me/+..." value={link} onChange={e => setLink(e.target.value)} />
    <label className="mv-label" style={{ marginTop: 8 }}>ID канала (для проверки подписки, только если нужна акция)</label>
    <input className="mv-input" inputMode="numeric" placeholder="-100..." value={cid} onChange={e => setCid(e.target.value)} />
    <button className="mv-btn" style={{ marginTop: 12 }} disabled={busy} onClick={save}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
  </div>)
}
