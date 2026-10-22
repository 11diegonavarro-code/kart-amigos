// Modelo 3D del kart y su animación a partir del estado físico.
import * as THREE from 'three';

const black = new THREE.MeshStandardMaterial({ color: 0x18191b, roughness: 0.55, metalness: 0.2 });
const rubber = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.95 });
const metal = new THREE.MeshStandardMaterial({ color: 0xb8bcc2, roughness: 0.25, metalness: 1 });
const darkMetal = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.4, metalness: 0.9 });
const visor = new THREE.MeshStandardMaterial({ color: 0x0a0a12, roughness: 0.05, metalness: 0.8 });
const suit = new THREE.MeshStandardMaterial({ color: 0x24262b, roughness: 0.8 });

// Estrecha las caras delanteras (z > 0) de una caja
function taper(geo, sx, sy) {
  const p = geo.attributes.position;
  for (let i = 0; i < p.count; i++) if (p.getZ(i) > 0) { p.setX(i, p.getX(i) * sx); if (p.getY(i) > 0) p.setY(i, p.getY(i) * sy); }
  geo.computeVertexNormals();
  return geo;
}

function label(text, color) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = 'bold 34px system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.lineWidth = 6; g.strokeStyle = '#000a'; g.strokeText(text, 128, 32);
  g.fillStyle = '#' + new THREE.Color(color).getHexString(); g.fillText(text, 128, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(2.6, 0.65, 1);
  s.position.y = 1.9;
  s.renderOrder = 10;
  return s;
}

