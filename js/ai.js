// Conducción de los bots: persecución pura para girar y perfil de velocidad para frenar a tiempo.
import { pts, nor, N, DS, clamp, speedProfile } from './track-data.js';
import { CAR, speedOf } from './physics.js';

const VPROF = speedProfile(11, 8, 34);

export function botInput(k, bot) {
  const v = speedOf(k);
  bot.laneT -= 1 / 60;
  if (bot.laneT <= 0) { bot.lane = (Math.random() - 0.5) * 5; bot.laneT = 3 + Math.random() * 4; }
  const look = Math.round((5 + v * 0.45) / DS);
  const i = (k.idx + look) % N;
  const dx = pts[i].x + nor[i].x * bot.lane - k.x, dz = pts[i].z + nor[i].z * bot.lane - k.z;
  const ch = Math.cos(k.h), sh = Math.sin(k.h);
  const alpha = Math.atan2(dx * ch - dz * sh, dx * sh + dz * ch);
  const delta = Math.atan(2 * (CAR.a + CAR.b) * Math.sin(alpha) / Math.max(Math.hypot(dx, dz), 1));
  const dmax = CAR.steerMax / (1 + Math.abs(k.vf) / 22);
  let vt = Infinity;
  for (let o = 0; o <= look; o += 2) vt = Math.min(vt, VPROF[(k.idx + o) % N]);
  vt = Math.min(vt * 0.9, 34 * bot.skill); // en curva todos prudentes; la habilidad solo cambia la punta
  const stuck = Math.abs(alpha) > 1.6;
  return {
    steer: clamp(delta / dmax, -1, 1) * (stuck && k.vf < 0 ? -1 : 1),
    up: !stuck && v < vt,
    down: stuck || v > vt + 2.5,
    drift: false,
  };
}
