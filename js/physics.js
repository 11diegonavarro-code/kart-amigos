// Modelo de bicicleta con neumáticos Pacejka simplificados. Sin Three.js.
import { clamp, wrap } from './track-data.js';

export const CAR = {
  m: 160, I: 95, a: 0.75, b: 0.8,          // masa (kg), inercia de giro, distancia del CdG a cada eje (m)
  muF: 1.25, muR: 1.6, B: 12, C: 1.3,     // agarre y forma de la curva del neumático
  force: 2000, power: 52000, brake: 3600,  // tracción máx (N), potencia (W), frenada (N)
  cd: 1.25, rr: 30, offroadRR: 110,        // aerodinámica (N·s²/m²), rodadura (N), césped (N·s/m)
  steerMax: 0.42, steerRate: 4, rev: 9,
};
const G = 9.81, NZ = CAR.m * G / 2;
const pac = (alpha, D) => -D * Math.sin(CAR.C * Math.atan(CAR.B * alpha));

export function newKart(x, z, h) {
  return {
    x, z, h, y: 0, vx: 0, vz: 0, r: 0, delta: 0, vf: 0, vl: 0, beta: 0, lonAcc: 0, latAcc: 0,
    drifting: false, driftDir: 0, driftCharge: 0, boostT: 0, spinT: 0, spinDir: 1, shieldT: 0,
    idx: 0, lat: 0, ground: 0, offroad: false,
  };
}

export const speedOf = k => Math.hypot(k.vx, k.vz);

// inp: { steer -1..1 (+ izquierda), up, down, drift }. slopeAlong: pendiente en la dirección del kart (dy/ds)
export function stepKart(k, inp, dt, slopeAlong) {
  const ch = Math.cos(k.h), sh = Math.sin(k.h);
  const vf = k.vx * sh + k.vz * ch, vl = k.vx * ch - k.vz * sh;
  const speed = Math.hypot(k.vx, k.vz);
  const spinning = k.spinT > 0;
  const steerIn = spinning ? 0 : inp.steer;
  const throttle = !spinning && inp.up, braking = !spinning && inp.down;

  // Dirección: menos ángulo a más velocidad y con velocidad de giro limitada
  const target = steerIn * CAR.steerMax / (1 + Math.abs(vf) / 14);
  k.delta += clamp(target - k.delta, -CAR.steerRate * dt, CAR.steerRate * dt);

  // Derrape: reduce el agarre trasero; al soltar, turbo según la carga acumulada
  if (inp.drift && !k.drifting && !spinning && Math.abs(steerIn) > 0.3 && vf > 12) {
    k.drifting = true; k.driftDir = Math.sign(steerIn); k.driftCharge = 0;
  }
  if (k.drifting && (!inp.drift || speed < 8 || spinning)) {
    if (!spinning) {
      if (k.driftCharge > 2) k.boostT = Math.max(k.boostT, 1.3);
      else if (k.driftCharge > 1) k.boostT = Math.max(k.boostT, 0.7);
      // Salida suave: la trayectoria se alinea casi con el morro
      const phi = k.h - k.driftDir * 0.1;
      k.vx = Math.sin(phi) * speed; k.vz = Math.cos(phi) * speed; k.r *= 0.3;
    }
    k.drifting = false; k.driftCharge = 0;
  }

  if (k.drifting) { driftStep(k, inp, dt, slopeAlong, steerIn, throttle, braking, speed); return; }

  let grip = k.offroad ? 0.6 : 1;
  if (spinning) grip *= 0.35;
  const Df = CAR.muF * NZ * grip;
  const Dr = CAR.muR * NZ * grip;

  // Fuerza longitudinal en el eje trasero
  const boosting = k.boostT > 0, star = k.shieldT > 0;
  const power = CAR.power * (1 + (boosting ? 0.45 : 0) + (star ? 0.15 : 0));
  let Fx = 0;
  if (throttle || boosting) Fx = Math.min(CAR.force * (boosting ? 1.5 : 1), power / Math.max(Math.abs(vf), 1));
  if (braking) Fx = vf > 0.5 ? -CAR.brake : vf > -CAR.rev ? -CAR.force * 0.5 : 0;
  Fx = clamp(Fx, -(Df + Dr), Dr * 1.1);
  // Círculo de tracción: acelerar fuerte resta agarre lateral atrás
  const DrLat = Math.sqrt(Math.max(0.05 * Dr * Dr, Dr * Dr - 0.25 * Math.min(Math.abs(Fx), Dr) ** 2));

  // Fuerzas laterales
  const vfs = Math.max(Math.abs(vf), 3), dir = vf >= 0 ? 1 : -1;
  const af = Math.atan2(vl + CAR.a * k.r, vfs) - k.delta * dir;
  const ar = Math.atan2(vl - CAR.b * k.r, vfs);
  const Fyf = pac(af, Df), Fyr = pac(ar, DrLat);

  const cd = Math.cos(k.delta), sd = Math.sin(k.delta);
  const Flon = Fx - Fyf * sd - CAR.m * G * slopeAlong;
  const Flat = Fyf * cd + Fyr;
  // Por unidad de velocidad: aerodinámica cuadrática, rodadura constante y césped viscoso
  const drag = CAR.cd * speed + (speed > 0.1 ? CAR.rr / speed : 0) + (k.offroad ? CAR.offroadRR : 0);
  k.vx += (Flon * sh + Flat * ch - drag * k.vx) / CAR.m * dt;
  k.vz += (Flon * ch - Flat * sh - drag * k.vz) / CAR.m * dt;

  let tau = CAR.a * Fyf * cd - CAR.b * Fyr;
  if (!spinning && Math.abs(vf) > 4) {
    // Control de estabilidad: si el kart cruza más de ~14º fuera del derrape, endereza el morro hacia la trayectoria
    const beta = Math.atan2(vl, Math.abs(vf));
    if (Math.abs(beta) > 0.25) tau += 1800 * (Math.abs(beta) - 0.25) * Math.sign(beta) * dir;
  }
  if (spinning) tau += (9 * k.spinDir - k.r) * CAR.I * 3;
  k.r += tau / CAR.I * dt;
  k.h = wrap(k.h + k.r * dt);
  k.x += k.vx * dt;
  k.z += k.vz * dt;

  if (!throttle && !braking && !boosting && speed < 0.3) { k.vx = 0; k.vz = 0; k.r *= 0.9; }

  tickTimers(k, dt);
  k.vf = vf; k.vl = vl;
  k.beta = speed > 3 ? Math.atan2(vl, Math.abs(vf)) : 0;
  k.lonAcc = Flon / CAR.m; k.latAcc = Flat / CAR.m;
}

