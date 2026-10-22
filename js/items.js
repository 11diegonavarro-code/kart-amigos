// Cajas de objetos, poderes y proyectiles. Cada cliente decide si SUS karts reciben un impacto y lo comunica.
import * as THREE from 'three';
import { pts, nor, N, WALL, ITEM_ROWS, ITEM_LANES, locate, nearestIdx, clamp, wrap } from './track-data.js';

export const ITEMS = {
  turbo: { icon: '🚀', name: 'Turbo' },
  cascara: { icon: '🍌', name: 'Cáscara' },
  misil: { icon: '🟢', name: 'Misil' },
  guiado: { icon: '🎯', name: 'Misil guiado' },
  escudo: { icon: '🛡️', name: 'Escudo' },
  bomba: { icon: '💣', name: 'Bomba' },
};
// Probabilidades para el primero y para el último; en medio se interpola
const FRONT = { turbo: 15, cascara: 35, misil: 35, guiado: 0, escudo: 0, bomba: 15 };
const BACK = { turbo: 30, cascara: 5, misil: 10, guiado: 25, escudo: 15, bomba: 15 };

export function rollItem(place, total) {
  const f = total > 1 ? (place - 1) / (total - 1) : 0;
  const w = Object.keys(ITEMS).map(k => [k, FRONT[k] * (1 - f) + BACK[k] * f]);
  let r = Math.random() * w.reduce((a, [, v]) => a + v, 0);
  for (const [k, v] of w) if ((r -= v) <= 0) return k;
  return 'turbo';
}

function questionTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = '#ffffffaa'; g.lineWidth = 10; g.strokeRect(5, 5, 118, 118);
  g.fillStyle = '#1b1b2f'; g.font = 'bold 92px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText('?', 64, 70);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const shellGeo = new THREE.SphereGeometry(0.45, 20, 12).scale(1, 0.6, 1);
const ringGeo = new THREE.TorusGeometry(0.45, 0.06, 8, 24).rotateX(Math.PI / 2);
function makeMesh(type) {
  const g = new THREE.Group();
  if (type === 'misil' || type === 'guiado') {
    g.add(new THREE.Mesh(shellGeo, new THREE.MeshPhysicalMaterial({ color: type === 'misil' ? 0x22c55e : 0xef4444, roughness: 0.25, clearcoat: 1 })));
    g.add(new THREE.Mesh(ringGeo, new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.4 })));
  } else if (type === 'cascara') {
    const mat = new THREE.MeshStandardMaterial({ color: 0xf2cf3a, roughness: 0.6 });
    for (let i = 0; i < 3; i++) {
      const p = new THREE.Mesh(new THREE.CapsuleGeometry(0.12, 0.45, 4, 8), mat);
      p.rotation.set(1.1, (i / 3) * Math.PI * 2, 0);
      p.position.set(Math.sin((i / 3) * Math.PI * 2) * 0.2, 0.12, Math.cos((i / 3) * Math.PI * 2) * 0.2);
      g.add(p);
    }
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.25, 6), new THREE.MeshStandardMaterial({ color: 0x4a3420 }));
    tip.position.y = 0.3;
    g.add(tip);
  } else if (type === 'bomba') {
    g.add(new THREE.Mesh(new THREE.SphereGeometry(0.5, 20, 14), new THREE.MeshStandardMaterial({ color: 0x15151a, metalness: 0.6, roughness: 0.3 })));
    const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.3, 6), new THREE.MeshStandardMaterial({ color: 0x8b6b3a }));
    fuse.position.y = 0.6;
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.1, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffaa33 }));
    spark.position.y = 0.78;
    spark.name = 'spark';
    g.add(fuse, spark);
  }
  g.traverse(m => { m.castShadow = true; });
  return g;
}

