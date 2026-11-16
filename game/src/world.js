// DUSTLINE world — the "Rustworks" industrial yard.
// Original 3-lane map: A-long (west crane yard), mid (container lane),
// B-tunnel (east warehouse). All geometry is procedural boxes and
// cylinders; nothing is loaded from the network.
// Coordinates: x east-west (-30..30), z north-south (-20..20).
// Vanguard spawns south (z +17), Wardens north (z -17).
// Site A is the west crane yard, Site B the east warehouse.
import * as THREE from 'three';
import { PALETTE } from './palette.js';

// A collider is an XZ box with a height: { minX, maxX, minZ, maxZ, top }.
export function makeBoxCollider(x, z, w, d, h) {
  return { minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2, top: h };
}

// Circle (player/bot radius r) vs AABB, XZ only. Returns the pushed-out
// position, or the input position when there is no overlap.
export function resolveCircleVsBoxes(pos, r, colliders) {
  const out = { x: pos.x, z: pos.z };
  for (const b of colliders) {
    const cx = Math.max(b.minX, Math.min(out.x, b.maxX));
    const cz = Math.max(b.minZ, Math.min(out.z, b.maxZ));
    const dx = out.x - cx;
    const dz = out.z - cz;
    const d2 = dx * dx + dz * dz;
    if (d2 >= r * r) continue;
    if (d2 > 1e-8) {
      const d = Math.sqrt(d2);
      out.x = cx + (dx / d) * r;
      out.z = cz + (dz / d) * r;
    } else {
      // Centre is inside the box: push out along the smallest penetration axis.
      const pl = out.x - b.minX;
      const pr = b.maxX - out.x;
      const pt = out.z - b.minZ;
      const pb = b.maxZ - out.z;
      const m = Math.min(pl, pr, pt, pb);
      if (m === pl) out.x = b.minX - r;
      else if (m === pr) out.x = b.maxX + r;
      else if (m === pt) out.z = b.minZ - r;
      else out.z = b.maxZ + r;
    }
  }
  return out;
}

// Segment (eye height) vs box slab test. True when a wall blocks the shot.
export function segmentBlocked(ax, ay, az, bx, by, bz, colliders) {
  const dx = bx - ax;
  const dy = by - ay;
  const dz = bz - az;
  for (const b of colliders) {
    if (Math.max(ay, by) < 0 || Math.min(ay, by) > b.top) continue;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    // X slab
    if (Math.abs(dx) < 1e-9) {
      if (ax < b.minX || ax > b.maxX) ok = false;
    } else {
      let ta = (b.minX - ax) / dx;
      let tb = (b.maxX - ax) / dx;
      if (ta > tb) { const t = ta; ta = tb; tb = t; }
      t0 = Math.max(t0, ta);
      t1 = Math.min(t1, tb);
      if (t0 > t1) ok = false;
    }
    // Z slab
    if (ok) {
      if (Math.abs(dz) < 1e-9) {
        if (az < b.minZ || az > b.maxZ) ok = false;
      } else {
        let ta = (b.minZ - az) / dz;
        let tb = (b.maxZ - az) / dz;
        if (ta > tb) { const t = ta; ta = tb; tb = t; }
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) ok = false;
      }
    }
    // Y slab (box spans 0..top)
    if (ok && Math.abs(dy) > 1e-9) {
      const ta = (0 - ay) / dy;
      const tb = (b.top - ay) / dy;
      const lo = Math.min(ta, tb);
      const hi = Math.max(ta, tb);
      t0 = Math.max(t0, lo);
      t1 = Math.min(t1, hi);
      if (t0 > t1) ok = false;
    }
    if (ok && t1 >= 0 && t0 <= 1) return true;
  }
  return false;
}

