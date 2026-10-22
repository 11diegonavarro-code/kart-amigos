// Partículas, marcas de neumático y explosiones con pools reutilizables.
import * as THREE from 'three';

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d'), grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class FX {
  constructor(scene, high) {
    this.scene = scene;
    const tex = puffTexture();
    const mk = (count, additive) => Array.from({ length: count }, () => {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex, transparent: true, depthWrite: false,
        blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      }));
      s.visible = false;
      scene.add(s);
      return { s, life: 0, max: 1, vx: 0, vy: 0, vz: 0, grow: 0, alpha: 1 };
    });
    this.smoke = mk(high ? 260 : 120, false);
    this.sparks = mk(high ? 160 : 80, true);
    this.si = 0; this.pi = 0;

    // Marcas de neumático
    this.SKIDS = high ? 2400 : 1000;
    const skidGeo = new THREE.PlaneGeometry(0.24, 0.7).rotateX(-Math.PI / 2);
    this.skids = new THREE.InstancedMesh(skidGeo, new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.45, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2,
    }), this.SKIDS);
    this.skids.frustumCulled = false;
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.SKIDS; i++) this.skids.setMatrixAt(i, zero);
    scene.add(this.skids);
    this.ki = 0;
    this.m = new THREE.Matrix4(); this.q = new THREE.Quaternion(); this.v = new THREE.Vector3(); this.one = new THREE.Vector3(1, 1, 1); this.up = new THREE.Vector3(0, 1, 0);

    // Explosiones
    this.booms = Array.from({ length: 4 }, () => {
      const m = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffa040, transparent: true, depthWrite: false }));
      m.visible = false;
      scene.add(m);
      return { m, t: 0 };
    });
  }

  smokeAt(x, y, z, color = 0xdddddd, size = 0.9, life = 1.2, alpha = 0.55) {
    const p = this.smoke[this.si = (this.si + 1) % this.smoke.length];
    p.s.position.set(x, y + 0.2, z);
    p.s.material.color.set(color);
    p.s.scale.setScalar(size);
    Object.assign(p, { life, max: life, vx: (Math.random() - 0.5) * 1.2, vy: 0.6 + Math.random() * 0.8, vz: (Math.random() - 0.5) * 1.2, grow: 1.6, alpha });
    p.s.visible = true;
  }

  sparkAt(x, y, z, color) {
    const p = this.sparks[this.pi = (this.pi + 1) % this.sparks.length];
    p.s.position.set(x, y + 0.15, z);
    p.s.material.color.set(color);
    p.s.scale.setScalar(0.25 + Math.random() * 0.2);
    Object.assign(p, { life: 0.3, max: 0.3, vx: (Math.random() - 0.5) * 5, vy: 1 + Math.random() * 3, vz: (Math.random() - 0.5) * 5, grow: -0.5, alpha: 1 });
    p.s.visible = true;
  }

  skid(x, y, z, h) {
    this.q.setFromAxisAngle(this.up, h);
    this.m.compose(this.v.set(x, y + 0.04, z), this.q, this.one);
    this.skids.setMatrixAt(this.ki = (this.ki + 1) % this.SKIDS, this.m);
    this.skids.instanceMatrix.needsUpdate = true;
  }

  explosion(x, y, z) {
    const b = this.booms.find(b => !b.m.visible) || this.booms[0];
    b.m.position.set(x, y + 1, z);
    b.t = 0;
    b.m.visible = true;
    for (let i = 0; i < 24; i++) this.smokeAt(x + (Math.random() - 0.5) * 5, y, z + (Math.random() - 0.5) * 5, i % 3 ? 0x555555 : 0xff8a30, 3, 1.8, 0.8);
  }

  update(dt) {
    for (const list of [this.smoke, this.sparks]) for (const p of list) {
      if (!p.s.visible) continue;
      p.life -= dt;
      if (p.life <= 0) { p.s.visible = false; continue; }
      p.s.position.x += p.vx * dt; p.s.position.y += p.vy * dt; p.s.position.z += p.vz * dt;
      if (list === this.sparks) p.vy -= 12 * dt;
      p.s.scale.multiplyScalar(1 + p.grow * dt);
      p.s.material.opacity = p.alpha * (p.life / p.max);
    }
    for (const b of this.booms) {
      if (!b.m.visible) continue;
      b.t += dt;
      b.m.scale.setScalar(1 + b.t * 22);
      b.m.material.opacity = Math.max(0, 1 - b.t / 0.45);
      if (b.t > 0.45) b.m.visible = false;
    }
  }
}
