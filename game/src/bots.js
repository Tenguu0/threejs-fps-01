// DUSTLINE bots — 9 AI combatants (4 Vanguard teammates, 5 Wardens).
// Waypoint routes, line-of-sight perception, reaction times, burst fire,
// and objective behaviour: attackers plant the charge, defenders defuse.
import * as THREE from 'three';
import { TEAM } from './palette.js';
import { resolveCircleVsBoxes, segmentBlocked } from './world.js';
import { createLoadout, fireWeapon, weaponOf } from './weapon.js';
import { damagePlayer, eyePos } from './player.js';
import { playShot } from './audio.js';

export const BOT_RADIUS = 0.42;
export const BOT_NAMES_V = ['Rook', 'Iris', 'Boone', 'Sable'];
export const BOT_NAMES_W = ['Vex', 'Hale', 'Mira', 'Koda', 'Fenn'];

const _eye = new THREE.Vector3();
const _targetEye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _to = new THREE.Vector3();

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createBot(id, team, role, name, spawn, seed) {
  const rng = mulberry32(seed * 7919 + id * 131);
  return {
    id,
    name,
    team,
    role, // 'rush' | 'hold' | 'rotate'
    pos: new THREE.Vector3(spawn.x, 0, spawn.z),
    yaw: team === 'V' ? 0 : Math.PI, // V faces north, W faces south
    pitch: 0,
    hp: 100,
    armor: 0,
    alive: true,
    loadout: createLoadout(),
    route: [],
    routeIdx: 0,
    holdAt: null,
    state: 'route',
    target: null, // bot object or the string 'player'
    targetLostAt: 0,
    reactionUntil: 0,
    burstLeft: 0,
    nextShotAt: 0,
    burstPauseUntil: 0,
    aimSkill: 0.55 + rng() * 0.35, // 0.55..0.9, higher = deadlier
    scanAt: rng() * 0.15,
    speed: role === 'rush' ? 3.8 : 3.1,
    blindUntil: 0,
    plantProgress: 0,
    defuseProgress: 0,
    carryingCharge: false,
    mesh: null,
    flash: 0,
  };
}

export function buildBotMesh(bot) {
  const group = new THREE.Group();
  const suit = new THREE.MeshStandardMaterial({ color: TEAM[bot.team].color, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1c1e22, roughness: 0.7 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.56, 1.0, 0.34), suit);
  body.position.y = 0.95;
  body.castShadow = true;
  body.userData.bot = bot;
  body.userData.part = 'body';
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.32, 0.32), dark);
  head.position.y = 1.62;
  head.castShadow = true;
  head.userData.bot = bot;
  head.userData.part = 'head';
  const visor = new THREE.Mesh(
    new THREE.BoxGeometry(0.3, 0.08, 0.05),
    new THREE.MeshStandardMaterial({ color: 0xf0a830, emissive: 0xf0a830, emissiveIntensity: 0.9 })
  );
  visor.position.set(0, 1.64, 0.18);
  const gun = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.12, 0.72), dark);
  gun.position.set(0.2, 1.15, 0.3);
  group.add(body, head, visor, gun);
  group.position.copy(bot.pos);
  group.userData.bot = bot;
  bot.mesh = group;
  bot.parts = [body, head];
  return group;
}

function eyeOf(bot, out) {
  return out.set(bot.pos.x, 1.5, bot.pos.z);
}

// Smoke spheres block sight just like walls do.
function losClear(state, ax, ay, az, bx, by, bz) {
  if (segmentBlocked(ax, ay, az, bx, by, bz, state.world.colliders)) return false;
  for (const s of state.smokes) {
    // Segment vs sphere test.
    _dir.set(bx - ax, by - ay, bz - az);
    const len2 = _dir.lengthSq();
    if (len2 < 1e-9) continue;
    const t = Math.max(0, Math.min(1, ((s.pos.x - ax) * _dir.x + (s.pos.y - ay) * _dir.y + (s.pos.z - az) * _dir.z) / len2));
    const px = ax + _dir.x * t;
    const py = ay + _dir.y * t;
    const pz = az + _dir.z * t;
    const d2 = (px - s.pos.x) ** 2 + (py - s.pos.y) ** 2 + (pz - s.pos.z) ** 2;
    if (d2 < s.radius * s.radius) return false;
  }
  return true;
}

function canSee(state, bot, enemy, enemyEye) {
  if (!enemy.alive) return false;
  eyeOf(bot, _eye);
  const dx = enemyEye.x - _eye.x;
  const dy = enemyEye.y - _eye.y;
  const dz = enemyEye.z - _eye.z;
  const dist = Math.hypot(dx, dy, dz);
  if (dist > 46) return false;
  // Must be roughly in front of the bot (100 deg cone).
  const fx = -Math.sin(bot.yaw);
  const fz = -Math.cos(bot.yaw);
  const dot = (dx * fx + dz * fz) / Math.max(0.001, Math.hypot(dx, dz));
  if (dot < 0.35) return false;
  return losClear(state, _eye.x, _eye.y, _eye.z, enemyEye.x, enemyEye.y, enemyEye.z);
}

