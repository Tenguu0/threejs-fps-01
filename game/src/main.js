// DUSTLINE main — boot, fixed 60 Hz simulation loop, rendering, and the
// deterministic ?shot= capture frames. One state object, one store.
// ?shot=menu|play|plant|win with &seed=N renders a frozen frame twice and
// sets window.__shotReady — the same pattern the kit's starter uses.
import * as THREE from 'three';
import { PALETTE, FOG } from './palette.js';
import { buildWorld } from './world.js';
import { Input } from './input.js';
import { createPlayer, eyePos, damagePlayer, updatePlayer } from './player.js';
import { WEAPONS, createLoadout, switchWeapon, startReload, fireWeapon, throwGrenade } from './weapon.js';
import { createBot, buildBotMesh, updateBots, assignBotRoutes, syncBotMeshes, BOT_NAMES_V, BOT_NAMES_W } from './bots.js';
import { createRoundState, startMatch, updateRounds, buyItem, onPlanted, onDefused, transferCharge, tickPlayerWeapon } from './rounds.js';
import { initHud, updateHud, showHitmarker, showBuyMenu, showBuyMsg, setOverlay } from './hud.js';
import {
  ensureAudio, playReload, playHitmarker, playHurt, playFootstep,
} from './audio.js';

const params = new URLSearchParams(location.search);
const shot = params.get('shot');
const seed = Number.parseInt(params.get('seed') ?? '1', 10) || 1;

function mulberry32(initial) {
  let a = initial >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- boot
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.28;
document.getElementById('game').appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.sky);
scene.fog = new THREE.Fog(PALETTE.fog, FOG.near, FOG.far);

const camera = new THREE.PerspectiveCamera(74, innerWidth / innerHeight, 0.08, 160);
camera.rotation.order = 'YXZ';

const hemi = new THREE.HemisphereLight(0xf0a830, 0x2a2018, 1.3);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xffb36b, 2.3);
sun.position.set(24, 34, 14);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.left = -38;
sun.shadow.camera.right = 38;
sun.shadow.camera.top = 38;
sun.shadow.camera.bottom = -38;
sun.shadow.camera.far = 100;
scene.add(sun);

// Weapon viewmodel: a chunky rifle silhouette parented to the camera.
const viewmodel = new THREE.Group();
const vmMat = new THREE.MeshStandardMaterial({ color: 0x565d66, roughness: 0.45, metalness: 0.65 });
const vmBody = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.14, 0.62), vmMat);
const vmBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.3, 8), vmMat);
vmBarrel.rotation.x = Math.PI / 2;
vmBarrel.position.set(0, 0.02, -0.42);
const vmMag = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.18, 0.12), vmMat);
vmMag.position.set(0, -0.14, -0.05);
const vmFlash = new THREE.Mesh(
  new THREE.PlaneGeometry(0.22, 0.22),
  new THREE.MeshBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0, side: THREE.DoubleSide })
);
vmFlash.position.set(0, 0.02, -0.6);
viewmodel.add(vmBody, vmBarrel, vmMag, vmFlash);
viewmodel.scale.setScalar(0.55);
viewmodel.position.set(0.32, -0.28, -0.7);
camera.add(viewmodel);
scene.add(camera);

// ---------------------------------------------------------------- state
const world = buildWorld(scene);
const input = new Input();
input.attach(renderer.domElement);
const hud = initHud();

const state = {
  rng: mulberry32(seed),
  seed,
  time: 0,
  world,
  scene,
  camera,
  input,
  hud,
  player: createPlayer(world.spawns.V[0]),
  bots: [],
  shootables: [...world.wallMeshes],
  fx: [],
  smokes: [],
  killfeed: [],
  playerLoadout: createLoadout(),
  plant: { site: null, targetSite: 'A', planted: false, timer: 40, progress: 0, defuseProgress: 0, planter: null },
  ...createRoundState(),
  hudDirty: true,
};

// Bots: 4 Vanguard teammates + 5 Wardens.
for (let i = 0; i < 4; i++) {
  const bot = createBot(i, 'V', i === 0 ? 'rush' : 'rotate', BOT_NAMES_V[i], world.spawns.V[1 + i], seed + i);
  bot.loadout.current = 'jackal';
  state.bots.push(bot);
}
for (let i = 0; i < 5; i++) {
  const bot = createBot(10 + i, 'W', i < 2 ? 'hold' : 'rotate', BOT_NAMES_W[i], world.spawns.W[1 + (i % 4)], seed + 100 + i);
  bot.loadout.current = 'hornet';
  state.bots.push(bot);
}
for (const bot of state.bots) {
  scene.add(buildBotMesh(bot));
  state.shootables.push(...bot.parts);
}
assignBotRoutes(state, state.rng);

