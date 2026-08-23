const WebSocket = require('ws');

const TICK_RATE = 60;
const MAP_W = 3000, MAP_H = 3000, DOT_DENSITY = 1 / 20000, BASE_DOTS = MAP_W * MAP_H * DOT_DENSITY;
const CONNECT_DIST = 50, DISCONNECT_DIST = 50;
const SPAWN_DOTS = 5, SPAWN_MARGIN = 200, SPAWN_MIN_DIST = 300, SPAWN_SPREAD = 50;
const CLICK_RADIUS = 180, CLICK_FORCE = 12, VELOCITY_DECAY = 0.05, CLICK_RANGE = 200;
const MAX_STAMINA = 100, CLICK_COST = 15, DRAG_COST_PER_DIST = 0.15;
const MIN_DOT_VEL = 0.5, MAX_DOT_VEL = 1;
const REPULSION_DECAY = 1;

// Special dots
const SPECIAL_DOT_REPULSION_MULT = 1.6;
const SPECIAL_SPAWN_CHANCE = 1 / 25;
const MAX_SPECIAL_DOTS = 10;
const SPECIAL_TYPE_WEIGHTS = { magnet: 1, bomb: 3, hub: 1, star: 1 };

// Magnet special dot
const MAGNET_DURATION_MS = 3000;
const MAGNET_ACCEL = 0.2;
const MAGNET_MAX_SPEED = 6;

// Hub special dot: once claimed, connects to every dot (regardless of owner)
// within HUB_RADIUS, for a fixed duration.
const HUB_DURATION_MS = 10000;
const HUB_RADIUS = 400;

// Bomb special dot
const BOMB_MIN_FUSE_MS = 10000, BOMB_MAX_FUSE_MS = 20000;
const BOMB_RADIUS = 600, BOMB_FORCE = 40;

// Star special dot: once claimed, fixes the claiming player's stamina at a
// constant value for a fixed duration.
const STAR_DURATION_MS = 6500;
const STAR_STAMINA = 150;

const dots = [];
const players = new Map(); // id -> { ws, stamina }
const activeConnections = new Set();
let nextPlayerId = 1;
let currentTick = 0;

// Spatial hashing
const CELL_SIZE = DISCONNECT_DIST;
const GRID_W = Math.ceil(MAP_W / CELL_SIZE);
const GRID_H = Math.ceil(MAP_H / CELL_SIZE);
let grid = [];

function rebuildGrid() {
  grid = Array.from({ length: GRID_W * GRID_H }, () => []);
  for (let i = 0; i < dots.length; i++) {
    const cx = Math.floor(dots[i].x / CELL_SIZE);
    const cy = Math.floor(dots[i].y / CELL_SIZE);
    if (cx >= 0 && cx < GRID_W && cy >= 0 && cy < GRID_H) {
      grid[cy * GRID_W + cx].push(i);
    }
  }
}

function* getNearbyPairs() {
  for (let cy = 0; cy < GRID_H; cy++) {
    for (let cx = 0; cx < GRID_W; cx++) {
      const cell = grid[cy * GRID_W + cx];
      // Pairs within same cell
      for (let a = 0; a < cell.length; a++) {
        for (let b = a + 1; b < cell.length; b++) {
          yield [cell[a], cell[b]];
        }
      }
      // Pairs with neighboring cells (right, bottom-left, bottom, bottom-right)
      const neighbors = [[1, 0], [-1, 1], [0, 1], [1, 1]];
      for (const [dx, dy] of neighbors) {
        const nx = cx + dx, ny = cy + dy;
        if (nx >= 0 && nx < GRID_W && ny >= 0 && ny < GRID_H) {
          const neighbor = grid[ny * GRID_W + nx];
          for (const i of cell) {
            for (const j of neighbor) {
              yield [Math.min(i, j), Math.max(i, j)];
            }
          }
        }
      }
    }
  }
}

for (let i = 0; i < BASE_DOTS; i++) {
  dots.push(createDot(Math.random() * MAP_W, Math.random() * MAP_H));
}

