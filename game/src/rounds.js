// DUSTLINE rounds — round state machine, economy and the buy menu.
// Phases: 'menu' (start overlay) -> 'buy' (15 s) -> 'live' (100 s) ->
// 'over' (banner, 5 s) -> next 'buy' ... First to 5 round wins takes
// the match; 'matchEnd' shows the final screen.
import { WEAPONS, GRENADES, createLoadout, switchWeapon, startReload } from './weapon.js';
import { resetPlayer } from './player.js';
import { assignBotRoutes } from './bots.js';
import { playRoundWin, playRoundLose, playBuy, playPlantStart, playBeep, playDefuse, playExplosion } from './audio.js';

export const WIN_ROUNDS = 5;
export const BUY_SECONDS = 15;
export const ROUND_SECONDS = 100;
export const PLANT_SECONDS = 40;
export const PLANT_CHANNEL = 3.5;
export const DEFUSE_CHANNEL = 5;

export function createRoundState() {
  return {
    round: 1,
    score: { V: 0, W: 0 },
    money: 800,
    lossStreak: 0,
    phase: 'menu',
    phaseTimer: 0,
    banner: null, // { text, sub, team, until }
    matchWinner: null,
  };
}

// Give the player a fresh loadout at match start.
export function resetEconomy(state) {
  state.money = 800;
  state.lossStreak = 0;
  state.playerLoadout = createLoadout();
  state.playerLoadout.grenades = { flash: 0, smoke: 0 };
}

export function startMatch(state) {
  state.round = 1;
  state.score = { V: 0, W: 0 };
  state.matchWinner = null;
  state.plant = { site: null, targetSite: 'A', planted: false, timer: PLANT_SECONDS, progress: 0, defuseProgress: 0, planter: null };
  resetEconomy(state);
  startRound(state);
}

export function startRound(state) {
  const world = state.world;
  state.phase = 'buy';
  state.phaseTimer = BUY_SECONDS;
  state.plant = { site: null, targetSite: 'A', planted: false, timer: PLANT_SECONDS, progress: 0, defuseProgress: 0, planter: null };
  state.killfeed.length = 0;
  state.smokes.length = 0;
  // Player spawns south, facing north.
  resetPlayer(state.player, world.spawns.V[0], 0);
  state.player.hasCharge = true;
  // Bots respawn at their spawns with full HP.
  let vi = 0;
  let wi = 0;
  for (const bot of state.bots) {
    const spawn = bot.team === 'V' ? world.spawns.V[1 + (vi++ % 4)] : world.spawns.W[1 + (wi++ % 4)];
    bot.pos.set(spawn.x, 0, spawn.z);
    bot.yaw = bot.team === 'V' ? 0 : Math.PI;
    bot.hp = 100;
    bot.armor = bot.team === 'W' && state.round >= 3 ? 50 : 0;
    bot.alive = true;
    bot.loadout = createLoadout();
    bot.loadout.current = bot.team === 'V' ? 'jackal' : 'hornet';
    bot.carryingCharge = false;
    bot.plantProgress = 0;
    bot.defuseProgress = 0;
    bot.target = null;
    if (bot.mesh) {
      bot.mesh.rotation.x = 0;
      bot.mesh.visible = true;
    }
  }
  // Charge carrier: the player, unless the player is dead (never at round
  // start) — a random Vanguard bot carries it if the player dies mid-round.
  state.player.hasCharge = true;
  assignBotRoutes(state, state.rng);
  state.banner = { text: `ROUND ${state.round}`, sub: `Buy phase — $${state.money} to spend, press B for the shop`, team: null, until: state.time + 3 };
  state.hudDirty = true;
}