// Nearest visible enemy: the player or an opposing bot.
function scanForEnemy(state, bot) {
  const p = state.player;
  if (p.alive && bot.team !== 'V') {
    eyePos(p, _targetEye);
    if (canSee(state, bot, p, _targetEye)) return 'player';
  }
  let best = null;
  let bestD = Infinity;
  for (const other of state.bots) {
    if (other.team === bot.team || !other.alive) continue;
    eyeOf(other, _targetEye);
    if (!canSee(state, bot, other, _targetEye)) continue;
    const d = bot.pos.distanceTo(other.pos);
    if (d < bestD) { bestD = d; best = other; }
  }
  return best;
}

function faceToward(bot, x, z, dt, rate = 7) {
  const want = Math.atan2(-(x - bot.pos.x), -(z - bot.pos.z));
  let diff = want - bot.yaw;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;
  bot.yaw += Math.max(-rate * dt, Math.min(rate * dt, diff));
}

function moveToward(bot, x, z, dt, world) {
  const dx = x - bot.pos.x;
  const dz = z - bot.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.05) return true;
  const step = Math.min(d, bot.speed * dt);
  bot.pos.x += (dx / d) * step;
  bot.pos.z += (dz / d) * step;
  bot.pos.x = Math.max(world.bounds.minX + BOT_RADIUS, Math.min(world.bounds.maxX - BOT_RADIUS, bot.pos.x));
  bot.pos.z = Math.max(world.bounds.minZ + BOT_RADIUS, Math.min(world.bounds.maxZ - BOT_RADIUS, bot.pos.z));
  const fixed = resolveCircleVsBoxes(bot.pos, BOT_RADIUS, world.colliders);
  bot.pos.x = fixed.x;
  bot.pos.z = fixed.z;
  faceToward(bot, x, z, dt);
  return d <= 1.2;
}

function botShoot(state, bot, time) {
  if (bot.blindUntil > time) return;
  if (time < bot.nextShotAt || time < bot.burstPauseUntil) return;
  const target = bot.target;
  if (!target) return;
  let targetEyePos;
  let targetBot = null;
  if (target === 'player') {
    if (!state.player.alive) return;
    targetEyePos = eyePos(state.player, _targetEye);
  } else {
    if (!target.alive) return;
    targetBot = target;
    targetEyePos = eyeOf(target, _targetEye);
  }
  if (bot.burstLeft <= 0) {
    bot.burstLeft = 3 + Math.floor(Math.random() * 3);
    bot.burstPauseUntil = time + 0.7 + Math.random() * 0.7;
  }
  bot.burstLeft -= 1;
  bot.nextShotAt = time + 60 / weaponOf(bot.loadout).rpm;
  eyeOf(bot, _eye);
  // Aim with error that grows with distance and target speed.
  const dist = _eye.distanceTo(targetEyePos);
  const moving = target === 'player' ? state.player.speed : 2.5;
  const err = (0.028 + dist * 0.0011 + moving * 0.004) * (1.25 - bot.aimSkill);
  const tx = targetEyePos.x + (Math.random() - 0.5) * 2 * err * dist;
  const ty = targetEyePos.y + (Math.random() - 0.5) * 2 * err * dist - 0.25;
  const tz = targetEyePos.z + (Math.random() - 0.5) * 2 * err * dist;
  _dir.set(tx - _eye.x, ty - _eye.y, tz - _eye.z).normalize();
  const shooter = {
    team: bot.team, isPlayer: false, name: bot.name, pos: _eye.clone(),
    yaw: Math.atan2(-_dir.x, -_dir.z), pitch: Math.asin(Math.max(-1, Math.min(1, _dir.y))),
  };
  // Bots do not burn their magazine: they fire the shared hitscan path but
  // the raycast target list already excludes same-team parts via the check.
  // Refill the bot's magazine when empty (bots carry infinite reserve).
  if (targetBot) {
    if (bot.loadout.mag[bot.loadout.current] <= 0) {
      const w = weaponOf(bot.loadout);
      bot.loadout.mag[bot.loadout.current] = w.mag;
    }
    const res = fireWeapon(state, shooter, bot.loadout, 0, time);
    if (res && res.hit && res.target === targetBot) {
      state.onBotHit(bot, targetBot, res);
    }
  } else {
    // Player target: roll the hit instead of raycasting a mesh that does
    // not exist; walls already checked by canSee each scan.
    const w = weaponOf(bot.loadout);
    const hitChance = Math.max(0.08, Math.min(0.55, (0.5 - dist * 0.008) * bot.aimSkill * (state.player.crouched ? 0.8 : 1)));
    const hitPoint = _eye.clone().add(_dir.clone().multiplyScalar(dist));
    state.fx.push({ kind: 'tracer', from: _eye.clone(), to: hitPoint, life: 0.09, max: 0.09 });
    playShot(w.kind, true);
    if (Math.random() < hitChance) {
      const headshot = Math.random() < 0.12;
      const dmg = Math.round(w.damage * (headshot ? w.headMult : 1) * Math.max(0.55, 1 - dist / 140));
      damagePlayer(state.player, dmg);
      state.onPlayerHit(bot, dmg, headshot);
    }
  }
}