function textSpriteTexture(letter, bg, fg) {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = bg;
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = fg;
  g.lineWidth = 6;
  g.strokeRect(4, 4, 120, 120);
  g.fillStyle = fg;
  g.font = 'bold 84px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(letter, 64, 70);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildWorld(scene) {
  const colliders = [];
  const wallMeshes = [];
  const mats = {
    ground: new THREE.MeshStandardMaterial({ color: PALETTE.ground, roughness: 0.95 }),
    steel: new THREE.MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.55, metalness: 0.55 }),
    slate: new THREE.MeshStandardMaterial({ color: PALETTE.slate, roughness: 0.8, metalness: 0.25 }),
    rust: new THREE.MeshStandardMaterial({ color: 0x8a4a22, roughness: 0.85, metalness: 0.3 }),
    containerA: new THREE.MeshStandardMaterial({ color: 0x7a5a2e, roughness: 0.8, metalness: 0.35 }),
    containerB: new THREE.MeshStandardMaterial({ color: 0x4a5a6a, roughness: 0.8, metalness: 0.35 }),
    containerC: new THREE.MeshStandardMaterial({ color: 0x6a3a2a, roughness: 0.8, metalness: 0.35 }),
    amber: new THREE.MeshStandardMaterial({ color: PALETTE.amber, emissive: PALETTE.amber, emissiveIntensity: 1.6, roughness: 0.4 }),
    crate: new THREE.MeshStandardMaterial({ color: 0x6b543a, roughness: 0.9 }),
    barrel: new THREE.MeshStandardMaterial({ color: 0x7a2e1e, roughness: 0.7, metalness: 0.4 }),
  };

  function addBox(x, z, w, h, d, mat, collide = true, y = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    mesh.position.set(x, y + h / 2, z);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    scene.add(mesh);
    if (collide) {
      colliders.push(makeBoxCollider(x, z, w, d, y + h));
      wallMeshes.push(mesh);
    }
    return mesh;
  }

  // Ground
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(64, 44), mats.ground);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Perimeter walls (tall, block sight + movement)
  addBox(0, -21, 64, 5, 2, mats.slate); // north
  addBox(0, 21, 64, 5, 2, mats.slate); // south
  addBox(-31, 0, 2, 5, 44, mats.slate); // west
  addBox(31, 0, 2, 5, 44, mats.slate); // east

  // Mid lane: three stacked containers forming the central fight line
  addBox(-2, 2, 6, 2.6, 2.4, mats.containerA);
  addBox(3, -2, 6, 2.6, 2.4, mats.containerB);
  addBox(0, 6, 2.4, 2.6, 6, mats.containerC);
  // Second layer on the big container (cover from above, blocks long sight)
  addBox(-2, 2, 6, 1.4, 2.4, mats.containerB, true, 2.6);

  // A-long (west lane): crane base + crates
  addBox(-24, -6, 4, 3.2, 4, mats.rust);
  addBox(-26, 4, 3, 1.6, 3, mats.crate);
  addBox(-20, 10, 2.4, 1.2, 2.4, mats.crate);
  addBox(-27, -14, 5, 2.2, 1.6, mats.containerC);
  // Crane legs at Site A (visual, tall thin boxes)
  addBox(-26, -16, 0.8, 9, 0.8, mats.steel);
  addBox(-18, -16, 0.8, 9, 0.8, mats.steel);
  addBox(-22, -16, 9, 0.8, 0.8, mats.steel, false, 8.6);

  // B-tunnel (east lane): warehouse wall with a gap, crates
  addBox(24, -6, 4, 3.2, 4, mats.rust);
  addBox(26, 4, 3, 1.6, 3, mats.crate);
  addBox(20, 10, 2.4, 1.2, 2.4, mats.crate);
  addBox(27, -14, 5, 2.2, 1.6, mats.containerB);
  // Warehouse block north-east, forces the B push through the gap at x 18..22
  addBox(27, -12, 6, 4.5, 8, mats.slate);

  // Connector walls between mid and the lanes (create corners to play around)
  addBox(-12, -6, 1.2, 2.8, 8, mats.steel);
  addBox(12, -6, 1.2, 2.8, 8, mats.steel);
  addBox(-12, 8, 6, 2.2, 1.2, mats.containerA);
  addBox(12, 8, 6, 2.2, 1.2, mats.containerB);

  // Barrels as low cover (block movement, not sight)
  const barrelGeo = new THREE.CylinderGeometry(0.55, 0.55, 1.15, 12);
  for (const [x, z] of [[-6, -12], [-4.6, -12], [6, -12], [7.4, -12], [-14, 2], [14, 2], [0, -14], [-8, 14], [8, 14]]) {
    const b = new THREE.Mesh(barrelGeo, mats.barrel);
    b.position.set(x, 0.575, z);
    b.castShadow = true;
    b.receiveShadow = true;
    scene.add(b);
    colliders.push(makeBoxCollider(x, z, 1.1, 1.1, 1.15));
    wallMeshes.push(b);
  }

  // Amber strip lights along the lanes (emissive, no collision). The two
  // spawn strips mark the safe ground each team starts on.
  for (const [x, z] of [[-24, 0], [24, 0], [0, -10], [0, 12], [-22, -12], [22, -12], [0, 17], [0, -17]]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.08, 0.3), mats.amber);
    strip.position.set(x, 3.4, z);
    scene.add(strip);
  }

  // Site markers: floating A / B signs + ground rings
  const sites = {
    A: { x: -22, z: -12 },
    B: { x: 22, z: -12 },
  };
  for (const [letter, s] of Object.entries(sites)) {
    const tex = textSpriteTexture(letter, '#241d17', '#f0a830');
    const sign = new THREE.Mesh(
      new THREE.PlaneGeometry(2.4, 2.4),
      new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
    );
    sign.position.set(s.x, 4.6, s.z);
    scene.add(sign);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(2.2, 2.6, 32),
      new THREE.MeshBasicMaterial({ color: PALETTE.rust, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(s.x, 0.03, s.z);
    scene.add(ring);
  }

  // Waypoint graph: named points bots route through.
  const wp = {
    vSpawn: { x: 0, z: 17 },
    vSpawnL: { x: -8, z: 17 },
    vSpawnR: { x: 8, z: 17 },
    midSouth: { x: 0, z: 9 },
    mid: { x: 0, z: 0 },
    midNorth: { x: 0, z: -9 },
    aLong1: { x: -20, z: 8 },
    aLong2: { x: -25, z: -4 },
    aSite: { x: -22, z: -12 },
    aConn: { x: -12, z: -10 },
    bTun1: { x: 20, z: 8 },
    bTun2: { x: 25, z: -4 },
    bSite: { x: 22, z: -12 },
    bConn: { x: 12, z: -10 },
    wSpawn: { x: 0, z: -17 },
    wSpawnL: { x: -8, z: -17 },
    wSpawnR: { x: 8, z: -17 },
    wA: { x: -16, z: -14 },
    wB: { x: 16, z: -14 },
    wMid: { x: 0, z: -12 },
  };
  const routes = {
    A: ['vSpawn', 'aLong1', 'aLong2', 'aSite'],
    B: ['vSpawn', 'bTun1', 'bTun2', 'bSite'],
    mid: ['vSpawn', 'midSouth', 'mid', 'midNorth'],
    Aalt: ['vSpawn', 'midSouth', 'mid', 'aConn', 'aSite'],
    Balt: ['vSpawn', 'midSouth', 'mid', 'bConn', 'bSite'],
  };

  return {
    colliders,
    wallMeshes,
    sites,
    waypoints: wp,
    routes,
    bounds: { minX: -30, maxX: 30, minZ: -20, maxZ: 20 },
    spawns: {
      V: [{ x: 0, z: 17 }, { x: -6, z: 18 }, { x: 6, z: 18 }, { x: -12, z: 16 }, { x: 12, z: 16 }],
      W: [{ x: 0, z: -17 }, { x: -6, z: -18 }, { x: 6, z: -18 }, { x: -12, z: -16 }, { x: 12, z: -16 }],
    },
  };
}