// Damage a bot (shared by player shots and bot-vs-bot fire). Returns true
// when the bot died. Interrupts plant/defuse channels.
state.damageBot = (bot, dmg, shooter) => {
  if (!bot.alive) return false;
  let remaining = dmg;
  if (bot.armor > 0) {
    const absorbed = Math.min(bot.armor, remaining * 0.5);
    bot.armor -= absorbed;
    remaining -= absorbed;
  }
  bot.hp -= remaining;
  bot.plantProgress = 0;
  bot.defuseProgress = 0;
  if (bot.state === 'plant' || bot.state === 'defuse') bot.state = 'route';
  if (bot.hp > 0) return false;
  bot.hp = 0;
  bot.alive = false;
  bot.mesh.rotation.x = -Math.PI / 2;
  bot.mesh.position.y = 0.25;
  for (const part of bot.parts) {
    const idx = state.shootables.indexOf(part);
    if (idx !== -1) state.shootables.splice(idx, 1);
  }
  const shooterName = shooter && shooter.isPlayer ? 'You' : shooter && shooter.name ? shooter.name : 'A bot';
  const victimTeam = bot.team;
  state.killfeed.push({ text: `${shooterName} ▸ ${bot.name}`, team: victimTeam === 'V' ? 'W' : 'V', at: state.time });
  if (shooter && shooter.isPlayer) {
    state.player.kills += 1;
    state.money += 300;
  }
  if (bot.carryingCharge) {
    bot.carryingCharge = false;
    transferCharge(state);
  }
  return true;
};

state.onBotHit = (shooter, target, res) => {
  if (res.kill) {
    // Kill feed entry is written by damageBot; nothing extra here.
  }
};

state.onPlayerHit = (bot, dmg, headshot) => {
  playHurt();
  hud.damage.style.opacity = headshot ? '0.5' : '0.35';
  setTimeout(() => { hud.damage.style.opacity = state.player.alive ? '0' : '0.55'; }, 180);
  if (!state.player.alive) {
    state.player.hasCharge = false;
    transferCharge(state);
    setOverlay(hud, {
      title: 'YOU ARE DOWN',
      copy: 'Spectating your team — the round continues. Click to keep watching.',
      button: 'Keep watching',
      show: true,
    });
  }
};

state.onPlanted = (bot, site) => onPlanted(state, bot, site);
state.onDefused = (bot) => onDefused(state, bot);

// ---------------------------------------------------------------- firing
const _eye = new THREE.Vector3();
function playerFire(time) {
  const p = state.player;
  if (!p.alive || state.phase !== 'live') return;
  if (state.buyOpen) return;
  const loadout = state.playerLoadout;
  const moveSpread = p.speed * 0.0022 + (p.crouched ? -0.002 : 0.001);
  eyePos(p, _eye);
  const res = fireWeapon(state, { team: 'V', isPlayer: true, pos: _eye, yaw: p.yaw, pitch: p.pitch }, loadout, moveSpread, time);
  if (!res) return;
  if (res.dry) return;
  vmFlash.material.opacity = 0.9;
  if (res.hit) {
    playHitmarker(res.kill);
    showHitmarker(hud, res.kill);
  }
}

// ---------------------------------------------------------------- keys
let buyOpen = false;
state.buyOpen = false;
function setBuy(open) {
  buyOpen = open;
  state.buyOpen = open;
  showBuyMenu(state, hud, open);
}

