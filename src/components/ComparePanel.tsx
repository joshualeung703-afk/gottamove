import { memo, useMemo, useState } from 'react'
import type { GroupKey, TripGroup } from '../services/compare'
import type { Place, TripOption } from '../types'
import { OptionCard } from './OptionCard'

export type GroupState = { status: 'loading' } | { status: 'done'; options: TripOption[] } | { status: 'error'; error: string }

interface Props {
  destination: Place | null
  groups: TripGroup[]
  states: Partial<Record<GroupKey, GroupState>>
  highlight: string | null
  selected: string | null
  onHighlight: (id: string | null) => void
  onSelect: (id: string) => void
  onFocusOption: (id: string) => void
  /** Slid out of the way while one option is focused. */
  hidden?: boolean
}

type Sort = 'fastest' | 'cheapest'

// Memoised: the compass updates App many times a second, and none of that concerns the panel.
export const ComparePanel = memo(function ComparePanel({
  destination, groups, states, highlight, selected, onHighlight, onSelect, onFocusOption, hidden,
}: Props) {
  const [sort, setSort] = useState<Sort>('fastest')
  const [collapsed, setCollapsed] = useState(false)

  const options = useMemo(() => {
    const all = groups.flatMap((g) => {
      const s = states[g.key]
      return s?.status === 'done' ? s.options : []
    })
    const key = (o: TripOption) => (sort === 'fastest' ? [o.durationMin, o.priceMin] : [o.priceMin, o.durationMin])
    return all.sort((a, b) => key(a)[0] - key(b)[0] || key(a)[1] - key(b)[1])
  }, [groups, states, sort])

  const badges = useMemo(() => {
    const out = new Map<string, string[]>()
    if (options.length < 2) return out
    const add = (id: string, b: string) => out.set(id, [...(out.get(id) ?? []), b])
    const fastest = options.reduce((a, b) => (b.durationMin < a.durationMin ? b : a))
    add(fastest.id, 'Fastest')
    // "Cheapest" only means something among paid options; free ones are obvious.
    const paid = options.filter((o) => o.priceMax > 0)
    if (paid.length) add(paid.reduce((a, b) => (b.priceMax < a.priceMax ? b : a)).id, 'Cheapest')
    const greenest = options.filter((o) => o.co2g === 0 && o.mode !== 'walk')
    if (greenest.length) add(greenest.reduce((a, b) => (b.durationMin < a.durationMin ? b : a)).id, 'Green')
    return out
  }, [options])

  if (!destination) return null

  const loading = groups.filter((g) => states[g.key]?.status === 'loading')
  const errors = groups.flatMap((g) => {
    const s = states[g.key]
    return s?.status === 'error' ? [{ group: g, error: s.error }] : []
  })

  return (
    <aside className={`panel${collapsed ? ' collapsed' : ''}${hidden ? ' panel-hidden' : ''}`} aria-hidden={hidden}>
      <button className="panel-handle" aria-label={collapsed ? 'Expand' : 'Collapse'} onClick={() => setCollapsed((c) => !c)} />
      <header className="panel-head">
        <div>
          <div className="panel-kicker">Ways to</div>
          <h2>{destination.label}</h2>
        </div>
        <div className="sort" role="tablist">
          {(['fastest', 'cheapest'] as Sort[]).map((s) => (
            <button key={s} role="tab" aria-selected={sort === s} className={sort === s ? 'on' : ''} onClick={() => setSort(s)}>
              {s === 'fastest' ? 'Fastest' : 'Cheapest'}
            </button>
          ))}
        </div>
      </header>
      <ul className="cards">
        {options.map((o) => (
          <OptionCard
            key={o.id}
            option={o}
            badges={badges.get(o.id) ?? []}
            highlighted={highlight === o.id}
            selected={selected === o.id}
            onHighlight={onHighlight}
            onSelect={onSelect}
            onFocusOption={onFocusOption}
          />
        ))}
        {loading.map((g) => (
          <li key={g.key} className="card skeleton"><span>{g.label}</span></li>
        ))}
        {errors.map(({ group, error }) => (
          <li key={group.key} className="card card-error">
            <span className="card-title">{group.label}</span>
            <span className="card-sub">{error}</span>
          </li>
        ))}
      </ul>
      <footer className="panel-foot">Taxi, ride-hail and scooter prices are estimates from typical Helsinki rates. Transit by HSL / Digitransit · map © OpenStreetMap contributors.</footer>
    </aside>
  )
})
