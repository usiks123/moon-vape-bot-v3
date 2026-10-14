'use client'
import { ReactNode, useEffect } from 'react'
import { ST, ST_CLASS, eur, imgUrl } from '@/lib/shared'

/* ---------- Icons (inline SVG, stroke = currentColor) ---------- */
const P = ({ children, s = 22, fill = 'none' }: { children: ReactNode; s?: number; fill?: string }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill={fill} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
)
export const Icon = {
  home: (s?: number) => <P s={s}><path d="M4 11l8-7 8 7v8a1 1 0 01-1 1h-4v-6H9v6H5a1 1 0 01-1-1z" /></P>,
  bag: (s?: number) => <P s={s}><path d="M5 8h14l-1 12H6z" /><path d="M9 8V6a3 3 0 016 0v2" /></P>,
  cart: (s?: number) => <P s={s}><path d="M3 4h2l2.2 10.2a1 1 0 001 .8h8.6a1 1 0 001-.8L19 8H6" /><circle cx="9" cy="19" r="1.3" /><circle cx="17" cy="19" r="1.3" /></P>,
  user: (s?: number) => <P s={s}><circle cx="12" cy="8" r="3.6" /><path d="M5 20a7 7 0 0114 0" /></P>,
  plus: (s?: number) => <P s={s ?? 18}><path d="M12 5v14M5 12h14" /></P>,
  minus: (s?: number) => <P s={s ?? 18}><path d="M5 12h14" /></P>,
  back: (s?: number) => <P s={s}><path d="M15 5l-7 7 7 7" /></P>,
  close: (s?: number) => <P s={s}><path d="M6 6l12 12M18 6L6 18" /></P>,
  trash: (s?: number) => <P s={s}><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12h10l1-12M9 7V4h6v3" /></P>,
  grid: (s?: number) => <P s={s}><rect x="4" y="4" width="7" height="7" rx="1.5" /><rect x="13" y="4" width="7" height="7" rx="1.5" /><rect x="4" y="13" width="7" height="7" rx="1.5" /><rect x="13" y="13" width="7" height="7" rx="1.5" /></P>,
  box: (s?: number) => <P s={s}><path d="M3 8l9-5 9 5v8l-9 5-9-5z" /><path d="M3 8l9 5 9-5M12 13v8" /></P>,
  list: (s?: number) => <P s={s}><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></P>,
  more: (s?: number) => <P s={s}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></P>,
  chart: (s?: number) => <P s={s}><path d="M4 20V10M10 20V4M16 20v-8M22 20H2" /></P>,
  tag: (s?: number) => <P s={s}><path d="M3 12V4h8l10 10-8 8z" /><circle cx="7.5" cy="8.5" r="1" /></P>,
  euro: (s?: number) => <P s={s}><path d="M17 6a7 7 0 100 12M4 10h9M4 14h9" /></P>,
  search: (s?: number) => <P s={s}><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></P>,
  check: (s?: number) => <P s={s}><path d="M5 12l5 5 9-10" /></P>,
  spark: (s?: number) => <P s={s} fill="currentColor"><path d="M12 2l2.2 7.2L21.5 12l-7.3 2.8L12 22l-2.2-7.2L2.5 12l7.3-2.8z" /></P>,
  drop: (s?: number) => <P s={s} fill="currentColor"><path d="M12 3c3.5 4.2 6 7.4 6 10.6A6 6 0 016 13.6C6 10.4 8.5 7.2 12 3z" /></P>,
  diamond: (s?: number) => <P s={s}><path d="M12 3l9 9-9 9-9-9z" /><path d="M12 8l4 4-4 4-4-4z" /></P>,
  dot: (s?: number) => <P s={s} fill="currentColor"><circle cx="12" cy="12" r="4" /></P>,
  pod: (s?: number) => <P s={s}><rect x="4" y="4" width="16" height="16" rx="3" /><rect x="9" y="9" width="6" height="6" rx="1" /></P>,
  cart2: (s?: number) => <P s={s}><rect x="4" y="5" width="16" height="14" rx="2" /><path d="M8 9h8M8 13h8M8 16h5" /></P>,
  chat: (s?: number) => <P s={s}><path d="M4 5h16v11H9l-5 4z" /></P>,
}
const catIcon = (name = '') => {
  const n = name.toLowerCase()
  if (n.includes('жидк')) return Icon.drop(24)
  if (n.includes('однораз')) return Icon.diamond(24)
  if (n.includes('снюс')) return Icon.dot(24)
  if (n.includes('pod') || n.includes('под')) return Icon.pod(24)
  if (n.includes('картр') || n.includes('испар')) return Icon.cart2(24)
  return Icon.box(24)
}

