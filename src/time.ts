// Time helpers. Every city the app covers is in Finland, so "local" is always Europe/Helsinki.

const dateFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Helsinki',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})
const timeFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Helsinki',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
})

export function helsinkiDate(d: Date): string {
  return dateFmt.format(d) // YYYY-MM-DD
}

export function helsinkiSecondsOfDay(d: Date): number {
  const [h, m, s] = timeFmt.format(d).split(':').map(Number)
  return h * 3600 + m * 60 + s
}

/**
 * Trip start in seconds since the operating day's midnight (GTFS style, may exceed 24 h).
 * Live feeds give start as 24 h "HH:mm"; a trip starting after midnight still belongs to
 * the previous operating day, so it needs +24 h.
 */
export function tripStartSeconds(start: string, oday: string, tst: string): number {
  const [h, m] = start.split(':').map(Number)
  let t = h * 3600 + m * 60
  const localDate = helsinkiDate(new Date(tst))
  if (localDate > oday && h < 6) t += 86400
  return t
}

/** Seconds since the operating day's midnight right now. */
export function nowServiceSeconds(oday: string, now = new Date()): number {
  const s = helsinkiSecondsOfDay(now)
  return helsinkiDate(now) > oday ? s + 86400 : s
}

export function clock(sec: number): string {
  const s = ((Math.round(sec / 60) * 60) % 86400 + 86400) % 86400
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Schedule deviation (Msg.dl): negative = behind schedule (late), positive = ahead. */
export function delayText(dl: number | null): { text: string; cls: string } {
  if (dl == null) return { text: '', cls: '' }
  const min = Math.round(Math.abs(dl) / 60)
  if (min === 0) return { text: 'On time', cls: 'ok' }
  return dl < 0
    ? { text: `${min} min late`, cls: 'late' }
    : { text: `${min} min early`, cls: 'early' }
}
