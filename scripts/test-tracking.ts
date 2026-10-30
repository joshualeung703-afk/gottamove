// Checks route tracking: progress along legs, off-route detection, and legs that share a street.
// Run: npm run test:tracking
import { trackRoute } from '../src/map/tracking.ts'

const O = [24.94, 60.17] as [number, number]
const kx = 111320 * Math.cos(O[1] * (Math.PI / 180))
const ky = 110540
// Metres east/north of O → [lon, lat]
const m = (e: number, n: number): [number, number] => [O[0] + e / kx, O[1] + n / ky]

let failures = 0
function check(name: string, cond: boolean, detail: unknown) {
  if (!cond) failures++
  console.log(`${cond ? '✓' : '✗'} ${name}`, cond ? '' : JSON.stringify(detail))
}
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol

// Walk 300 m east to a stop, then ride 1 km north.
const L = { id: 'l', offset: 0, segments: [
  { coords: [m(0, 0), m(100, 0), m(300, 0)], color: '#fff', dashed: true },
  { coords: [m(300, 0), m(300, 1000)], color: '#0f0' },
] }

let p = trackRoute(L, m(0, 0))!
check('start: on leg 0, 300 m left, heading east', p.segment === 0 && near(p.segmentLeft, 300, 1) && near(p.bearing, 90, 1), p)
p = trackRoute(L, m(150, 3), 0)!
check('halfway: 150 m left, still east', p.segment === 0 && near(p.segmentLeft, 150, 1) && near(p.bearing, 90, 7), p)
p = trackRoute(L, m(290, 0), 150)!
check('just before the stop: target wraps round the corner (north-east)', p.segment === 0 && p.segmentLeft < 15 && p.bearing > 0 && p.bearing < 90, p)
p = trackRoute(L, m(302, 50), 290)!
check('on the ride: leg 1, heading north', p.segment === 1 && Math.abs(((p.bearing + 180) % 360) - 180) <= 7, p)
p = trackRoute(L, m(300, 990), 900)!
check('arrived at the end', p.arrived, p)
p = trackRoute(L, m(0, -100), 0)!
check('100 m south of the start: off route, points north back to it', near(p.offRoute, 100, 1) && near(p.bearing, 0, 1) && !p.arrived, p)

// Walk 100 m south to a stop, then a tram back north past the start (legs share a street).
const S = { id: 's', offset: 0, segments: [
  { coords: [m(0, 0), m(0, -100)], color: '#fff', dashed: true },
  { coords: [m(0, -100), m(0, 900)], color: '#0f0' },
] }
p = trackRoute(S, m(0, 0), 0)!
check('overlap, at start: walking leg (south), not the tram passing by', p.segment === 0 && near(p.bearing, 180, 1), p)
p = trackRoute(S, m(1, -60), 40)!
check('overlap, walking south: still walking leg', p.segment === 0 && near(p.segmentLeft, 40, 2), p)
p = trackRoute(S, m(0, -40), 100)!
check('overlap, on the tram heading back north: tram leg', p.segment === 1 && near(p.bearing, 0, 1), p)

console.log(failures ? `\n${failures} failed` : '\nall passed')
process.exit(failures ? 1 : 0)
