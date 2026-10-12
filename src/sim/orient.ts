import type { Quat, Vec3 } from './types.ts'

/**
 * Minimal quaternion maths for the full-freedom flight model.
 * Sim code never imports three.js — this is the whole orientation library.
 *
 * Convention: the ship's local frame is (right = +x, up = +y, forward = +z),
 * matching the renderer's `makeBasis(right, up, forward)`.
 */

export function quatIdentity(): Quat {
  return { x: 0, y: 0, z: 0, w: 1 }
}

export function quatCopy(q: Quat, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  out.x = q.x
  out.y = q.y
  out.z = q.z
  out.w = q.w
  return out
}

/** Hamilton product `a * b` (b applied first in the local frame of a). */
export function quatMul(a: Quat, b: Quat, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  const ax = a.x, ay = a.y, az = a.z, aw = a.w
  const bx = b.x, by = b.y, bz = b.z, bw = b.w
  out.x = aw * bx + ax * bw + ay * bz - az * by
  out.y = aw * by - ax * bz + ay * bw + az * bx
  out.z = aw * bz + ax * by - ay * bx + az * bw
  out.w = aw * bw - ax * bx - ay * by - az * bz
  return out
}

export function quatNormalize(q: Quat): Quat {
  const length = Math.hypot(q.x, q.y, q.z, q.w)
  if (length < 1e-9) return quatIdentity()
  q.x /= length
  q.y /= length
  q.z /= length
  q.w /= length
  return q
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const length = Math.hypot(axis.x, axis.y, axis.z)
  if (length < 1e-9) return quatIdentity()
  const half = angle / 2
  const s = Math.sin(half) / length
  return { x: axis.x * s, y: axis.y * s, z: axis.z * s, w: Math.cos(half) }
}

export function quatRotate(q: Quat, v: Vec3, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  // v' = v + 2 * q.xyz x (q.xyz x v + w * v)
  const { x: qx, y: qy, z: qz, w: qw } = q
  const tx = 2 * (qy * v.z - qz * v.y)
  const ty = 2 * (qz * v.x - qx * v.z)
  const tz = 2 * (qx * v.y - qy * v.x)
  out.x = v.x + qw * tx + (qy * tz - qz * ty)
  out.y = v.y + qw * ty + (qz * tx - qx * tz)
  out.z = v.z + qw * tz + (qx * ty - qy * tx)
  return out
}

export const quatForward = (q: Quat, out?: Vec3): Vec3 => quatRotate(q, { x: 0, y: 0, z: 1 }, out)
export const quatUp = (q: Quat, out?: Vec3): Vec3 => quatRotate(q, { x: 0, y: 1, z: 0 }, out)
export const quatRight = (q: Quat, out?: Vec3): Vec3 => quatRotate(q, { x: 1, y: 0, z: 0 }, out)

/** Integrate a local angular velocity (rad/s, x = pitch, y = yaw, z = roll). */
export function quatIntegrate(q: Quat, omega: Vec3, dt: number): Quat {
  const speed = Math.hypot(omega.x, omega.y, omega.z)
  if (speed < 1e-9) return q
  const half = (speed * dt) / 2
  const s = Math.sin(half) / speed
  const delta: Quat = { x: omega.x * s, y: omega.y * s, z: omega.z * s, w: Math.cos(half) }
  quatMul(q, delta, q)
  return quatNormalize(q)
}

export function quatFromBasis(forward: Vec3, up: Vec3): Quat {
  const forwardLength = Math.hypot(forward.x, forward.y, forward.z) || 1
  const fx = forward.x / forwardLength
  const fy = forward.y / forwardLength
  const fz = forward.z / forwardLength
  // right = up x forward (right-handed, matches the renderer)
  const rx = up.y * fz - up.z * fy
  const ry = up.z * fx - up.x * fz
  const rz = up.x * fy - up.y * fx
  const rightLength = Math.hypot(rx, ry, rz) || 1
  const rightX = rx / rightLength
  const rightY = ry / rightLength
  const rightZ = rz / rightLength
  // truly orthogonal up and forward for the basis
  const upX = fy * rightZ - fz * rightY
  const upY = fz * rightX - fx * rightZ
  const upZ = fx * rightY - fy * rightX
  const forwardX = rightY * upZ - rightZ * upY
  const forwardY = rightZ * upX - rightX * upZ
  const forwardZ = rightX * upY - rightY * upX

  // rotation matrix columns: right, up, forward
  const m00 = rightX, m01 = upX, m02 = forwardX
  const m10 = rightY, m11 = upY, m12 = forwardY
  const m20 = rightZ, m21 = upZ, m22 = forwardZ
  const trace = m00 + m11 + m22
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2
    return quatNormalize({
      w: 0.25 * s,
      x: (m21 - m12) / s,
      y: (m02 - m20) / s,
      z: (m10 - m01) / s,
    })
  }
  if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    return quatNormalize({
      w: (m21 - m12) / s,
      x: 0.25 * s,
      y: (m01 + m10) / s,
      z: (m02 + m20) / s,
    })
  }
  if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    return quatNormalize({
      w: (m02 - m20) / s,
      x: (m01 + m10) / s,
      y: 0.25 * s,
      z: (m12 + m21) / s,
    })
  }
  const s = Math.sqrt(1 + m22 - m00 - m11) * 2
  return quatNormalize({
    w: (m10 - m01) / s,
    x: (m02 + m20) / s,
    y: (m12 + m21) / s,
    z: 0.25 * s,
  })
}

/** Normalised linear interpolation — good enough for camera and assist turns. */
export function quatNlerp(a: Quat, b: Quat, t: number, out: Quat = { x: 0, y: 0, z: 0, w: 1 }): Quat {
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w
  const sign = dot < 0 ? -1 : 1
  out.x = a.x + (b.x * sign - a.x) * t
  out.y = a.y + (b.y * sign - a.y) * t
  out.z = a.z + (b.z * sign - a.z) * t
  out.w = a.w + (b.w * sign - a.w) * t
  return quatNormalize(out)
}

export interface EulerFlight {
  /** -PI/2 .. PI/2 */
  pitch: number
  /** -PI .. PI */
  yaw: number
  /** -PI .. PI, 0 = wings level with the orbital plane */
  roll: number
}

export function quatToFlightAngles(q: Quat): EulerFlight {
  const forward = quatForward(q)
  const up = quatUp(q)
  const yaw = Math.atan2(forward.x, forward.z)
  const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)))
  // reference "level" up: the world up vector with the forward component removed
  const refRightLength = Math.hypot(forward.z, forward.x) || 1
  const refRightX = forward.z / refRightLength
  const refRightZ = -forward.x / refRightLength
  const refUpX = forward.y * refRightZ
  const refUpY = forward.z * refRightX - forward.x * refRightZ
  const refUpZ = -forward.y * refRightX
  const dotRight = up.x * refRightX + up.z * refRightZ
  const dotUp = up.x * refUpX + up.y * refUpY + up.z * refUpZ
  const roll = Math.atan2(dotRight, dotUp)
  return { pitch, yaw, roll }
}

/** Pitch (x), yaw (y), roll (z) unit vectors in the ship's local frame. */
export const LOCAL_PITCH_AXIS: Vec3 = { x: 1, y: 0, z: 0 }
export const LOCAL_YAW_AXIS: Vec3 = { x: 0, y: 1, z: 0 }
export const LOCAL_ROLL_AXIS: Vec3 = { x: 0, y: 0, z: 1 }
