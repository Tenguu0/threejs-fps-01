// DUSTLINE HUD — DOM overlay, minimap canvas, buy menu, banners, kill feed.
// The HUD never allocates in the hot path: elements are cached at init and
// only textContent/style is touched when the value actually changed.
import { WEAPONS, GRENADES } from './weapon.js';

const $ = (id) => document.getElementById(id);

export function initHud() {
  const hud = {
    hp: $('hp-value'),
    armor: $('armor-value'),
    ammoMag: $('ammo-mag'),
    ammoReserve: $('ammo-reserve'),
    ammoBox: $('ammo'),
    weaponName: $('weapon-name'),
    grenades: $('grenades'),
    timer: $('timer'),
    scoreV: $('score-v'),
    scoreW: $('score-w'),
    aliveV: $('alive-v'),
    aliveW: $('alive-w'),
    money: $('money'),
    crosshair: $('crosshair'),
    hitmarker: $('hitmarker'),
    killfeed: $('killfeed'),
    banner: $('banner'),
    bannerTitle: $('banner-title'),
    bannerSub: $('banner-sub'),
    plantBar: $('plant-bar'),
    plantFill: $('plant-fill'),
    plantLabel: $('plant-label'),
    buyMenu: $('buy-menu'),
    buyMoney: $('buy-money'),
    buyMsg: $('buy-msg'),
    overlay: $('overlay'),
    overlayTitle: $('overlay-title'),
    overlayCopy: $('overlay-copy'),
    playBtn: $('play'),
    flash: $('flash'),
    damage: $('damage'),
    minimap: $('minimap'),
    charge: $('charge'),
    roundLabel: $('round-label'),
    cache: {},
  };
  hud.mm = hud.minimap.getContext('2d');
  return hud;
}

function setText(el, key, value, cache) {
  if (cache[key] !== value) {
    cache[key] = value;
    el.textContent = value;
  }
}

export function updateHud(state, hud) {
  const c = hud.cache;
  const p = state.player;
  const loadout = state.playerLoadout;
  const w = WEAPONS[loadout.current];

  setText(hud.hp, 'hp', String(Math.ceil(p.hp)), c);
  setText(hud.armor, 'armor', String(Math.ceil(p.armor)), c);
  setText(hud.ammoMag, 'mag', String(loadout.mag[loadout.current]), c);
  setText(hud.ammoReserve, 'res', Number.isFinite(loadout.reserve[loadout.current]) ? `/ ${loadout.reserve[loadout.current]}` : '/ ∞', c);
  setText(hud.weaponName, 'wname', w.name.toUpperCase(), c);
  const g = loadout.grenades;
  const gText = g.flash + g.smoke > 0 ? `FLASH ${g.flash} · SMOKE ${g.smoke}` : '';
  setText(hud.grenades, 'gren', gText, c);
  setText(hud.money, 'money', `$${state.money}`, c);
  setText(hud.scoreV, 'sv', String(state.score.V), c);
  setText(hud.scoreW, 'sw', String(state.score.W), c);
  setText(hud.roundLabel, 'round', `ROUND ${state.round}`, c);

  const vAlive = state.bots.filter((b) => b.team === 'V' && b.alive).length + (p.alive ? 1 : 0);
  const wAlive = state.bots.filter((b) => b.team === 'W' && b.alive).length;
  setText(hud.aliveV, 'av', `● ${vAlive}`, c);
  setText(hud.aliveW, 'aw', `● ${wAlive}`, c);

  // Timer: buy phase counts down in amber, live in white, planted in red.
  const t = Math.max(0, Math.ceil(state.phaseTimer));
  const mm = Math.floor(t / 60);
  const ss = String(t % 60).padStart(2, '0');
  setText(hud.timer, 'timer', `${mm}:${ss}`, c);
  const timerClass = state.plant.planted ? 'planted' : state.phase === 'buy' ? 'buy' : '';
  if (c.timerClass !== timerClass) {
    c.timerClass = timerClass;
    hud.timer.className = timerClass;
  }

  // Crosshair spread grows with bloom + movement.
  const spread = 6 + loadout.spreadBloom * 260 + p.speed * 1.1;
  if (c.spread !== Math.round(spread)) {
    c.spread = Math.round(spread);
    hud.crosshair.style.setProperty('--spread', `${Math.round(spread)}px`);
  }
  if (c.flash !== p.flash.toFixed(2)) {
    c.flash = p.flash.toFixed(2);
    hud.flash.style.opacity = p.flash.toFixed(2);
  }
  if (c.dead !== String(!p.alive)) {
    c.dead = String(!p.alive);
    hud.damage.style.opacity = p.alive ? '0' : '0.55';
  }

  // Charge indicator.
  const chargeText = state.plant.planted
    ? `CHARGE LIVE — SITE ${state.plant.site}`
    : p.hasCharge
      ? 'YOU CARRY THE CHARGE'
      : state.bots.some((b) => b.carryingCharge)
        ? `${state.bots.find((b) => b.carryingCharge).name.toUpperCase()} CARRIES THE CHARGE`
        : 'CHARGE DOWN';
  setText(hud.charge, 'charge', chargeText, c);

  // Plant / defuse progress bar.
  const prog = state.plant.planted ? state.plant.defuseProgress : state.plant.progress;
  const showBar = prog > 0.01 && prog < 1;
  if (c.showBar !== showBar) {
    c.showBar = showBar;
    hud.plantBar.hidden = !showBar;
  }
  if (showBar) {
    const pct = Math.round(prog * 100);
    if (c.prog !== pct) {
      c.prog = pct;
      hud.plantFill.style.width = `${pct}%`;
      hud.plantLabel.textContent = state.plant.planted ? `DEFUSING ${pct}%` : `PLANTING ${pct}%`;
    }
  }

  // Round banner.
  const b = state.banner;
  const showBanner = !!b && state.time < b.until;
  if (c.showBanner !== showBanner) {
    c.showBanner = showBanner;
    hud.banner.hidden = !showBanner;
  }
  if (showBanner) {
    setText(hud.bannerTitle, 'bt', b.text, c);
    setText(hud.bannerSub, 'bs', b.sub, c);
    const cls = b.team ? `team-${b.team}` : '';
    if (c.bannerClass !== cls) {
      c.bannerClass = cls;
      hud.banner.className = cls;
    }
  }

  drawMinimap(state, hud);
  updateKillfeed(state, hud);
}

