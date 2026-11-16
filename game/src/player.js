// DUSTLINE player — movement, collision, camera, health/armor.
// Fixed-step only: main.js calls updatePlayer once per 1/60 s tick.
import * as THREE from 'three';
import { resolveCircleVsBoxes } from './world.js';

export const EYE_STAND = 1.62;
export const EYE_CROUCH = 1.08;
export const PLAYER_RADIUS = 0.42;

export function createPlayer(spawn) {
  return {
    pos: new THREE.Vector3(spawn.x, 0, spawn.z),
    vel: new THREE.Vector3(),
    yaw: 0, // facing north (towards -z, the Wardens) at spawn
    pitch: 0,
    hp: 100,
    armor: 0,
    alive: true,
    crouched: false,
    eyeHeight: EYE_STAND,
    speed: 0, // horizontal speed, for spread + HUD
    kills: 0,
    deaths: 0,
    hasCharge: true,
    flash: 0, // flashbang blindness 0..1
    lastFootstep: 0,
  };
}

export function resetPlayer(player, spawn, yaw) {
  player.pos.set(spawn.x, 0, spawn.z);
  player.vel.set(0, 0, 0);
  player.yaw = yaw;
  player.pitch = 0;
  player.hp = 100;
  player.armor = 0;
  player.alive = true;
  player.crouched = false;
  player.eyeHeight = EYE_STAND;
  player.speed = 0;
  player.flash = 0;
}

export function eyePos(player, out = new THREE.Vector3()) {
  return out.set(player.pos.x, player.eyeHeight, player.pos.z);
}

// Damage with armor absorbing 50% of incoming damage until it breaks.
export function damagePlayer(player, dmg) {
  if (!player.alive) return 0;
  let remaining = dmg;
  if (player.armor > 0) {
    const absorbed = Math.min(player.armor, remaining * 0.5);
    player.armor -= absorbed;
    remaining -= absorbed;
  }
  player.hp -= remaining;
  if (player.hp <= 0) {
    player.hp = 0;
    player.alive = false;
    player.deaths += 1;
  }
  return remaining;
}

export function updatePlayer(player, input, world, dt, time, onFootstep) {
  if (!player.alive) return;
  const look = input.consumeLook();
  const sens = 0.0021;
  player.yaw -= look.dx * sens;
  player.pitch -= look.dy * sens;
  player.pitch = Math.max(-1.45, Math.min(1.45, player.pitch));

  player.crouched = input.crouch;
  const targetEye = player.crouched ? EYE_CROUCH : EYE_STAND;
  player.eyeHeight += (targetEye - player.eyeHeight) * Math.min(1, dt * 12);

  // Wish direction from keys, rotated by yaw.
  const sin = Math.sin(player.yaw);
  const cos = Math.cos(player.yaw);
  let wx = 0;
  let wz = 0;
  if (input.forward) { wx -= sin; wz -= cos; }
  if (input.back) { wx += sin; wz += cos; }
  if (input.left) { wx -= cos; wz += sin; }
  if (input.right) { wx += cos; wz -= sin; }
  const wlen = Math.hypot(wx, wz);
  if (wlen > 0) { wx /= wlen; wz /= wlen; }

  const maxSpeed = player.crouched ? 2.6 : input.slow ? 3.1 : 5.6;
  const accel = 46; // snappy starts, still no air-control bunny-hop trick
  player.vel.x += wx * accel * dt;
  player.vel.z += wz * accel * dt;
  // Friction when no input, light drag otherwise (no bunny-hop spam: no air control trick).
  const hv = Math.hypot(player.vel.x, player.vel.z);
  if (wlen === 0) {
    const f = Math.max(0, hv - 38 * dt);
    if (hv > 0) {
      player.vel.x *= f / hv;
      player.vel.z *= f / hv;
    }
  } else if (hv > maxSpeed) {
    player.vel.x *= maxSpeed / hv;
    player.vel.z *= maxSpeed / hv;
  }
  player.speed = Math.hypot(player.vel.x, player.vel.z);

  player.pos.x += player.vel.x * dt;
  player.pos.z += player.vel.z * dt;
  // Keep inside the yard, then resolve against boxes.
  player.pos.x = Math.max(world.bounds.minX + PLAYER_RADIUS, Math.min(world.bounds.maxX - PLAYER_RADIUS, player.pos.x));
  player.pos.z = Math.max(world.bounds.minZ + PLAYER_RADIUS, Math.min(world.bounds.maxZ - PLAYER_RADIUS, player.pos.z));
  const fixed = resolveCircleVsBoxes(player.pos, PLAYER_RADIUS, world.colliders);
  player.pos.x = fixed.x;
  player.pos.z = fixed.z;

  // Footsteps: one tick per ~0.45 s of movement.
  if (player.speed > 2 && time - player.lastFootstep > 0.42) {
    player.lastFootstep = time;
    if (onFootstep) onFootstep();
  }
  if (player.flash > 0) player.flash = Math.max(0, player.flash - dt * 0.45);
}