export function updateBots(state, dt) {
  const time = state.time;
  for (const bot of state.bots) {
    if (!bot.alive) continue;

    // Perception runs on a staggered 0.15 s cadence; movement and shooting
    // run every tick below.
    if (time >= bot.scanAt) {
      bot.scanAt = time + 0.15;

      // Objective behaviour overrides combat when the charge is planted.
      const planted = state.plant.planted;
      if (bot.team === 'W' && planted && state.plant.site) {
        const s = state.world.sites[state.plant.site];
        if (bot.state !== 'defuse' && Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z) < 3.2) {
          bot.state = 'defuse';
        } else if (bot.state !== 'defuse') {
          bot.state = 'route';
          bot.route = [{ x: s.x, z: s.z }];
          bot.routeIdx = 0;
        }
      }
      if (bot.team === 'V' && bot.carryingCharge && !planted && state.phase === 'live') {
        const s = state.plant.targetSite ? state.world.sites[state.plant.targetSite] : null;
        if (s && bot.state !== 'plant' && Math.hypot(bot.pos.x - s.x, bot.pos.z - s.z) < 2.6) {
          bot.state = 'plant';
        }
      }

      // Perception: acquire or keep a target.
      const seen = scanForEnemy(state, bot);
      if (seen) {
        if (bot.target !== seen) {
          bot.target = seen;
          bot.reactionUntil = time + 0.35 + Math.random() * 0.35;
          bot.burstLeft = 0;
        }
        bot.targetLostAt = time;
      } else if (bot.target && time - bot.targetLostAt > 2) {
        bot.target = null;
      }
    }

    // Planting channel.
    if (bot.state === 'plant') {
      bot.plantProgress += dt / 3.5;
      faceToward(bot, state.world.sites[state.plant.targetSite].x, state.world.sites[state.plant.targetSite].z, dt, 3);
      if (bot.plantProgress >= 1) state.onPlanted(bot, state.plant.targetSite);
      continue;
    }
    // Defusing channel (interrupted if the bot takes damage — handled by damageBot).
    if (bot.state === 'defuse') {
      bot.defuseProgress += dt / 5;
      if (bot.defuseProgress >= 1) state.onDefused(bot);
      continue;
    }

    if (bot.target && time >= bot.reactionUntil) {
      bot.state = 'engage';
      const tp = bot.target === 'player' ? state.player.pos : bot.target.pos;
      faceToward(bot, tp.x, tp.z, dt, 9);
      botShoot(state, bot, time);
      continue;
    }

    // No target: route or hold.
    if (bot.holdAt && bot.state === 'hold') {
      faceToward(bot, bot.holdAt.x + Math.sin(time * 0.4) * 4, bot.holdAt.z, dt, 2);
      continue;
    }
    if (bot.route.length > 0) {
      const wp = bot.route[bot.routeIdx];
      if (moveToward(bot, wp.x, wp.z, dt, state.world)) {
        bot.routeIdx += 1;
        if (bot.routeIdx >= bot.route.length) {
          bot.routeIdx = 0;
          if (bot.holdAt) bot.state = 'hold';
          else if (bot.team === 'W') bot.state = 'hold';
        }
      }
    }
  }
}

// Assign routes at round start. Attackers split across lanes; defenders hold.
export function assignBotRoutes(state, rng) {
  const lanes = ['A', 'B', 'mid', 'Aalt', 'Balt'];
  let laneIdx = Math.floor(rng() * lanes.length);
  for (const bot of state.bots) {
    if (bot.team === 'V') {
      const lane = lanes[laneIdx % lanes.length];
      laneIdx += 1;
      bot.route = state.world.routes[lane].map((k) => ({ ...state.world.waypoints[k] }));
      bot.routeIdx = 0;
      bot.state = 'route';
      bot.holdAt = null;
      if (bot.carryingCharge) state.plant.targetSite = lane === 'mid' ? (rng() < 0.5 ? 'A' : 'B') : (lane.startsWith('A') ? 'A' : 'B');
    } else {
      const holds = ['wA', 'wB', 'wMid', 'wA', 'wB'];
      const key = holds[bot.id % holds.length];
      bot.holdAt = { ...state.world.waypoints[key] };
      bot.route = [bot.holdAt];
      bot.routeIdx = 0;
      bot.state = 'route';
    }
    bot.target = null;
    bot.plantProgress = 0;
    bot.defuseProgress = 0;
  }
}

export function syncBotMeshes(state) {
  for (const bot of state.bots) {
    if (!bot.mesh) continue;
    bot.mesh.position.set(bot.pos.x, 0, bot.pos.z);
    bot.mesh.rotation.y = bot.yaw;
    if (!bot.alive) {
      bot.mesh.rotation.x = -Math.PI / 2;
      bot.mesh.position.y = 0.25;
    }
  }
}