function tickTimers(k, dt) {
  k.boostT = Math.max(0, k.boostT - dt);
  k.spinT = Math.max(0, k.spinT - dt);
  k.shieldT = Math.max(0, k.shieldT - dt);
}

// Derrape controlado: la trayectoria gira según el volante (más cerrado o más abierto)
// y el morro se mantiene ~20º hacia dentro. Se pierde algo de velocidad por el roce.
function driftStep(k, inp, dt, slopeAlong, steerIn, throttle, braking, speed) {
  const s = clamp(steerIn * k.driftDir, -1, 1);
  const alat = (k.offroad ? 6 : 12) + 5 * s;
  const phi = Math.atan2(k.vx, k.vz) + k.driftDir * alat / Math.max(speed, 8) * dt;
  const boosting = k.boostT > 0;
  const power = CAR.power * (1 + (boosting ? 0.45 : 0) + (k.shieldT > 0 ? 0.15 : 0));
  let F = throttle || boosting ? Math.min(CAR.force, power / Math.max(speed, 1)) * 0.85 : 0;
  if (braking) F = -CAR.brake * 0.7;
  const resist = CAR.cd * speed * speed + CAR.rr + 0.08 * CAR.m * G + (k.offroad ? CAR.offroadRR * speed : 0);
  const sp = Math.max(0, speed + (F - resist - CAR.m * G * slopeAlong) / CAR.m * dt);
  k.vx = Math.sin(phi) * sp; k.vz = Math.cos(phi) * sp;
  const dh = clamp(wrap(phi + k.driftDir * (0.36 + 0.1 * s) - k.h), -3.5 * dt, 3.5 * dt);
  k.r = dh / dt;
  k.h = wrap(k.h + dh);
  k.x += k.vx * dt; k.z += k.vz * dt;
  const dTarget = -k.driftDir * 0.12 + steerIn * 0.08; // contravolante visual
  k.delta += clamp(dTarget - k.delta, -CAR.steerRate * dt, CAR.steerRate * dt);
  if (sp > 10) k.driftCharge += dt * (1 + 0.4 * Math.max(0, s));
  tickTimers(k, dt);
  const ch = Math.cos(k.h), sh = Math.sin(k.h);
  k.vf = k.vx * sh + k.vz * ch; k.vl = k.vx * ch - k.vz * sh;
  k.beta = Math.atan2(k.vl, Math.abs(k.vf));
  k.lonAcc = (F - resist) / CAR.m; k.latAcc = k.driftDir * alat;
}

// Choque con el muro: k.lat ya calculado; n = normal (derecha) del punto del circuito
export function wallCollide(k, n, limit) {
  if (Math.abs(k.lat) <= limit) return false;
  const s = Math.sign(k.lat), push = s * limit - k.lat;
  k.x += n.x * push; k.z += n.z * push; k.lat = s * limit;
  const vn = k.vx * n.x + k.vz * n.z;
  if (vn * s > 0) {
    k.vx -= 1.25 * vn * n.x; k.vz -= 1.25 * vn * n.z;
    k.vx *= 0.97; k.vz *= 0.97; k.r *= 0.7;
  }
  return true;
}

// Choque entre dos karts (radio 1.2 m). Devuelve la intensidad del impacto
export function kartCollide(A, B, moveA = true, moveB = true) {
  const dx = B.x - A.x, dz = B.z - A.z, d = Math.hypot(dx, dz), R = 2.3;
  if (d < 0.001 || d > R) return 0;
  const nx = dx / d, nz = dz / d, over = R - d;
  const wa = moveA && moveB ? 0.5 : moveA ? 1 : 0, wb = moveA && moveB ? 0.5 : moveB ? 1 : 0;
  A.x -= nx * over * wa; A.z -= nz * over * wa; B.x += nx * over * wb; B.z += nz * over * wb;
  const rel = (B.vx - A.vx) * nx + (B.vz - A.vz) * nz;
  if (rel >= 0) return 0;
  const j = -(1 + 0.35) * rel / 2;
  if (moveA) { A.vx -= j * nx; A.vz -= j * nz; }
  if (moveB) { B.vx += j * nx; B.vz += j * nz; }
  return -rel;
}
