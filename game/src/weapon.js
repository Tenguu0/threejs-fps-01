// DUSTLINE weapons — fictional arsenal, one table, no per-frame allocation
// in the hot path (a single shared THREE.Raycaster + temp vectors).
import * as THREE from 'three';
import { playShot, playDryFire } from './audio.js';

export const WEAPONS = {
  sidewinder: {
    name: 'Sidewinder', kind: 'pistol', price: 0, damage: 28, headMult: 2,
    rpm: 380, mag: 12, reserve: Infinity, spread: 0.016, auto: false,
    reloadTime: 1.5, range: 60,
  },
  jackal: {
    name: 'VK-9 "Jackal"', kind: 'rifle', price: 2700, damage: 34, headMult: 2,
    rpm: 600, mag: 30, reserve: 120, spread: 0.012, auto: true,
    reloadTime: 2.4, range: 90,
  },
  hornet: {
    name: 'Hornet-9', kind: 'smg', price: 1500, damage: 26, headMult: 2,
    rpm: 900, mag: 25, reserve: 100, spread: 0.02, auto: true,
    reloadTime: 2.0, range: 55,
  },
  longshot: {
    name: 'Longshot .50', kind: 'sniper', price: 4750, damage: 95, headMult: 2,
    rpm: 48, mag: 5, reserve: 15, spread: 0.0015, auto: false,
    reloadTime: 3.2, range: 120,
  },
};

export const GRENADES = {
  flash: { name: 'Flashbang', price: 200 },
  smoke: { name: 'Smoke', price: 300 },
};

const raycaster = new THREE.Raycaster();
const _dir = new THREE.Vector3();
const _origin = new THREE.Vector3();

// Per-holder weapon state. `holder` is the player object or a bot.
export function createLoadout() {
  return {
    current: 'jackal',
    mag: { sidewinder: 12, jackal: 30, hornet: 25, longshot: 5 },
    reserve: { sidewinder: Infinity, jackal: 120, hornet: 100, longshot: 15 },
    owned: new Set(['sidewinder', 'jackal']),
    reloading: false,
    reloadEnd: 0,
    nextShotAt: 0,
    grenades: { flash: 0, smoke: 0 },
    spreadBloom: 0, // grows while spraying, decays when idle
  };
}

export function weaponOf(loadout) {
  return WEAPONS[loadout.current];
}

export function switchWeapon(loadout, key, time) {
  if (loadout.owned.has(key) && loadout.current !== key) {
    loadout.current = key;
    loadout.reloading = false;
    loadout.nextShotAt = Math.max(loadout.nextShotAt, time + 0.25);
    return true;
  }
  return false;
}

export function startReload(loadout, time) {
  const w = weaponOf(loadout);
  if (loadout.reloading) return false;
  if (loadout.mag[loadout.current] >= w.mag) return false;
  if (loadout.reserve[loadout.current] <= 0) return false;
  loadout.reloading = true;
  loadout.reloadEnd = time + w.reloadTime;
  return true;
}

export function finishReload(loadout) {
  const w = weaponOf(loadout);
  const need = w.mag - loadout.mag[loadout.current];
  const take = Math.min(need, loadout.reserve[loadout.current]);
  loadout.mag[loadout.current] += take;
  if (Number.isFinite(loadout.reserve[loadout.current])) {
    loadout.reserve[loadout.current] -= take;
  }
  loadout.reloading = false;
}

// Fire one hitscan shot. `shooter` = { team, isPlayer, pos(Vector3 eye),
// yaw, pitch }. `targets` = array of shootable meshes (bot parts + walls).
// Returns null when the shot cannot fire yet, else { hit, kill, headshot,
// point, target }.
export function fireWeapon(state, shooter, loadout, moveSpread, time) {
  const w = weaponOf(loadout);
  if (time < loadout.nextShotAt) return null;
  if (loadout.reloading) return null;
  if (loadout.mag[loadout.current] <= 0) {
    loadout.nextShotAt = time + 0.25;
    if (shooter.isPlayer) playDryFire();
    return { dry: true };
  }
  loadout.mag[loadout.current] -= 1;
  loadout.nextShotAt = time + 60 / w.rpm;
  // Recoil + spread: bloom grows while spraying and while moving.
  loadout.spreadBloom = Math.min(0.05, loadout.spreadBloom + (w.kind === 'sniper' ? 0.012 : 0.004));
  const spread = w.spread + moveSpread + loadout.spreadBloom;

  _dir.set(
    (Math.random() - 0.5) * 2 * spread - Math.sin(shooter.yaw) * Math.cos(shooter.pitch),
    Math.sin(shooter.pitch) + (Math.random() - 0.5) * 2 * spread,
    (Math.random() - 0.5) * 2 * spread - Math.cos(shooter.yaw) * Math.cos(shooter.pitch)
  ).normalize();
  _origin.copy(shooter.pos);
  raycaster.set(_origin, _dir);
  raycaster.far = w.range;
  const hits = raycaster.intersectObjects(state.shootables, false);
  const hit = hits.length ? hits[0] : null;
  const point = hit ? hit.point.clone() : _origin.clone().add(_dir.clone().multiplyScalar(w.range));

  // Tracer + muzzle flash, handled by main.js fx list (no allocation here
  // beyond the one cloned point, which the fx entry owns).
  state.fx.push({ kind: 'tracer', from: _origin.clone(), to: point, life: 0.09, max: 0.09 });
  playShot(w.kind, !shooter.isPlayer);

  if (!hit || !hit.object.userData.bot) return { hit: false, point };
  const bot = hit.object.userData.bot;
  if (bot.team === shooter.team || !bot.alive) return { hit: false, point };
  const headshot = hit.object.userData.part === 'head';
  const falloff = Math.max(0.55, 1 - hit.distance / (w.range * 1.6));
  const dmg = Math.round(w.damage * (headshot ? w.headMult : 1) * falloff);
  const died = state.damageBot(bot, dmg, shooter);
  return { hit: true, kill: died, headshot, point, target: bot, damage: dmg };
}

// Throw a grenade from `origin` along `dir`. Flash blinds whoever looks at
// it; smoke drops a sphere that blocks line of sight for 12 s.
export function throwGrenade(state, kind, origin, dir) {
  raycaster.set(origin, dir);
  raycaster.far = 26;
  const hits = raycaster.intersectObjects(state.shootables, false);
  const point = hits.length ? hits[0].point.clone() : origin.clone().add(dir.clone().multiplyScalar(20));
  if (kind === 'flash') {
    state.fx.push({ kind: 'flash', at: point, life: 0.15, max: 0.15 });
    // Blind the player if they face the burst; bots in 14 m are blinded 2 s.
    for (const b of state.bots) {
      if (b.alive && b.pos.distanceTo(point) < 14) b.blindUntil = state.time + 2;
    }
    const p = state.player;
    if (p.alive && p.pos.distanceTo(point) < 16) p.flash = 1;
  } else {
    state.smokes.push({ pos: point.clone(), radius: 3.2, ttl: 12 });
    state.fx.push({ kind: 'smoke', at: point, life: 12, max: 12 });
  }
}
