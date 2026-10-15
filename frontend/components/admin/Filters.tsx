'use client'
import { Icon } from '../ui'

// Общие помощники админки: поиск и фильтры по категориям.
export const norm = (s: any) => String(s ?? '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
const words = (q: string) => norm(q).split(' ').filter(Boolean)

// Все слова запроса должны встретиться в названии, категории или вкусах (вариантах) товара.
export function matchProduct(p: any, catName: string, q: string): { ok: boolean; flavors: string[] } {
  const ws = words(q)
  const flavors: string[] = (p.variants || []).map((v: any) => String(v.name))
  if (!ws.length) return { ok: true, flavors: [] }
  const ok = ws.every(w => norm([p.name, catName, ...flavors].join(' ')).includes(w))
  const flavorHits = flavors.filter(f => ws.some(w => norm(f).includes(w)))
  return { ok, flavors: flavorHits }
}

// Для строк наличия и других плоских записей: все слова запроса в любом из полей.
export function matchText(q: string, ...fields: any[]): boolean {
  const ws = words(q)
  if (!ws.length) return true
  const hay = norm(fields.join(' '))
  return ws.every(w => hay.includes(w))
}

// Подсчёт товаров по категориям (для бейджей на чипах).
export function countByCategory(items: any[], key = 'category_id'): Record<string, number> {
  const out: Record<string, number> = {}
  items.forEach(i => { const k = String(i[key]); out[k] = (out[k] || 0) + 1 })
  return out
}

export function CategoryChips({ cats, value, onChange, counts, allCount }: {
  cats: any[]; value: string; onChange: (v: string) => void; counts?: Record<string, number>; allCount?: number
}) {
  const items: [string, string, number | undefined][] = [['', 'Все', allCount], ...cats.map((c: any): [string, string, number | undefined] => [String(c.id), c.name, counts?.[String(c.id)] ?? 0])]
  return (
    <div className="mv-chips" role="tablist" aria-label="Категории">
      {items.map(([k, label, n]) => (
        <button key={k || 'all'} role="tab" aria-selected={value === k} className={'mv-pill' + (value === k ? ' on' : '')} onClick={() => onChange(k)}>
          {label}{n !== undefined && <em>{n}</em>}
        </button>
      ))}
    </div>
  )
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="mv-search">
      {Icon.search(18)}
      <input className="mv-input" type="search" enterKeyHint="search" autoComplete="off" autoCorrect="off" autoCapitalize="none"
        placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} />
      {value && <button className="mv-search-x" aria-label="Очистить поиск" onClick={() => onChange('')}>{Icon.close(16)}</button>}
    </div>
  )
}
