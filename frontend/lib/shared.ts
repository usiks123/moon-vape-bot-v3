// Общие утилиты (UI-слой). Бизнес-логика живёт в backend и RPC Supabase.
export const eur = (n: number) => (Number.isFinite(+n) ? +n : 0).toFixed(2).replace('.', ',') + ' €'

// Статусы заказа (миграции 0002–0003): new → confirmed → prepared → issued → returned; cancelled из new/confirmed/prepared.
export const ST: Record<string, string> = {
  new: 'Новый', confirmed: 'Подтверждён', prepared: 'Подготовлен', issued: 'Выдан', cancelled: 'Отменён', returned: 'Возвращён',
}
// Классы бейджей из globals.css: new / processing / completed / cancelled
export const ST_CLASS: Record<string, string> = {
  new: 'new', confirmed: 'processing', prepared: 'processing', issued: 'completed', cancelled: 'cancelled', returned: 'cancelled',
}
// Сообщения об ошибках из backend (detail) и RPC.
export const ERR: Record<string, string> = {
  insufficient_stock: 'Недостаточно товара в выбранном городе — обновите корзину',
  wholesale_manager: 'От 50 шт. — цена по договорённости с менеджером.',
  item_not_found: 'Товар больше недоступен',
  city_mismatch: 'Товар относится к другому городу. Проверьте корзину.',
  city_required: 'Сначала выберите город',
  price_missing: 'Цена товара ещё не указана — оформление недоступно',
  forbidden: 'Нет доступа',
  bad_city: 'Такого города нет',
  empty_order: 'Корзина пуста',
  already_paid: 'Заказ уже отмечен оплаченным',
  bad_status: 'В этом статусе оплату отметить нельзя',
  bad_transition: 'Этот переход статуса недопустим',
  below_reserved: 'Остаток не может быть меньше резерва под заказы',
  exceeds_balance: 'Сумма больше текущей задолженности Hannover',
  bad_amount: 'Укажите сумму больше нуля',
  broadcast_cooldown: 'Рассылка по этому городу уже запускалась недавно. Подождите 10 минут.',
  catalog_changed: 'Каталог изменился после предпросмотра. Обновите предпросмотр.',
  nothing_to_announce: 'Нет доступных товаров для этой рассылки',
  empty_text: 'Текст рассылки пуст',
  bad_transfer: 'Перемещение возможно только между разными городами одной позиции',
  bad_kind: 'Неверный тип операции',
  bad_quantity: 'Некорректное количество',
  not_admin: 'У вас нет доступа к админ-панели',
  edit_not_allowed: 'Заказ уже подготовлен — изменить его нельзя. Напишите менеджеру.',
  order_not_found: 'Заказ не найден',
  approval_required: 'Заказ ждёт согласования цены владельцем',
  not_approval_order: 'Этот заказ не требует согласования',
  prices_incomplete: 'Укажите цену для каждой позиции',
  tier_price_missing: 'Не задана оптовая цена для одного из товаров',
  bad_tiers: 'Некорректная сетка оптовых цен',
  bad_tier: 'Такой ступени у товара нет',
}
export const tg = () => (typeof window !== 'undefined' ? (window as any).Telegram?.WebApp : undefined)
export const API = process.env.NEXT_PUBLIC_API_URL || ''
export const SB = process.env.NEXT_PUBLIC_SUPABASE_URL
export const imgUrl = (p?: string) => (p ? `${SB}/storage/v1/object/public/product-images/${p}` : null)
export const variantLabel = (i: any) => [i.variant, i.flavor].filter(Boolean).join(' · ')
export const haptic = (k: 'light' | 'success' | 'error' = 'light') => {
  const h = tg()?.HapticFeedback
  if (!h) return
  k === 'light' ? h.impactOccurred?.('light') : h.notificationOccurred?.(k)
}

// Запросы админки: Authorization: tma <initData>. Ошибка: detail из backend или код.
export async function adminApi(path: string, opt: any = {}) {
  const r = await fetch(API + path, { ...opt, headers: { 'Content-Type': 'application/json', Authorization: 'tma ' + tg().initData } })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(ERR[j.detail] || (typeof j.detail === 'string' ? j.detail : 'Ошибка сети'))
  return j
}
export type Notify = (msg: string, kind?: 'ok' | 'err') => void