function drawMinimap(state, hud) {
  const g = hud.mm;
  const W = 150;
  const H = 120;
  const bounds = state.world.bounds;
  const sx = (x) => ((x - bounds.minX) / (bounds.maxX - bounds.minX)) * W;
  const sz = (z) => ((z - bounds.minZ) / (bounds.maxZ - bounds.minZ)) * H;
  g.clearRect(0, 0, W, H);
  g.fillStyle = 'rgba(36,29,23,0.85)';
  g.fillRect(0, 0, W, H);
  // Site rings.
  for (const [letter, s] of Object.entries(state.world.sites)) {
    g.strokeStyle = '#c75b16';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(sx(s.x), sz(s.z), 7, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#f0a830';
    g.font = 'bold 10px system-ui, sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(letter, sx(s.x), sz(s.z));
  }
  // Planted charge blinks.
  if (state.plant.planted) {
    const s = state.world.sites[state.plant.site];
    g.fillStyle = Math.floor(state.time * 3) % 2 ? '#e5484d' : '#f0a830';
    g.beginPath();
    g.arc(sx(s.x), sz(s.z), 4, 0, Math.PI * 2);
    g.fill();
  }
  // Bots.
  for (const bot of state.bots) {
    if (!bot.alive) continue;
    g.fillStyle = bot.team === 'V' ? '#4caf7d' : '#e0704f';
    g.beginPath();
    g.arc(sx(bot.pos.x), sz(bot.pos.z), 3, 0, Math.PI * 2);
    g.fill();
  }
  // Player: white triangle pointing where they face.
  const p = state.player;
  if (p.alive) {
    g.save();
    g.translate(sx(p.pos.x), sz(p.pos.z));
    g.rotate(-p.yaw);
    g.fillStyle = '#e9e2d5';
    g.beginPath();
    g.moveTo(0, -6);
    g.lineTo(4, 5);
    g.lineTo(-4, 5);
    g.closePath();
    g.fill();
    g.restore();
  }
}

function updateKillfeed(state, hud) {
  const items = state.killfeed.slice(-4);
  const key = items.map((i) => i.text).join('|');
  if (hud.cache.feedKey === key) return;
  hud.cache.feedKey = key;
  hud.killfeed.innerHTML = items
    .map((i) => `<div class="feed-${i.team === 'V' ? 'v' : 'w'}">${i.text}</div>`)
    .join('');
}

export function showHitmarker(hud, kill) {
  hud.hitmarker.classList.add('on');
  if (kill) hud.hitmarker.classList.add('kill');
  clearTimeout(hud._hmTimer);
  hud._hmTimer = setTimeout(() => hud.hitmarker.classList.remove('on', 'kill'), kill ? 400 : 120);
}

export function showBuyMenu(state, hud, open) {
  hud.buyMenu.hidden = !open;
  if (!open) return;
  const loadout = state.playerLoadout;
  setText(hud.buyMoney, 'bmoney', `$${state.money}`, hud.cache);
  const rows = [
    ['1', 'VK-9 "Jackal" — rifle', '$2700', loadout.owned.has('jackal')],
    ['2', 'Hornet-9 — SMG', '$1500', loadout.owned.has('hornet')],
    ['3', 'Longshot .50 — sniper', '$4750', loadout.owned.has('longshot')],
    ['4', 'Kevlar + helmet', '$650', state.player.armor >= 100],
    ['5', 'Flashbang', '$200', false],
    ['6', 'Smoke grenade', '$300', false],
  ];
  hud.buyMenu.querySelector('.buy-rows').innerHTML = rows
    .map(([k, name, price, owned]) =>
      `<div class="buy-row${owned ? ' owned' : ''}"><kbd>${k}</kbd><span>${name}</span><b>${owned ? 'OWNED' : price}</b></div>`)
    .join('');
}

export function showBuyMsg(hud, msg) {
  if (!msg) return;
  hud.buyMsg.textContent = msg;
  clearTimeout(hud._bmTimer);
  hud._bmTimer = setTimeout(() => { hud.buyMsg.textContent = ''; }, 2500);
}

export function setOverlay(hud, { title, copy, button, show }) {
  hud.overlay.hidden = !show;
  if (!show) return;
  if (title) hud.overlayTitle.textContent = title;
  if (copy) hud.overlayCopy.textContent = copy;
  if (button) hud.playBtn.textContent = button;
}