input.onKeyDown = (code) => {
  ensureAudio();
  if (state.phase === 'menu' || state.phase === 'matchEnd') return;
  if (code === 'KeyB' && state.phase === 'buy') {
    setBuy(!buyOpen);
    return;
  }
  if (buyOpen) {
    if (code.startsWith('Digit')) {
      showBuyMsg(hud, buyItem(state, code));
      showBuyMenu(state, hud, true);
    }
    if (code === 'Escape') setBuy(false);
    return;
  }
  if (code === 'KeyR') {
    if (startReload(state.playerLoadout, state.time)) playReload();
  }
  if (code === 'Digit1') switchWeapon(state.playerLoadout, 'jackal', state.time);
  if (code === 'Digit2') switchWeapon(state.playerLoadout, 'hornet', state.time);
  if (code === 'Digit3') switchWeapon(state.playerLoadout, 'longshot', state.time);
  if (code === 'KeyG' || code === 'KeyX') {
    const kind = code === 'KeyG' ? 'flash' : 'smoke';
    const loadout = state.playerLoadout;
    if (loadout.grenades[kind] > 0 && state.phase === 'live' && state.player.alive) {
      loadout.grenades[kind] -= 1;
      eyePos(state.player, _eye);
      _eye.y += 0.1;
      const dir = new THREE.Vector3(-Math.sin(state.player.yaw), Math.sin(state.player.pitch), -Math.cos(state.player.yaw)).normalize();
      throwGrenade(state, kind, _eye, dir);
    }
  }
};

renderer.domElement.addEventListener('click', () => {
  ensureAudio();
  if (state.phase === 'live' || state.phase === 'buy') input.requestLock();
});

hud.playBtn.addEventListener('click', () => {
  ensureAudio();
  if (state.phase === 'menu') {
    startMatch(state);
    setOverlay(hud, { show: false });
    setBuy(true);
    input.requestLock();
  } else if (state.phase === 'matchEnd') {
    startMatch(state);
    setOverlay(hud, { show: false });
    setBuy(true);
    input.requestLock();
  } else {
    setOverlay(hud, { show: false });
    input.requestLock();
  }
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------- fx
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
function updateFx(dt) {
  for (let i = state.fx.length - 1; i >= 0; i--) {
    const f = state.fx[i];
    f.life -= dt;
    if (f.kind === 'tracer') {
      if (!f.mesh) {
        const geo = new THREE.BufferGeometry().setFromPoints([f.from, f.to]);
        f.mesh = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffc861, transparent: true, opacity: 0.9 }));
        scene.add(f.mesh);
      }
      f.mesh.material.opacity = Math.max(0, f.life / f.max) * 0.9;
    } else if (f.kind === 'smoke') {
      if (!f.mesh) {
        f.mesh = new THREE.Mesh(
          new THREE.SphereGeometry(3.2, 16, 12),
          new THREE.MeshStandardMaterial({ color: 0x8a8d90, transparent: true, opacity: 0.55, roughness: 1 })
        );
        f.mesh.position.copy(f.at);
        f.mesh.position.y = 1.4;
        scene.add(f.mesh);
      }
      f.mesh.material.opacity = 0.55 * Math.max(0, f.life / f.max);
    }
    if (f.life <= 0) {
      if (f.mesh) {
        scene.remove(f.mesh);
        f.mesh.geometry.dispose();
        f.mesh.material.dispose();
      }
      state.fx.splice(i, 1);
    }
  }
  // Smoke spheres expire from the gameplay list too.
  for (let i = state.smokes.length - 1; i >= 0; i--) {
    state.smokes[i].ttl -= dt;
    if (state.smokes[i].ttl <= 0) state.smokes.splice(i, 1);
  }
  if (vmFlash.material.opacity > 0) {
    vmFlash.material.opacity = Math.max(0, vmFlash.material.opacity - dt * 14);
  }
}

// ---------------------------------------------------------------- sim step
const STEP = 1 / 60;
function step(dt) {
  state.time += dt;
  const p = state.player;
  if (state.phase === 'live' || state.phase === 'buy') {
    updatePlayer(p, input, world, dt, state.time, () => playFootstep());
    if (input.firing) playerFire(state.time);
    tickPlayerWeapon(state, state.time);
    updateBots(state, dt);
    updateRounds(state, dt);
    // Camera follows the player.
    camera.position.set(p.pos.x, p.eyeHeight, p.pos.z);
    camera.rotation.set(p.pitch, p.yaw, 0);
    // Viewmodel bob + recoil kick.
    const bob = Math.sin(state.time * 9) * 0.006 * Math.min(1, p.speed / 5);
    viewmodel.position.y = -0.28 + bob;
  }
  syncBotMeshes(state);
  updateFx(dt);
  updateHud(state, hud);
}

