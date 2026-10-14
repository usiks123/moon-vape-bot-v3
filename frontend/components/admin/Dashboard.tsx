'use client'
import { useEffect, useState } from 'react'
import { Notify, adminApi as api, eur, ST } from '@/lib/shared'
import { Empty, Icon, Loading, StatusBadge } from '../ui'

export default function Dashboard({ role, cityId, cities, onNotify }: { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; onNotify: Notify }) {
  // Владелец: «вся сеть» или конкретный город. Admin города: только свой город (backend тоже ограничивает).
  const [city, setCity] = useState<string>(role === 'city_admin' ? (cityId || '') : '')
  const [stats, setStats] = useState<any>(null)
  useEffect(() => {
    setStats(null)
    api('/api/admin/dashboard' + (city ? `?city=${city}` : '')).then(setStats).catch(e => onNotify('Не удалось загрузить обзор: ' + e.message, 'err'))
  }, [city])
  const cityLabel = (id: string) => (cities.find(c => c.id === id)?.name || id || 'Без города').toUpperCase()

  const o = stats?.orders || {}
  const orderRows = ['new', 'confirmed', 'prepared', 'issued', 'cancelled', 'returned'].map(k => [ST[k], o[k] ?? 0, k])
  const s = stats?.stock || {}

  return (<>
    <h1 className="mv-h1">Обзор</h1>
    {role === 'owner' && <select className="mv-input sm" style={{ margin: '8px 0 14px' }} value={city} onChange={e => setCity(e.target.value)}>
      <option value="">Вся сеть</option>{cities.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select>}
    {!stats && <Loading />}
    {stats && <>
      <div className="mv-card" style={{ background: 'linear-gradient(120deg,#12204a,#0c1330 60%,#0a0d1c)', borderColor: '#1e2a55' }}>
        <div className="mv-sub">Оплаченная выручка (за вычетом возвратов)</div><div className="mv-price lg" style={{ marginTop: 4 }}>{eur(stats.paid_revenue || 0)}</div>
        <div className="mv-sub" style={{ marginTop: 6 }}>{city ? cityLabel(city) : 'Вся сеть'}</div>
      </div>
      <h2 className="mv-h2">Заказы</h2>
      <div className="mv-grid2">{orderRows.map(([l, v, k]: any) => <div key={k} className="mv-stat"><div className="l"><StatusBadge status={k} /></div><div className="v">{v}</div></div>)}</div>
      <h2 className="mv-h2">Склад (позиций)</h2>
      <div className="mv-card mv-row mv-between">{[['В наличии', s.in_stock, 'var(--success)'], ['Мало (1–2)', s.low, 'var(--warning)'], ['Нет', s.out, 'var(--danger)']].map(([l, v, c]: any) =>
        <div key={l} style={{ textAlign: 'center', flex: 1 }}><div style={{ fontSize: 24, fontWeight: 800, color: c }}>{v ?? 0}</div><div className="mv-sub">{l}</div></div>)}</div>
      <h2 className="mv-h2">Последние заказы</h2>
      {stats.recent?.length ? <div className="mv-col">{stats.recent.map((r: any) => (
        <div key={r.id} className="mv-card mv-row mv-between" style={{ padding: 12 }}>
          <div><div className="mv-city-tag">{cityLabel(r.city_id)}</div><b>#{r.number}</b><div className="mv-sub">{new Date(r.created_at).toLocaleString('ru-RU')} · {r.paid ? 'оплачен' : 'не оплачен'}</div></div>
          <div style={{ textAlign: 'right' }}><div style={{ fontWeight: 800, marginBottom: 4 }}>{eur(+r.total)}</div><StatusBadge status={r.status} /></div>
        </div>))}</div> : <Empty icon={Icon.list(30)} title="Заказов пока нет" />}
    </>}
  </>)
}