export class Items {
  constructor(game) {
    this.g = game;
    this.scene = game.world.scene;
    this.boxes = [];
    this.objs = new Map();
    this.seq = 0;
    const tex = questionTexture(), geo = new THREE.BoxGeometry(1.3, 1.3, 1.3);
    ITEM_ROWS.forEach((idx, r) => ITEM_LANES.forEach((lane, l) => {
      const p = pts[idx], n = nor[idx];
      const mesh = new THREE.Mesh(geo, new THREE.MeshPhysicalMaterial({
        map: tex, transparent: true, opacity: 0.88, emissive: 0xffffff, emissiveIntensity: 0.25, roughness: 0.15, clearcoat: 1,
      }));
      mesh.castShadow = true;
      const b = { id: r * 10 + l, x: p.x + n.x * lane, y: p.y + 1.2, z: p.z + n.z * lane, active: true, t: 0, mesh, phase: Math.random() * 6 };
      mesh.position.set(b.x, b.y, b.z);
      this.scene.add(mesh);
      this.boxes.push(b);
    }));
  }

  reset() {
    for (const b of this.boxes) { b.active = true; b.mesh.visible = true; }
    for (const id of [...this.objs.keys()]) this.remove(id);
  }

  remove(id) {
    const o = this.objs.get(id);
    if (!o) return;
    o.mesh.removeFromParent();
    this.objs.delete(id);
  }

  takeBox(id) {
    const b = this.boxes.find(b => b.id === id);
    if (b) { b.active = false; b.t = 4; b.mesh.visible = false; }
  }

  // Comprueba si un kart propio recoge una caja
  pickup(k) {
    const s = k.s;
    for (const b of this.boxes) {
      if (!b.active || (s.x - b.x) ** 2 + (s.z - b.z) ** 2 > 2.4 * 2.4) continue;
      this.takeBox(b.id);
      this.g.net.send({ t: 'box', b: b.id });
      if (!k.item && k.itemRoll <= 0) {
        k.pending = rollItem(this.g.placeOf(k), this.g.karts.length);
        k.itemRoll = 1.1;
        if (k.isPlayer) this.g.sound.sfx('pickup');
      }
    }
  }

  use(k, back) {
    const type = k.item;
    if (!type) return;
    k.item = null;
    const s = k.s, fx = Math.sin(s.h), fz = Math.cos(s.h);
    if (k.isPlayer) this.g.sound.sfx(type === 'turbo' ? 'boost' : 'item');
    if (type === 'turbo') { s.boostT = Math.max(s.boostT, 1.6); return; }
    if (type === 'escudo') { s.shieldT = 6; return; }
    const o = { id: `${this.g.net.me}-${++this.seq}`, type, owner: k.id, x: s.x, y: s.ground + 0.4, z: s.z, vx: 0, vy: 0, vz: 0 };
    if (type === 'cascara' || (type === 'bomba' && back)) {
      o.x -= fx * 2.4; o.z -= fz * 2.4;
    } else if (type === 'misil' || type === 'guiado') {
      const d = back ? -1 : 1;
      o.x += fx * 2.2 * d; o.z += fz * 2.2 * d;
      o.vx = fx * 52 * d; o.vz = fz * 52 * d;
      if (type === 'guiado' && !back) o.target = this.g.kartAhead(k)?.id ?? null;
    } else if (type === 'bomba') {
      const sp = Math.max(0, s.vf) + 15;
      o.x += fx * 1.6; o.z += fz * 1.6; o.y += 0.6;
      o.vx = fx * sp; o.vz = fz * sp; o.vy = 7;
    }
    this.spawn(o, s.idx);
    this.g.net.send({ t: 'spawn', o });
  }

  spawn(data, idxHint) {
    const o = { ...data, t: 0, idx: idxHint ?? nearestIdx(data.x, data.z), lat: 0, ground: 0, landed: data.type === 'bomba' && !data.vy, fuse: 1.2 };
    o.mesh = makeMesh(o.type);
    this.scene.add(o.mesh);
    this.objs.set(o.id, o);
    locate(o);
    // Límite de cáscaras en pista
    const peels = [...this.objs.values()].filter(x => x.type === 'cascara');
    if (peels.length > 30) this.remove(peels[0].id);
  }