// Player buys an item during the buy phase. Returns a message for the HUD.
export function buyItem(state, key) {
  if (state.phase !== 'buy') return 'Shop is closed — buy between rounds.';
  const loadout = state.playerLoadout;
  const weaponKeys = { Digit1: 'jackal', Digit2: 'hornet', Digit3: 'longshot' };
  if (weaponKeys[key]) {
    const id = weaponKeys[key];
    const w = WEAPONS[id];
    if (loadout.owned.has(id)) {
      switchWeapon(loadout, id, state.time);
      return `${w.name} equipped.`;
    }
    if (state.money < w.price) return `Need $${w.price} for ${w.name}.`;
    state.money -= w.price;
    loadout.owned.add(id);
    loadout.reserve[id] = w.reserve;
    switchWeapon(loadout, id, state.time);
    playBuy();
    return `${w.name} bought for $${w.price}.`;
  }
  if (key === 'Digit4') {
    if (state.player.armor >= 100) return 'Kevlar already full.';
    if (state.money < 650) return 'Need $650 for Kevlar.';
    state.money -= 650;
    state.player.armor = 100;
    playBuy();
    return 'Kevlar + helmet bought for $650.';
  }
  if (key === 'Digit5' || key === 'Digit6') {
    const kind = key === 'Digit5' ? 'flash' : 'smoke';
    if (state.money < GRENADES[kind].price) return `Need $${GRENADES[kind].price} for ${GRENADES[kind].name}.`;
    state.money -= GRENADES[kind].price;
    loadout.grenades[kind] += 1;
    playBuy();
    return `${GRENADES[kind].name} bought for $${GRENADES[kind].price}.`;
  }
  return null;
}

// Called every tick while live: plant/defuse channels + timers.
export function updateRounds(state, dt) {
  if (state.phase === 'buy') {
    state.phaseTimer -= dt;
    if (state.phaseTimer <= 0) {
      state.phase = 'live';
      state.phaseTimer = ROUND_SECONDS;
      state.banner = { text: 'GO GO GO', sub: 'Plant the charge at A or B', team: null, until: state.time + 2.5 };
    }
    return;
  }
  if (state.phase === 'over') {
    state.phaseTimer -= dt;
    if (state.phaseTimer <= 0) {
      if (state.matchWinner) {
        state.phase = 'matchEnd';
      } else {
        state.round += 1;
        startRound(state);
      }
    }
    return;
  }
  if (state.phase !== 'live') return;

  // Round clock.
  state.phaseTimer -= dt;
  if (state.plant.planted) {
    state.plant.timer -= dt;
    // Planted charge beeps, faster as the timer runs out.
    const interval = state.plant.timer > 15 ? 1.0 : state.plant.timer > 5 ? 0.5 : 0.25;
    if (state.time - (state.plant.lastBeep || 0) >= interval) {
      state.plant.lastBeep = state.time;
      playBeep(state.plant.timer <= 5);
    }
    if (state.plant.timer <= 0) {
      playExplosion();
      endRound(state, 'V', 'Charge detonated — Site ' + state.plant.site + ' is gone');
      return;
    }
  } else if (state.phaseTimer <= 0) {
    endRound(state, 'W', 'Time expired — charge never planted');
    return;
  }

  // Player plant channel (hold E near a site while carrying the charge).
  const p = state.player;
  if (p.alive && p.hasCharge && !state.plant.planted && state.input.interact) {
    for (const [letter, s] of Object.entries(state.world.sites)) {
      if (Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < 3.0) {
        state.plant.progress += dt / PLANT_CHANNEL;
        if (state.plant.progress >= 1) onPlanted(state, 'player', letter);
        break;
      }
    }
  } else if (!state.plant.planted) {
    state.plant.progress = Math.max(0, state.plant.progress - dt * 2);
  }

  // Player defuse channel (hold E near the planted charge).
  if (p.alive && state.plant.planted && state.input.interact) {
    const s = state.world.sites[state.plant.site];
    if (Math.hypot(p.pos.x - s.x, p.pos.z - s.z) < 3.0) {
      state.plant.defuseProgress += dt / DEFUSE_CHANNEL;
      if (Math.floor(state.plant.defuseProgress * 10) !== Math.floor((state.plant.defuseProgress - dt / DEFUSE_CHANNEL) * 10)) playDefuse();
      if (state.plant.defuseProgress >= 1) onDefused(state, 'player');
    }
  } else if (state.plant.planted) {
    state.plant.defuseProgress = Math.max(0, state.plant.defuseProgress - dt * 2);
  }

  // Elimination check.
  const vAlive = state.bots.filter((b) => b.team === 'V' && b.alive).length + (p.alive ? 1 : 0);
  const wAlive = state.bots.filter((b) => b.team === 'W' && b.alive).length;
  if (wAlive === 0) {
    endRound(state, 'V', state.plant.planted ? 'Defenders eliminated — charge stands' : 'Enemy team eliminated');
  } else if (vAlive === 0) {
    if (state.plant.planted) {
      // Attackers all dead but the charge is ticking — the round continues
      // until it explodes or is defused.
    } else {
      endRound(state, 'W', 'Attackers eliminated');
    }
  }
}

