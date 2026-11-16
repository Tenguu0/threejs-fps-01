// DUSTLINE look plan — six colours carry the whole game.
// Dusk amber sky, slate steel, rust-orange accent, warm ink text.
export const PALETTE = {
  sky: 0x2b1d12, // dusk haze above the yard
  fog: 0x33241a, // fog colour, matches the horizon
  ground: 0x3d3125, // packed dirt yard
  surface: 0x4a3a2a, // container rust-brown
  slate: 0x2e3138, // dark steel panels
  steel: 0x5a616b, // lighter steel trim
  rust: 0xc75b16, // rust-orange accent (sites, charge)
  amber: 0xf0a830, // warm amber (lights, HUD highlights)
  ink: 0xe9e2d5, // warm off-white text
  muted: 0x9a8f80, // dimmed text
  vanguard: 0x3f8f5f, // attacker green
  warden: 0xc7522e, // defender rust-red
  smoke: 0x8a8d90, // smoke grenade grey
};

// Fog distances for the dusk haze: near enough to read the yard, far
// enough that the north wall melts into the sky colour.
export const FOG = { near: 32, far: 95 };

export const CSS = {
  canvas: '#241a12',
  surface: '#2e2620',
  panel: '#241d17',
  hairline: '#4a3d2e',
  ink: '#e9e2d5',
  muted: '#9a8f80',
  accent: '#f0a830',
  rust: '#c75b16',
  danger: '#e5484d',
  vanguard: '#4caf7d',
  warden: '#e0704f',
};

// Team colours, shared by HUD dots, bot uniforms and site markers.
export const TEAM = {
  V: { name: 'Vanguard', color: PALETTE.vanguard, css: CSS.vanguard },
  W: { name: 'Wardens', color: PALETTE.warden, css: CSS.warden },
};