/* ---------- Brand ---------- */
export const Moon = ({ s = 36 }: { s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 40 40" aria-hidden>
    <defs>
      <linearGradient id="mvm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#7cc0ff" /><stop offset="1" stopColor="#2f56d6" /></linearGradient>
      <mask id="mvmask"><rect width="40" height="40" fill="#fff" /><circle cx="27" cy="15" r="12.5" fill="#000" /></mask>
    </defs>
    <circle cx="19" cy="21" r="15" fill="url(#mvm)" mask="url(#mvmask)" />
  </svg>
)
export const Logo = () => <div className="mv-logo"><Moon />MoonVape</div>

export function Header({ onProfile, left, title }: { onProfile?: () => void; left?: ReactNode; title?: string }) {
  return (
    <header className="mv-header">
      {left || <Logo />}
      {title && <div style={{ fontWeight: 800 }}>{title}</div>}
      {onProfile ? <button className="mv-iconbtn" aria-label="Профиль" onClick={onProfile}>{Icon.user(20)}</button> : <span />}
    </header>
  )
}

/* ---------- Primitives ---------- */
export const Spinner = () => <div className="mv-spinner" />
export const Loading = ({ text = 'Загрузка…' }: { text?: string }) => <div className="mv-center"><Spinner />{text}</div>

export function Empty({ icon, title, text }: { icon?: ReactNode; title: string; text?: string }) {
  return <div className="mv-empty"><i>{icon || Icon.box(30)}</i><b>{title}</b>{text}</div>
}

export function StatusBadge({ status }: { status: string }) {
  return <span className={'mv-badge ' + (ST_CLASS[status] || 'new')}>{ST[status] || status}</span>
}

export const Price = ({ v, lg }: { v: number | null | undefined; lg?: boolean }) =>
  <span className={'mv-price' + (lg ? ' lg' : '')}>{v == null ? '—' : eur(v)}</span>

export function Qty({ n, onMinus, onPlus, maxed }: { n: number; onMinus: () => void; onPlus: () => void; maxed?: boolean }) {
  return <div className="mv-qty"><button aria-label="Меньше" onClick={onMinus}>{Icon.minus(16)}</button><span key={n} className="mv-pop">{n}</span><button aria-label="Больше" disabled={maxed} onClick={onPlus}>{Icon.plus(16)}</button></div>
}

export function Pic({ p, className = '', style }: { p: any; className?: string; style?: React.CSSProperties }) {
  const u = imgUrl(p?.image_path)
  return <div className={'mv-pic ' + className} style={style}>{u ? <img src={u} alt={p?.name || ''} loading="lazy" /> : <span style={{ color: '#8ec5ff' }}>{Icon.drop(44)}</span>}</div>
}

/* ---------- Product card (каталог) ---------- */
export function ProductCard({ p, onOpen }: { p: any; onOpen: () => void }) {
  const items = p.items || []
  const stock = items.reduce((s: number, i: any) => s + Math.max(0, i.available || 0), 0)
  const min = items.length ? Math.min(...items.map((i: any) => i.price)) : null
  return (
    <div className="mv-product" role="button" tabIndex={0} onClick={onOpen} onKeyDown={e => e.key === 'Enter' && onOpen()}>
      <Pic p={p} />
      <div className="mv-product-body">
        <div className="mv-product-name mv-trunc">{p.name}</div>
        <div className="mv-sub mv-trunc">{items.length} вариантов</div>
        <div className="mv-product-foot"><Price v={min} /><span className="mv-plus" aria-hidden>{Icon.plus(18)}</span></div>
        <div className="mv-stock">{stock > 0 ? `В наличии: ${stock} шт.` : 'Нет в наличии'}</div>
      </div>
    </div>
  )
}

export function CategoryBar({ cats, value, onChange }: { cats: any[]; value: number; onChange: (id: number) => void }) {
  return (
    <div className="mv-cats">
      <button className={'mv-cat' + (value === 0 ? ' on' : '')} onClick={() => onChange(0)}><i>{Icon.spark(24)}</i>Все</button>
      {cats?.map((c: any) => <button key={c.id} className={'mv-cat' + (value === c.id ? ' on' : '')} onClick={() => onChange(c.id)}><i>{catIcon(c.name)}</i><span className="mv-trunc" style={{ maxWidth: 68 }}>{c.name}</span></button>)}
    </div>
  )
}

/* ---------- Bottom navigation (единая для Mini App и админки) ---------- */
export function BottomNav({ items, active, onSelect }: { items: { key: string; label: string; icon: ReactNode; count?: number }[]; active: string; onSelect: (k: string) => void }) {
  return (
    <nav className="mv-nav"><div className="mv-nav-in" style={{ gridTemplateColumns: `repeat(${items.length},1fr)` }}>
      {items.map(it => (
        <button key={it.key} className={active === it.key ? 'on' : ''} onClick={() => onSelect(it.key)}>
          <span className="ic">{it.icon}{!!it.count && <span className="cnt mv-pop" key={it.count}>{it.count}</span>}</span>{it.label}
        </button>
      ))}
    </div></nav>
  )
}

/* ---------- Sheet / Modal ---------- */
export function Sheet({ onClose, children, center }: { onClose: () => void; children: ReactNode; center?: boolean }) {
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])
  return (
    <div className={'mv-backdrop' + (center ? ' center' : '')} onClick={onClose}>
      <div className="mv-sheet" onClick={e => e.stopPropagation()}>{!center && <div className="mv-grab" />}{children}</div>
    </div>
  )
}

export function Confirm({ title, text, ok = 'Подтвердить', danger, onOk, onCancel }: { title: string; text?: string; ok?: string; danger?: boolean; onOk: () => void; onCancel: () => void }) {
  return (
    <Sheet center onClose={onCancel}>
      <h3 style={{ margin: '0 0 6px', fontSize: 18, fontWeight: 800 }}>{title}</h3>
      {text && <p className="mv-sub" style={{ margin: '0 0 var(--sp-4)' }}>{text}</p>}
      <div className="mv-col"><button className={'mv-btn' + (danger ? ' danger' : '')} onClick={onOk}>{ok}</button><button className="mv-btn ghost" onClick={onCancel}>Отмена</button></div>
    </Sheet>
  )
}

export function Toast({ kind, text, onDone }: { kind: 'ok' | 'err'; text: string; onDone: () => void }) {
  useEffect(() => { const t = setTimeout(onDone, kind === 'ok' ? 2500 : 4000); return () => clearTimeout(t) }, [text])
  return <div className={'mv-toast ' + kind} onClick={onDone}>{text}</div>
}