  update(dt, time) {
    for (const b of this.boxes) {
      if (!b.active) { if ((b.t -= dt) <= 0) { b.active = true; b.mesh.visible = true; } continue; }
      b.mesh.rotation.set(time * 0.7 + b.phase, time + b.phase, 0);
      b.mesh.position.y = b.y + Math.sin(time * 2 + b.phase) * 0.15;
      b.mesh.material.color.setHSL((time * 0.15 + b.phase) % 1, 0.85, 0.62);
    }

    for (const o of [...this.objs.values()]) {
      o.t += dt;
      if (o.type === 'misil' || o.type === 'guiado') {
        if (o.type === 'guiado') {
          const tk = o.target != null ? this.g.kartById(o.target) : null;
          let tx, tz;
          if (tk && (tk.s.x - o.x) ** 2 + (tk.s.z - o.z) ** 2 < 35 * 35) { tx = tk.s.x; tz = tk.s.z; }
          else { const i = (o.idx + 10) % N; tx = pts[i].x; tz = pts[i].z; }
          const cur = Math.atan2(o.vx, o.vz);
          const nh = cur + clamp(wrap(Math.atan2(tx - o.x, tz - o.z) - cur), -5 * dt, 5 * dt);
          o.vx = Math.sin(nh) * 48; o.vz = Math.cos(nh) * 48;
        }
        o.x += o.vx * dt; o.z += o.vz * dt;
        locate(o);
        if (Math.abs(o.lat) > WALL) {
          const n = nor[o.idx], vn = o.vx * n.x + o.vz * n.z, s = Math.sign(o.lat);
          if (vn * s > 0) { o.vx -= 2 * vn * n.x; o.vz -= 2 * vn * n.z; }
          o.x += n.x * (s * WALL - o.lat); o.z += n.z * (s * WALL - o.lat);
        }
        o.y = o.ground + 0.35;
        o.mesh.rotation.y += dt * 14;
        if (o.t > (o.type === 'guiado' ? 9 : 6)) { this.remove(o.id); continue; }
        // Un misil destruye las cáscaras que toca
        for (const p of this.objs.values()) {
          if (p.type === 'cascara' && (p.x - o.x) ** 2 + (p.z - o.z) ** 2 < 2) { this.remove(p.id); this.remove(o.id); break; }
        }
        if (!this.objs.has(o.id)) continue;
      } else if (o.type === 'bomba') {
        if (!o.landed) {
          o.vy -= 20 * dt;
          o.x += o.vx * dt; o.z += o.vz * dt; o.y += o.vy * dt;
          locate(o);
          if (Math.abs(o.lat) > WALL) { const n = nor[o.idx]; o.x += n.x * (Math.sign(o.lat) * WALL - o.lat); o.z += n.z * (Math.sign(o.lat) * WALL - o.lat); }
          if (o.y <= o.ground + 0.5) { o.y = o.ground + 0.5; o.landed = true; }
        } else if ((o.fuse -= dt) <= 0) {
          this.explode(o);
          continue;
        }
        const spark = o.mesh.getObjectByName('spark');
        if (spark) spark.visible = Math.sin(time * 30) > 0;
      } else {
        o.y = o.ground + 0.05;
      }
      o.mesh.position.set(o.x, o.y, o.z);

      // Impactos contra karts controlados por este cliente
      for (const k of this.g.karts) {
        if (!k.owned) continue;
        if (o.owner === k.id && o.t < 0.6) continue;
        const r = o.type === 'bomba' ? 1.6 : 1.5;
        if ((k.s.x - o.x) ** 2 + (k.s.z - o.z) ** 2 > r * r) continue;
        if (o.type === 'bomba') { o.fuse = 0; this.g.net.send({ t: 'hit', o: o.id }); break; }
        if (k.s.shieldT <= 0) this.g.hitKart(k, o.type);
        this.remove(o.id);
        this.g.net.send({ t: 'hit', o: o.id });
        break;
      }
    }
  }

  explode(o) {
    this.g.fx.explosion(o.x, o.ground, o.z);
    this.g.sound.sfx('boom');
    for (const k of this.g.karts) {
      if (k.owned && k.s.shieldT <= 0 && (k.s.x - o.x) ** 2 + (k.s.z - o.z) ** 2 < 8 * 8) this.g.hitKart(k, 'bomba');
    }
    this.remove(o.id);
  }

  onRemoteHit(id) {
    const o = this.objs.get(id);
    if (o?.type === 'bomba') this.explode(o);
    else this.remove(id);
  }
}

// IA de objetos: espera un rato y lo usa
export function botUseItem(k, items, dt) {
  if (!k.item) return;
  k.ai.itemT = (k.ai.itemT ?? 1 + Math.random() * 3) - dt;
  if (k.ai.itemT > 0) return;
  k.ai.itemT = undefined;
  items.use(k, false);
}