export function onPlanted(state, planter, site) {
  state.plant.planted = true;
  state.plant.site = site;
  state.plant.timer = PLANT_SECONDS;
  state.plant.planter = planter;
  state.plant.lastBeep = state.time;
  state.phaseTimer = PLANT_SECONDS;
  playPlantStart();
  state.banner = { text: 'CHARGE PLANTED', sub: `Site ${site} — defend it for ${PLANT_SECONDS} seconds`, team: 'V', until: state.time + 3 };
  state.killfeed.push({ text: `Charge planted at Site ${site}`, team: 'V', at: state.time });
}

export function onDefused(state, defuser) {
  state.plant.planted = false;
  endRound(state, 'W', defuser === 'player' ? 'You defused the charge' : 'Charge defused by the Wardens');
}

export function endRound(state, winner, reason) {
  if (state.phase === 'over') return;
  state.phase = 'over';
  state.phaseTimer = 5;
  state.score[winner] += 1;
  const playerWon = winner === 'V';
  // Economy: winners get $3,250, losers $1,900 (+$500 per loss in a row).
  if (playerWon) {
    state.money += 3250;
    state.lossStreak = 0;
    playRoundWin();
  } else {
    state.lossStreak += 1;
    state.money += 1900 + (state.lossStreak - 1) * 500;
    playRoundLose();
  }
  state.money = Math.min(state.money, 16000);
  state.banner = {
    text: playerWon ? 'ROUND WON' : 'ROUND LOST',
    sub: reason,
    team: winner,
    until: state.time + 5,
  };
  state.killfeed.push({ text: `Round ${state.round}: ${reason}`, team: winner, at: state.time });
  if (state.score[winner] >= WIN_ROUNDS) {
    state.matchWinner = winner;
    state.banner = {
      text: playerWon ? 'MATCH WON — DUSTLINE IS YOURS' : 'MATCH LOST',
      sub: `Final score ${state.score.V} – ${state.score.W}`,
      team: winner,
      until: state.time + 5,
    };
  }
}

// The player died: pass the charge to a random alive Vanguard bot.
export function transferCharge(state) {
  const alive = state.bots.filter((b) => b.team === 'V' && b.alive);
  if (alive.length === 0) return;
  const carrier = alive[Math.floor(state.rng() * alive.length)];
  carrier.carryingCharge = true;
  // The carrier's route becomes its site's route.
  const site = state.plant.targetSite || 'A';
  carrier.route = state.world.routes[site].map((k) => ({ ...state.world.waypoints[k] }));
  carrier.routeIdx = 0;
  carrier.state = 'route';
  state.killfeed.push({ text: `${carrier.name} picked up the charge`, team: 'V', at: state.time });
}

// Reload bookkeeping for the player (called every tick from main.js).
export function tickPlayerWeapon(state, time) {
  const loadout = state.playerLoadout;
  if (loadout.reloading && time >= loadout.reloadEnd) {
    const w = WEAPONS[loadout.current];
    const need = w.mag - loadout.mag[loadout.current];
    const take = Math.min(need, loadout.reserve[loadout.current]);
    loadout.mag[loadout.current] += take;
    if (Number.isFinite(loadout.reserve[loadout.current])) loadout.reserve[loadout.current] -= take;
    loadout.reloading = false;
  }
  if (!state.input.firing) loadout.spreadBloom = Math.max(0, loadout.spreadBloom - 0.06 * (1 / 60));
}

export { startReload };