// ---------------------------------------------------------------- shot mode
function setupShot(name) {
  const rng = mulberry32(seed * 31 + name.length * 7);
  // Common: a live match, HUD on, overlay off.
  startMatch(state);
  state.phase = 'live';
  state.phaseTimer = 87;
  state.banner = null;
  setOverlay(hud, { show: false });
  setBuy(false);

  if (name === 'menu') {
    state.phase = 'menu';
    state.phaseTimer = 0;
    setOverlay(hud, {
      title: 'DUSTLINE',
      copy: 'Round-based tactical FPS. 5v5 — plant the pulse charge at Site A or B, or hold the line as Wardens. First to 5 rounds takes the match.',
      button: 'Click to play',
      show: true,
    });
    camera.position.set(0, 1.62, 17);
    camera.rotation.set(-0.02, 0, 0);
    return;
  }
  if (name === 'play') {
    // A-long firefight: player in the west lane looking north up the lane,
    // one Warden dead ahead, a second rotating through the A connector.
    const p = state.player;
    p.pos.set(-22, 0, 10);
    p.yaw = 0.15;
    p.pitch = 0.0;
    p.eyeHeight = 1.62;
    const w0 = state.bots[4];
    const w1 = state.bots[5];
    w0.pos.set(-24, 0, -4);
    w0.yaw = Math.PI;
    w1.pos.set(-16, 0, -10);
    w1.yaw = Math.PI - 0.4;
    const mate = state.bots[0];
    mate.pos.set(-18, 0, 6);
    mate.yaw = 0;
    // A tracer mid-flight sells the firefight.
    _v1.set(-22, 1.5, 9);
    _v2.set(-24, 1.4, -4);
    state.fx.push({ kind: 'tracer', from: _v1.clone(), to: _v2.clone(), life: 0.09, max: 0.09 });
    state.killfeed.push({ text: 'Iris ▸ Vex', team: 'V', at: state.time });
    return;
  }
  if (name === 'plant') {
    // Planting at Site A, smoke cover, progress bar at ~70%.
    // Player stands south-east of the site ring, facing the site (yaw ~0.85).
    // Smoke sits past the site so it frames the shot instead of washing it.
    const p = state.player;
    p.pos.set(-18, 0, -8.5);
    p.yaw = 0.85;
    p.pitch = 0.04;
    state.plant.progress = 0.7;
    state.smokes.push({ pos: new THREE.Vector3(-24, 1.4, -14), radius: 3.2, ttl: 12 });
    state.fx.push({ kind: 'smoke', at: new THREE.Vector3(-24, 1.4, -14), life: 12, max: 12 });
    const mate = state.bots[1];
    mate.pos.set(-17, 0, -8);
    mate.yaw = Math.PI * 0.75;
    const w = state.bots[6];
    w.pos.set(-14, 0, -14);
    w.yaw = Math.PI * 0.5;
    state.killfeed.push({ text: 'Charge planting at Site A', team: 'V', at: state.time });
    return;
  }
  if (name === 'win') {
    // Match point won: banner + scoreboard state.
    state.round = 7;
    state.score = { V: 5, W: 2 };
    state.matchWinner = 'V';
    state.banner = { text: 'MATCH WON — DUSTLINE IS YOURS', sub: 'Final score 5 – 2', team: 'V', until: state.time + 999 };
    const p = state.player;
    p.pos.set(0, 0, 4);
    p.yaw = 0;
    p.pitch = 0.02;
    state.bots[4].pos.set(-4, 0, -6);
    state.bots[4].yaw = Math.PI;
    state.bots[0].pos.set(3, 0, 2);
    state.bots[0].yaw = -0.4;
    state.killfeed.push({ text: 'Round 7: Enemy team eliminated', team: 'V', at: state.time });
    return;
  }
  // Unknown ?shot= value: fall back to the live view.
}

if (shot) {
  setupShot(shot);
  // Freeze the sim: render twice so shadows + HUD settle, then signal ready.
  step(0);
  renderer.render(scene, camera);
  renderer.render(scene, camera);
  updateHud(state, hud);
  window.__shotReady = true;
} else {
  setOverlay(hud, {
    title: 'DUSTLINE',
    copy: 'Round-based tactical FPS. 5v5 — plant the pulse charge at Site A or B, or hold the line as Wardens. First to 5 rounds takes the match.',
    button: 'Click to play',
    show: true,
  });
  let last = performance.now();
  let acc = 0;
  function frame(now) {
    requestAnimationFrame(frame);
    let dt = (now - last) / 1000;
    last = now;
    if (dt > 0.25) dt = 0.25;
    acc += dt;
    let n = 0;
    while (acc >= STEP && n < 5) {
      step(STEP);
      acc -= STEP;
      n += 1;
    }
    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}
