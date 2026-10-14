'use client'
import { useEffect, useState } from 'react'
import CustomerApp from '@/components/customer/App'
import AdminApp from '@/components/admin/App'

const API = process.env.NEXT_PUBLIC_API_URL || ''
const tg = () => (window as any).Telegram?.WebApp

// Роль определяет backend по таблице admins и проверенному initData. Клиенту роль не доверяем.
async function checkAuth(initData: string): Promise<{ isAdmin: boolean; role: string | null; city_id: string | null }> {
  try {
    const r = await fetch(API + '/api/check-admin', { headers: { Authorization: 'tma ' + initData } })
    if (r.ok) return await r.json()
    return { isAdmin: false, role: null, city_id: null }
  } catch {
    return { isAdmin: false, role: null, city_id: null }
  }
}

export default function Page() {
  const [ready, setReady] = useState(false)
  const [role, setRole] = useState<{ isAdmin: boolean; role: string | null; city_id: string | null }>({ isAdmin: false, role: null, city_id: null })
  const [error, setError] = useState('')

  useEffect(() => {
    const w = tg()
    if (!w?.initData) { setError('Откройте приложение из Telegram'); return }
    w.ready(); w.expand(); w.setHeaderColor?.('#08080c'); w.setBackgroundColor?.('#08080c')
    checkAuth(w.initData).then(r => { setRole(r); setReady(true) })
  }, [])

  if (error && !ready) return <div className="mv-center">{error}</div>
  if (!ready) return <div className="mv-center">Загрузка…</div>
  return role.isAdmin ? <AdminApp role={role.role as 'owner' | 'city_admin'} cityId={role.city_id} /> : <CustomerApp />
}