export function buildKart(color, name, showLabel) {
  const paint = new THREE.MeshPhysicalMaterial({ color, metalness: 0.25, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.08 });
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const add = (parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z); m.rotation.set(rx, ry, rz);
    m.castShadow = true; m.receiveShadow = true;
    parent.add(m);
    return m;
  };

  // Chasis y carrocería
  add(body, new THREE.BoxGeometry(1.0, 0.06, 1.9), darkMetal, 0, 0.14, 0);
  add(body, taper(new THREE.BoxGeometry(1.1, 0.3, 0.7), 0.6, 0.55), paint, 0, 0.3, 0.95);
  add(body, new THREE.BoxGeometry(1.25, 0.12, 0.16), black, 0, 0.2, 1.33);
  for (const s of [-1, 1]) add(body, taper(new THREE.BoxGeometry(0.28, 0.26, 0.95), 0.8, 0.7), paint, s * 0.68, 0.27, -0.05);
  add(body, new THREE.BoxGeometry(1.32, 0.12, 0.16), black, 0, 0.22, -1.06);
  add(body, new THREE.BoxGeometry(0.5, 0.5, 0.42), black, 0, 0.45, -0.4, -0.25);
  add(body, new THREE.BoxGeometry(0.36, 0.32, 0.36), darkMetal, 0.42, 0.36, -0.76);
  const exhaust = add(body, new THREE.CylinderGeometry(0.06, 0.07, 0.5, 10), metal, 0.42, 0.42, -1.02, Math.PI / 2);
  add(body, new THREE.BoxGeometry(1.15, 0.04, 0.24), paint, 0, 0.78, -0.98, 0.12);
  for (const s of [-1, 1]) add(body, new THREE.BoxGeometry(0.04, 0.5, 0.06), black, s * 0.4, 0.53, -0.98);
  add(body, new THREE.CylinderGeometry(0.025, 0.025, 0.5, 6), darkMetal, 0, 0.45, 0.55, -1.0);
  add(body, new THREE.TorusGeometry(0.16, 0.025, 8, 20), black, 0, 0.64, 0.36, -1.0);

  // Piloto
  add(body, new THREE.CapsuleGeometry(0.2, 0.32, 4, 10), suit, 0, 0.78, -0.3, -0.3);
  const helmet = add(body, new THREE.SphereGeometry(0.18, 20, 16), paint, 0, 1.13, -0.24);
  add(helmet, new THREE.SphereGeometry(0.185, 20, 10, Math.PI / 2 - 0.9, 1.8, 1.1, 0.75), visor, 0, 0, 0);
  for (const s of [-1, 1]) {
    const arm = add(body, new THREE.CapsuleGeometry(0.06, 0.48, 3, 8), suit, s * 0.17, 0.78, 0.04);
    arm.rotation.set(-1.15, 0, s * 0.25);
  }

  // Ruedas (fuera del grupo que se inclina, para que no atraviesen el suelo)
  const wheels = [], pivots = [];
  const wheel = (x, z, r, w, front) => {
    const pivot = new THREE.Group();
    pivot.position.set(x, r, z);
    root.add(pivot);
    const spin = new THREE.Group();
    pivot.add(spin);
    add(spin, new THREE.CylinderGeometry(r, r, w, 20), rubber, 0, 0, 0, 0, 0, Math.PI / 2);
    add(spin, new THREE.CylinderGeometry(r * 0.62, r * 0.62, w + 0.02, 12), metal, 0, 0, 0, 0, 0, Math.PI / 2);
    wheels.push(spin);
    if (front) pivots.push(pivot);
  };
  for (const s of [-1, 1]) wheel(s * 0.62, 0.78, 0.25, 0.18, true);
  for (const s of [-1, 1]) wheel(s * 0.66, -0.75, 0.27, 0.26, false);

  // Turbo y escudo
  const flame = new THREE.Group();
  const outerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.13, 0.9, 10), new THREE.MeshBasicMaterial({ color: 0xff6a00, transparent: true, opacity: 0.85 }));
  const innerFlame = new THREE.Mesh(new THREE.ConeGeometry(0.07, 0.55, 10), new THREE.MeshBasicMaterial({ color: 0xfff2a0 }));
  outerFlame.position.y = innerFlame.position.y = 0.4;
  flame.add(outerFlame, innerFlame);
  flame.position.set(0.42, 0.42, -1.27);
  flame.rotation.x = -Math.PI / 2;
  body.add(flame);
  const shield = new THREE.Mesh(new THREE.SphereGeometry(1.45, 24, 16), new THREE.MeshStandardMaterial({
    color: 0x66e0ff, emissive: 0x33bbff, emissiveIntensity: 1.5, transparent: true, opacity: 0.22, depthWrite: false, roughness: 0.1,
  }));
  shield.position.y = 0.6;
  root.add(shield);

  if (showLabel) root.add(label(name, color));

  const exhaustPos = new THREE.Vector3();
  return {
    root,
    exhaustWorld: () => exhaust.getWorldPosition(exhaustPos),
    // Coordenadas mundo de las ruedas traseras (para humo y marcas)
    rearWheels(k) {
      const ch = Math.cos(k.h), sh = Math.sin(k.h), y = k.ground + 0.02;
      const bx = k.x - sh * 0.75, bz = k.z - ch * 0.75;
      return [{ x: bx + ch * 0.66, y, z: bz - sh * 0.66 }, { x: bx - ch * 0.66, y, z: bz + sh * 0.66 }];
    },
    update(k, dt, time) {
      root.position.set(k.x, k.ground + (k.hop || 0), k.z);
      root.rotation.y = k.h;
      const roll = THREE.MathUtils.clamp(-(k.latAcc || 0) * 0.008, -0.1, 0.1);
      const pitch = THREE.MathUtils.clamp((k.lonAcc || 0) * 0.006, -0.06, 0.06);
      body.rotation.z += (roll - body.rotation.z) * Math.min(1, 10 * dt);
      body.rotation.x += (-pitch - body.rotation.x) * Math.min(1, 10 * dt);
      for (const w of wheels) w.rotation.x += (k.vf || 0) * dt / 0.26;
      for (const p of pivots) p.rotation.y = k.delta || 0;
      flame.visible = k.boostT > 0;
      if (flame.visible) flame.scale.set(1, 0.7 + Math.random() * 0.6, 1);
      shield.visible = k.shieldT > 0;
      if (shield.visible) shield.material.opacity = 0.18 + 0.08 * Math.sin(time * 12);
    },
    dispose() { root.removeFromParent(); },
  };
}
