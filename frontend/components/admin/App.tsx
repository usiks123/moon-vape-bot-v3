'use client'
import { useEffect, useState } from 'react'
import { Notify, adminApi as api, haptic } from '@/lib/shared'
import { BottomNav, Header, Icon, Loading, Moon, Sheet, Toast } from '../ui'
import Dashboard from './Dashboard'
import InventorySection from './InventorySection'
import { CategoriesSection, OrdersSection, PricesSection, ProductsSection } from './AdminSections'
import SettlementSection from './SettlementSection'
import BroadcastSection from './BroadcastSection'
import ReferralsSection from './ReferralsSection'

type Role = 'owner' | 'city_admin'

// Разделы зависят от роли. Это только интерфейс: права всё равно проверяет backend и RPC.
function moreItems(role: Role): [string, string, any][] {
  // «Оптовые цены» видны всем админам; редактирование внутри — только владельцу (ProductSheet).
  const base: [string, string, any][] = [['products', 'Товары', Icon.tag], ['prices', 'Оптовые цены', Icon.euro], ['settlement', 'Взаиморасчёты', Icon.euro], ['broadcast', 'Оповещение о наличии', Icon.chat], ['referrals', 'Рефералы (Мюнхен)', Icon.chat]]
  return role === 'owner' ? [...base, ['categories', 'Категории', Icon.grid]] : base
}

export default function AdminApp({ role, cityId }: { role: Role; cityId: string | null }) {
  const [section, setSection] = useState('dashboard')
  const [cities, setCities] = useState<any[]>([])
  const [catalog, setCatalog] = useState<any>(null)
  const [toast, setToast] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [loading, setLoading] = useState(true), [loadErr, setLoadErr] = useState('')
  const [more, setMore] = useState(false)

  const notify: Notify = (text, kind = 'ok') => { setToast({ kind, text }); haptic(kind === 'ok' ? 'success' : 'error') }
  const load = () => Promise.all([api('/api/admin/cities'), api('/api/admin/catalog')]).then(([c, k]) => { setCities(c); setCatalog(k); setLoadErr('') })
  useEffect(() => { load().catch(e => setLoadErr(e.message)).finally(() => setLoading(false)) }, [])
  // Тихое обновление каталога: экран не перерисовывается целиком, открытые шторки сохраняют ввод.
  const refresh = () => { api('/api/admin/catalog').then(setCatalog).catch(e => notify('Не удалось обновить каталог: ' + e.message, 'err')) }
  const go = (k: string) => { setSection(k); setMore(false); window.scrollTo({ top: 0 }) }

  if (loading) return <div className="mv-app"><Loading text="Загрузка админки…" /></div>
  if (loadErr) return <div className="mv-app"><div className="mv-center"><Moon s={56} /><b style={{ color: 'var(--text)' }}>Не удалось загрузить данные</b>{loadErr}
    <button className="mv-btn sm" onClick={() => { setLoading(true); setLoadErr(''); load().catch(e => setLoadErr(e.message)).finally(() => setLoading(false)) }}>Повторить</button></div></div>

  const more_ = moreItems(role)
  const cityName = role === 'city_admin' ? (cities.find(c => c.id === cityId)?.name || cityId) : null
  const shared = { role, cityId, cities, catalog, onNotify: notify, onRefresh: refresh }

  return (
    <div className="mv-app">
      {toast && <Toast kind={toast.kind} text={toast.text} onDone={() => setToast(null)} />}
      <Header left={<div className="mv-logo"><Moon />Moon<b>Vape</b><span className="mv-badge new" style={{ marginLeft: 4 }}>{role === 'owner' ? 'Владелец' : cityName}</span></div>} />
      <div className="mv-page" key={section}>
        {section === 'dashboard' && <Dashboard {...shared} />}
        {section === 'orders' && <OrdersSection {...shared} />}
        {section === 'inventory' && <InventorySection {...shared} />}
        {section === 'products' && <ProductsSection {...shared} />}
        {section === 'prices' && <PricesSection {...shared} />}
        {section === 'categories' && role === 'owner' && <CategoriesSection {...shared} />}
        {section === 'settlement' && <SettlementSection {...shared} />}
        {section === 'broadcast' && <BroadcastSection {...shared} />}
        {section === 'referrals' && <ReferralsSection {...shared} />}
      </div>
      {more && <Sheet onClose={() => setMore(false)}>
        <h3 style={{ margin: '16px 0 12px', fontWeight: 800 }}>Разделы</h3>
        <div className="mv-col" style={{ paddingBottom: 8 }}>{more_.map(([k, l, ic]) => <button key={k} className="mv-card tap mv-row mv-tap" onClick={() => go(k)}><span className="mv-accent">{ic(22)}</span><b>{l}</b></button>)}</div>
      </Sheet>}
      <BottomNav active={more_.some(m => m[0] === section) ? 'more' : section} onSelect={k => k === 'more' ? setMore(true) : go(k)} items={[
        { key: 'dashboard', label: 'Обзор', icon: Icon.home(22) },
        { key: 'orders', label: 'Заказы', icon: Icon.list(22) },
        { key: 'inventory', label: 'Наличие', icon: Icon.box(22) },
        { key: 'more', label: 'Ещё', icon: Icon.more(22) },
      ]} />
    </div>
  )
}