function createDot(x, y, special = null) {
  const theta = 2 * Math.PI * Math.random();
  const vel = MIN_DOT_VEL + Math.random() * (MAX_DOT_VEL - MIN_DOT_VEL);
  return {
    x, y,
    baseVx: vel * Math.cos(theta), baseVy: vel * Math.sin(theta),
    clickVx: 0, clickVy: 0, repVx: 0, repVy: 0,
    magnetVx: 0, magnetVy: 0, magnetTargetIdx: -1,
    owner: null, claimTick: 0,
    special, // null | 'magnet' | 'bomb' | 'hub' | 'star'
    magnetUntil: 0, // tick at which this dot's OWN magnet effect (if it is one) expires
    hubUntil: 0, // tick at which this dot's OWN hub effect (if it is one) expires
    starUntil: 0, // tick at which this dot's OWN star effect (if it is one) expires
    // Bomb fuse starts counting down immediately upon spawn, regardless of ownership.
    bombDetonateTick: special === 'bomb'
      ? currentTick + Math.round((BOMB_MIN_FUSE_MS + Math.random() * (BOMB_MAX_FUSE_MS - BOMB_MIN_FUSE_MS)) / (1000 / TICK_RATE))
      : 0,
  };
}

function countSpecialDots() {
  return dots.reduce((n, d) => n + (d.special ? 1 : 0), 0);
}

function pickWeightedSpecialType() {
  const entries = Object.entries(SPECIAL_TYPE_WEIGHTS);
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let r = Math.random() * total;
  for (const [type, weight] of entries) {
    r -= weight;
    if (r < 0) return type;
  }
  return entries[entries.length - 1][0]; // fallback for float rounding
}

function maybeSpawnSpecialAt(x, y) {
  if (countSpecialDots() >= MAX_SPECIAL_DOTS) return null;
  if (Math.random() >= SPECIAL_SPAWN_CHANCE) return null;
  return createDot(x, y, pickWeightedSpecialType());
}

function randomEdgePoint() {
  const side = Math.floor(Math.random() * 4);
  if (side === 0) return { x: 0, y: Math.random() * MAP_H };
  if (side === 1) return { x: MAP_W, y: Math.random() * MAP_H };
  if (side === 2) return { x: Math.random() * MAP_W, y: 0 };
  return { x: Math.random() * MAP_W, y: MAP_H };
}

function findSpawnPoint() {
  const owned = dots.filter(d => d.owner !== null);
  for (let attempt = 0; attempt < 50; attempt++) {
    const x = SPAWN_MARGIN + Math.random() * (MAP_W - SPAWN_MARGIN * 2);
    const y = SPAWN_MARGIN + Math.random() * (MAP_H - SPAWN_MARGIN * 2);
    const minDist = owned.reduce((min, d) => Math.min(min, Math.hypot(d.x - x, d.y - y)), Infinity);
    if (minDist > SPAWN_MIN_DIST || owned.length === 0) return { x, y };
  }
  return { x: Math.random() * MAP_W, y: Math.random() * MAP_H };
}

function spawnPlayer(id) {
  const { x, y } = findSpawnPoint();
  for (let i = 0; i < SPAWN_DOTS; i++) {
    const dot = createDot(x + (Math.random() - 0.5) * SPAWN_SPREAD, y + (Math.random() - 0.5) * SPAWN_SPREAD);
    dot.owner = id;
    dots.push(dot);
  }
}

function removePlayer(id) {
  for (const d of dots) if (d.owner === id) d.owner = null;
  players.delete(id);
}

function getRepulsion(dist, radiusMult = 1) {
  let f = 0;
  const threshold = 49 * radiusMult;
  if (dist < threshold) f += Math.min((100 * radiusMult ** 2 / dist ** 2), 10 * radiusMult);
  return f;
}

// Scatters dots around a detonating bomb with a powerful click-like radial
// force. Unlike a player click, this is not gated by ownership/range and
// affects every dot (regardless of owner) within BOMB_RADIUS.
function detonateBomb(bomb) {
  for (const d of dots) {
    if (d === bomb) continue;
    const dx = d.x - bomb.x, dy = d.y - bomb.y;
    const dist = Math.hypot(dx, dy);
    if (dist < BOMB_RADIUS && dist > 0) {
      const force = (1 - dist / BOMB_RADIUS) * BOMB_FORCE;
      d.clickVx = addForce(d.clickVx, (dx / dist) * force);
      d.clickVy = addForce(d.clickVy, (dy / dist) * force);
    }
  }
}

