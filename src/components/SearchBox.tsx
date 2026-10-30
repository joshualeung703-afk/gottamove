import { useEffect, useRef, useState } from 'react'
import { ApiKeyError, geocode, preloadSearch } from '../services/digitransit'
import type { Place } from '../types'

interface Props {
  destination: Place | null
  onSelect: (place: Place) => void
  onClear: () => void
}

export function SearchBox({ destination, onSelect, onClear }: Props) {
  const [text, setText] = useState('')
  const [results, setResults] = useState<Place[]>([])
  const [correctedTo, setCorrectedTo] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** The query the current results belong to, so Enter doesn't pick stale results while typing. */
  const [resultsFor, setResultsFor] = useState('')
  const pickWhenReady = useRef(false)

  useEffect(() => {
    if (destination) setText(destination.label)
  }, [destination])

  useEffect(() => {
    const q = text.trim()
    if (q.length < 2 || q === destination?.label) {
      setResults([])
      return
    }
    const ctrl = new AbortController()
    const timer = setTimeout(() => {
      geocode(q, ctrl.signal)
        .then((r) => {
          if (ctrl.signal.aborted) return
          if (pickWhenReady.current && r.places[0]) {
            pickWhenReady.current = false
            choose(r.places[0])
            return
          }
          setResults(r.places)
          setResultsFor(q)
          setCorrectedTo(r.correctedTo ?? null)
          setActive(0)
          setError(null)
        })
        .catch((e) => {
          if (ctrl.signal.aborted) return
          pickWhenReady.current = false
          setError(e instanceof ApiKeyError ? e.message : 'Search unavailable')
        })
    }, 220)
    return () => {
      clearTimeout(timer)
      ctrl.abort()
    }
  }, [text, destination])

  function choose(p: Place) {
    pickWhenReady.current = false
    setOpen(false)
    setResults([])
    setText(p.label)
    onSelect(p)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') setActive((a) => Math.min(results.length - 1, a + 1))
    else if (e.key === 'ArrowUp') setActive((a) => Math.max(0, a - 1))
    else if (e.key === 'Enter') {
      // Enter while a search is still running picks its top result as soon as it arrives.
      if (text.trim() !== resultsFor) pickWhenReady.current = text.trim().length >= 2
      else if (results[active]) choose(results[active])
    }
    else if (e.key === 'Escape') setOpen(false)
    else return
    e.preventDefault()
  }

  const showList = open && (results.length > 0 || error)

  return (
    <div className="search">
      <div className="search-field">
        <span className="search-icon" aria-hidden>➜</span>
        <input
          value={text}
          placeholder="Where to?"
          aria-label="Destination"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            pickWhenReady.current = false
            setText(e.target.value)
            setOpen(true)
          }}
          onFocus={() => {
            setOpen(true)
            preloadSearch()
          }}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {text && (
          <button
            className="search-clear"
            aria-label="Clear destination"
            onClick={() => {
              setText('')
              setResults([])
              onClear()
            }}
          >
            ×
          </button>
        )}
      </div>
      {showList && (
        <ul className="search-results" role="listbox">
          {error && <li className="search-error">{error}</li>}
          {correctedTo && results.length > 0 && (
            <li className="search-corrected" aria-live="polite">
              Showing results for <strong>{correctedTo}</strong>
            </li>
          )}
          {results.map((r, i) => (
            <li
              key={`${r.label}|${r.sublabel}|${r.coord.join()}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(e) => {
                e.preventDefault()
                choose(r)
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="r-label">{r.label}</span>
              {r.sublabel && <span className="r-sub">{r.sublabel}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
