'use client'
import { useEffect, useState } from 'react'
import { Notify, adminApi as api } from '@/lib/shared'
import { Empty, Icon, Loading } from '../ui'

type Props = { role: 'owner' | 'city_admin'; cityId: string | null; cities: any[]; onNotify: Notify }

// Рефералы живут только в Мюнхене: владелец смотрит Мюнхен, админ города — свой город (его выбирает сервер).
const MUNICH = 'muenchen'
const LABEL: Record<string, string> = { pending: 'Ждёт покупки друга', eligible: 'Бонус готов', redeemed: 'Бонус выдан' }
const TONE: Record<string, string> = { pending: 'new', eligible: 'confirmed', redeemed: 'completed' }
const FILTERS: [string, string][] = [['', 'Все'], ['pending', 'Ждут покупки'], ['eligible', 'Бонус готов'], ['redeemed', 'Выдано']]
const day = (s?: string) => (s ? new Date(s).toLocaleDateString('ru-RU') : '—')

export default function ReferralsSection({ role, cityId, onNotify }: Props) {
  const [rows, setRows] = useState<any[] | null>(null), [f, setF] = useState('')
  const city = role === 'city_admin' ? (cityId || MUNICH) : MUNICH
  useEffect(() => {
    api(`/api/admin/referrals?city=${city}`).then(setRows).catch(e => { setRows([]); onNotify('Не удалось загрузить рефералов: ' + e.message, 'err') })
  }, [])
  if (rows === null) return <Loading />

  const count = (st: string) => (st ? rows.filter(r => r.status === st).length : rows.length)
  const shown = rows.filter(r => !f || r.status === f)

  return (<>
    <h1 className="mv-h1">Рефералы</h1>
    <div className="mv-sub" style={{ margin: '4px 0 0' }}>Мюнхен. Бонус: одна любая жидкость тому, кто пригласил, после первой выдачи заказа друга. Картриджи и Elfbar 2000 не засчитываются.</div>
    <div className="mv-toolbar"><div className="mv-chips">
      {FILTERS.map(([k, l]) => <button key={k || 'all'} className={'mv-pill' + (f === k ? ' on' : '')} onClick={() => setF(k)}>{l}<em>{count(k)}</em></button>)}
    </div></div>

    <div className="mv-col" style={{ marginTop: 10 }}>{shown.map(r => (
      <div key={r.id} className="mv-card" style={{ padding: 12 }}>
        <div className="mv-row mv-between" style={{ alignItems: 'flex-start', gap: 8 }}>
          <div className="mv-grow" style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14 }}><b>{r.referrer}</b> <span className="mv-sub">пригласил(а)</span></div>
            <div style={{ fontSize: 14 }}><b>{r.referred}</b></div>
          </div>
          <span className={'mv-badge ' + TONE[r.status]}>{LABEL[r.status] || r.status}</span>
        </div>
        <div className="mv-sub" style={{ marginTop: 6, fontSize: 12.5 }}>
          Приглашён {day(r.created_at)}
          {r.eligible_at && <> · бонус готов {day(r.eligible_at)}{r.first_order ? ` (заказ ${r.first_order})` : ''}</>}
          {r.redeemed_at && <> · выдан {day(r.redeemed_at)}{r.reward_order ? ` (заказ ${r.reward_order})` : ''}</>}
        </div>
        {r.status === 'eligible' && <div className="mv-sub" style={{ marginTop: 4, fontSize: 12.5, color: 'var(--warning)' }}>
          Выдаётся, когда оба подписаны на канал. Проверяется при выборе бонуса в приложении.</div>}
      </div>))}</div>
    {!shown.length && <Empty icon={Icon.chat(30)} title={rows.length ? 'Ничего в этом статусе' : 'Рефералов пока нет'} text={rows.length ? undefined : 'Они появятся, когда кто-то перейдёт по ссылке друга'} />}
  </>)
}