function update() {
  currentTick++;
  rebuildGrid();

  // Decay and accumulate repulsion
  for (const d of dots) {
    d.repVx *= (1 - REPULSION_DECAY);
    d.repVy *= (1 - REPULSION_DECAY);
  }

  // Repulsion between nearby dots (using spatial hash)
  for (const [i, j] of getNearbyPairs()) {
    const dx = dots[j].x - dots[i].x, dy = dots[j].y - dots[i].y;
    const dist = Math.hypot(dx, dy);
    const radiusMult = Math.max(
      dots[i].special ? SPECIAL_DOT_REPULSION_MULT : 1,
      dots[j].special ? SPECIAL_DOT_REPULSION_MULT : 1
    );
    const force = getRepulsion(dist, radiusMult);
    if (force > 0) {
      const fx = (dx / dist) * force, fy = (dy / dist) * force;
      dots[i].repVx -= fx; dots[i].repVy -= fy;
      dots[j].repVx += fx; dots[j].repVy += fy;
    }
  }

  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    d.clickVx *= (1 - VELOCITY_DECAY);
    d.clickVy *= (1 - VELOCITY_DECAY);
    const bombFactor=d.special=="bomb"? 2: 1;
    d.x += d.baseVx*bombFactor + d.clickVx + d.repVx + d.magnetVx;
    d.y += d.baseVy*bombFactor + d.clickVy + d.repVy + d.magnetVy;

    if (d.x < 0 || d.x > MAP_W || d.y < 0 || d.y > MAP_H) {
      if (dots.length > BASE_DOTS) { dots.splice(i, 1); continue; }
      d.x = (d.x + MAP_W) % MAP_W;
      d.y = (d.y + MAP_H) % MAP_H;
      d.owner = null;
      d.special = null;
      const special = maybeSpawnSpecialAt(d.x, d.y);
      if (special) {
        d.special = special.special;
        d.bombDetonateTick = special.bombDetonateTick;
        d.magnetUntil = special.magnetUntil;
        d.hubUntil = special.hubUntil;
        d.starUntil = special.starUntil;
      }
    }
  }

  // Remove expired magnet dots now, before connections/indices are computed for
  // this tick, so the index-based `connections` array stays consistent. Each
  // consumed magnet dot is replaced by a fresh normal dot spawned on the map edge.
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.special === 'magnet' && d.owner !== null && currentTick >= d.magnetUntil) {
      dots.splice(i, 1);
      const { x, y } = randomEdgePoint();
      dots.push(createDot(x, y));
    }
  }

  // Remove expired hub dots the same way, before connections/indices are
  // computed for this tick.
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.special === 'hub' && d.owner !== null && currentTick >= d.hubUntil) {
      dots.splice(i, 1);
      const { x, y } = randomEdgePoint();
      dots.push(createDot(x, y));
    }
  }

  // Remove expired star dots the same way, before connections/indices are
  // computed for this tick.
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.special === 'star' && d.owner !== null && currentTick >= d.starUntil) {
      dots.splice(i, 1);
      const { x, y } = randomEdgePoint();
      dots.push(createDot(x, y));
    }
  }

  // Detonate bombs whose fuse has run out. The fuse counts down regardless of
  // ownership. On detonation, nearby dots are scattered with a powerful
  // click-like force, then the bomb dot is consumed and replaced by a fresh
  // normal dot spawned on the map edge (same pattern as expired magnets).
  for (let i = dots.length - 1; i >= 0; i--) {
    const d = dots[i];
    if (d.special === 'bomb' && currentTick >= d.bombDetonateTick) {
      detonateBomb(d);
      dots.splice(i, 1);
      const { x, y } = randomEdgePoint();
      dots.push(createDot(x, y));
    }
  }

  rebuildGrid(); // Rebuild after position updates

  const connections = [];
  const newActiveConnections = new Set();
  for (const [i, j] of getNearbyPairs()) {
    const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
    const dist2 = dx * dx + dy * dy;
    const key = `${i},${j}`;
    const threshold = activeConnections.has(key) ? DISCONNECT_DIST : CONNECT_DIST;
    if (dist2 < threshold * threshold) {
      connections.push([i, j]);
      newActiveConnections.add(key);
    }
  }
  activeConnections.clear();
  for (const k of newActiveConnections) activeConnections.add(k);

  // Active hubs connect to every dot (regardless of owner) within HUB_RADIUS.
  // These are added as real connections (not just visual) so they also feed
  // into the capture logic below, same as proximity connections — meaning a
  // hub can pull in and contest dots belonging to other players too.
  for (let h = 0; h < dots.length; h++) {
    const hub = dots[h];
    if (hub.special !== 'hub' || hub.owner === null || currentTick >= hub.hubUntil) continue;
    for (let i = 0; i < dots.length; i++) {
      if (i === h) continue;
      const dx = dots[i].x - hub.x, dy = dots[i].y - hub.y;
      if (dx * dx + dy * dy > HUB_RADIUS * HUB_RADIUS) continue;
      connections.push([Math.min(h, i), Math.max(h, i)]);
    }
  }

  const connCount = dots.map(() => ({}));
  for (const [i, j] of connections) {
    const oi = dots[i].owner, oj = dots[j].owner;
    if (oi !== null && dots[i].claimTick < currentTick - 1) connCount[j][oi] = (connCount[j][oi] || 0) + 1;
    if (oj !== null && dots[j].claimTick < currentTick - 1) connCount[i][oj] = (connCount[i][oj] || 0) + 1;
  }

  const newOwners = dots.map((d, i) => {
    // Timer-based powers (magnet, hub, star), once claimed, keep their owner
    // until consumed/removed — they cannot be captured away by another player
    // during their active window. Without this, an opponent could recapture
    // the dot mid-effect and reset/restart the timer indefinitely.
    if ((d.special === 'magnet' || d.special === 'hub' || d.special === 'star') && d.owner !== null) return d.owner;

    const counts = connCount[i];
    const owners = Object.keys(counts).map(Number);
    const currentOwner = d.owner;
    const currentCount = counts[currentOwner] || 0;

    if (owners.length === 0) return currentCount === 0 ? null : currentOwner;

    const maxCount = Math.max(...Object.values(counts));
    if (maxCount <= currentCount) return currentOwner;

    const winners = owners.filter(o => counts[o] === maxCount);
    if (winners.length > 1) return currentOwner; // Tie - no change

    return winners[0];
  });

  for (let i = 0; i < dots.length; i++) {
    if (newOwners[i] !== dots[i].owner) {
      dots[i].claimTick = currentTick;
      if (dots[i].special === 'magnet' && newOwners[i] !== null) {
        dots[i].magnetUntil = currentTick + Math.round(MAGNET_DURATION_MS / (1000 / TICK_RATE));
      }
      if (dots[i].special === 'hub' && newOwners[i] !== null) {
        dots[i].hubUntil = currentTick + Math.round(HUB_DURATION_MS / (1000 / TICK_RATE));
      }
      if (dots[i].special === 'star' && newOwners[i] !== null) {
        dots[i].starUntil = currentTick + Math.round(STAR_DURATION_MS / (1000 / TICK_RATE));
      }
    }
    dots[i].owner = newOwners[i];
  }

  // Apply magnet attraction: dots owned by a player whose magnet dot is active
  // accelerate toward that magnet dot at a constant rate, up to a max speed,
  // independent of distance. Expiry/removal of the magnet dot itself is handled
  // earlier in the tick (before connections are computed) to keep index-based
  // `connections` consistent.
  for (const magnet of dots) {
    if (magnet.special !== 'magnet' || magnet.owner === null) continue;
    if (currentTick >= magnet.magnetUntil) continue;

    for (const d of dots) {
      if (d === magnet || d.owner !== magnet.owner) continue;
      const dx = magnet.x - d.x, dy = magnet.y - d.y;
      const dist = Math.hypot(dx, dy);
      if (dist < 1) continue;
      d.magnetVx += (dx / dist) * MAGNET_ACCEL;
      d.magnetVy += (dy / dist) * MAGNET_ACCEL;
      const speed = Math.hypot(d.magnetVx, d.magnetVy);
      if (speed > MAGNET_MAX_SPEED) {
        d.magnetVx = (d.magnetVx / speed) * MAGNET_MAX_SPEED;
        d.magnetVy = (d.magnetVy / speed) * MAGNET_MAX_SPEED;
      }
    }
  }

  for (const d of dots) {
    if (d.magnetVx || d.magnetVy) {
      d.magnetVx *= (1 - VELOCITY_DECAY);
      d.magnetVy *= (1 - VELOCITY_DECAY);
      if (Math.hypot(d.magnetVx, d.magnetVy) < 0.01) { d.magnetVx = 0; d.magnetVy = 0; }
    }
  }

  // Determine which players currently have an active star effect: their
  // stamina is fixed at STAR_STAMINA for the duration instead of regenerating
  // normally.
  const starredPlayers = new Set();
  for (const d of dots) {
    if (d.special === 'star' && d.owner !== null && currentTick < d.starUntil) {
      starredPlayers.add(d.owner);
    }
  }

  for (const [id, player] of players) {
    if (starredPlayers.has(id)) {
      player.stamina = STAR_STAMINA;
    } else {
      player.stamina = Math.min(MAX_STAMINA, player.stamina + (MAX_STAMINA - player.stamina) * 0.1);
    }
    player.holding = false;

    if (!dots.some(d => d.owner === id)) respawnPlayer(id);
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({ type: 'state', dots, connections, stamina: player.stamina, tick: currentTick }));
    }
  }
}

