// Live compass heading from the phone's orientation sensors, in degrees clockwise from north.
// iOS reports a ready-made `webkitCompassHeading` (after a permission tap); Android fires
// `deviceorientationabsolute`, whose Euler angles we turn into a heading ourselves.
// Laptops usually have no compass, in which case no readings ever arrive.

type PermissionApi = { requestPermission?: () => Promise<'granted' | 'denied'> }
type IosOrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number }

const orientationApi = (typeof DeviceOrientationEvent === 'undefined' ? {} : DeviceOrientationEvent) as PermissionApi

/** iOS only hands out compass data after the user grants it from a tap. */
export const compassNeedsPermission = () => typeof orientationApi.requestPermission === 'function'

/** Call directly from a click/tap handler (iOS requires the user gesture). */
export async function requestCompassPermission() {
  if (!compassNeedsPermission()) return true
  try {
    return (await orientationApi.requestPermission!()) === 'granted'
  } catch {
    return false
  }
}

const RAD = Math.PI / 180

/**
 * Heading of the direction pointing away from the user, from W3C DeviceOrientation Euler angles
 * (alpha/beta/gamma, Z-X'-Y'' order, earth frame x = east, y = north). We use the device vector
 * (top edge + back of the phone), which stays well-defined whether the phone lies flat or is held upright.
 */
function headingFromEuler(alpha: number, beta: number, gamma: number) {
  const [cZ, sZ] = [Math.cos(alpha * RAD), Math.sin(alpha * RAD)]
  const [cX, sX] = [Math.cos(beta * RAD), Math.sin(beta * RAD)]
  const [cY, sY] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)]
  // Top edge (device +y) and back (device −z) rotated into the earth frame, horizontal parts only.
  const x = -sZ * cX + (-cZ * sY - sZ * sX * cY)
  const y = cZ * cX + (-sZ * sY + cZ * sX * cY)
  return (Math.atan2(x, y) / RAD + 360) % 360
}

/** Rotation of the screen content relative to the device (landscape is 90 or 270). */
function screenAngle() {
  return screen.orientation?.angle ?? (window as { orientation?: number }).orientation ?? 0
}

/** Calls `onHeading` with a smoothed heading whenever the phone turns. Returns a stop function. */
export function watchHeading(onHeading: (heading: number) => void) {
  // Smooth on the unit circle so 359° → 1° doesn't swing through 180°.
  let sx: number | null = null
  let sy = 0
  let last: number | null = null

  const push = (raw: number) => {
    const h = (raw + screenAngle()) * RAD
    if (sx === null) {
      sx = Math.cos(h)
      sy = Math.sin(h)
    } else {
      sx += (Math.cos(h) - sx) * 0.25
      sy += (Math.sin(h) - sy) * 0.25
    }
    const smooth = (Math.atan2(sy, sx) / RAD + 360) % 360
    // Skip sub-degree jitter so the map isn't redrawn for nothing.
    if (last === null || Math.abs(((smooth - last + 540) % 360) - 180) >= 0.7) {
      last = smooth
      onHeading(smooth)
    }
  }

  const onAbsolute = (e: DeviceOrientationEvent) => {
    if (e.alpha === null || e.beta === null || e.gamma === null) return
    push(headingFromEuler(e.alpha, e.beta, e.gamma))
  }
  const onIos = (e: DeviceOrientationEvent) => {
    const h = (e as IosOrientationEvent).webkitCompassHeading
    if (typeof h === 'number' && h >= 0) push(h)
  }

  window.addEventListener('deviceorientationabsolute', onAbsolute as EventListener)
  window.addEventListener('deviceorientation', onIos as EventListener)
  return () => {
    window.removeEventListener('deviceorientationabsolute', onAbsolute as EventListener)
    window.removeEventListener('deviceorientation', onIos as EventListener)
  }
}