function respawnPlayer(id) {
  const player = players.get(id);
  if (player) {
    spawnPlayer(id);
    player.ws.send(JSON.stringify({ type: 'respawn' }));
  }
}

function addForce(fOld, fNew) {
  if (Math.sign(fOld) != Math.sign(fNew)) {
    return fOld + fNew;
  }
  if (Math.abs(fNew) > Math.abs(fOld)) {
    return fNew;
  }
  return fOld;
}

function closestPointOnSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return { x: x1, y: y1 };
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return { x: x1 + t * dx, y: y1 + t * dy };
}

function handleClick(playerId, x, y, px, py) {
  const player = players.get(playerId);
  if (!player) return;

  const myDots = dots.filter(d => d.owner === playerId);
  const inRange = (cx, cy) => myDots.some(d => Math.hypot(d.x - cx, d.y - cy) < CLICK_RANGE);
  if (!inRange(x, y)) return;
  if (px !== undefined && !inRange(px, py)) return;

  // Broadcast click to all other players
  const clickMsg = JSON.stringify({ type: 'click', id: playerId, x, y, px, py, stam: player.stamina });
  for (const [id, p] of players) {
    if (id !== playerId && p.ws.readyState === WebSocket.OPEN) p.ws.send(clickMsg);
  }

  // Calculate stamina cost
  player.holding = px !== undefined;
  let cost = player.holding ? Math.hypot(x - px, y - py) * DRAG_COST_PER_DIST : CLICK_COST;
  if (player.stamina < cost) cost = player.stamina;
  player.stamina -= cost;

  // Effectiveness scales with stamina (0.2 to 1.0)
  const effectiveness = 0.4 + 0.6 * Math.sqrt(player.stamina / MAX_STAMINA);
  const radius = CLICK_RADIUS * effectiveness;

  for (const d of dots) {
    let cx = x, cy = y;
    if (px !== undefined) {
      const closest = closestPointOnSegment(d.x, d.y, px, py, x, y);
      cx = closest.x; cy = closest.y;
    }
    const dx = d.x - cx, dy = d.y - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < radius && dist > 0) {
      const force = (1 - dist / radius) * CLICK_FORCE * effectiveness;
      d.clickVx = addForce(d.clickVx, (dx / dist) * force);
      d.clickVy = addForce(d.clickVy, (dy / dist) * force);
    }
  }
}

const wss = new WebSocket.Server({ port: 8080 });
console.log('Server running on ws://localhost:8080');

wss.on('connection', ws => {
  const id = nextPlayerId++;
  players.set(id, { ws, stamina: MAX_STAMINA, holding: false });
  spawnPlayer(id);
  ws.send(JSON.stringify({ type: 'init', id, MAP_W, MAP_H, CLICK_RANGE, TICK_RATE, MAGNET_DURATION_MS, HUB_DURATION_MS, STAR_DURATION_MS }));
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'click') handleClick(id, msg.x, msg.y, msg.px, msg.py);
  });
  ws.on('close', () => removePlayer(id));
});

setInterval(update, 1000 / TICK_RATE);
