const WebSocket = require('ws');

const TICK_RATE = 60;
const MAP_W = 3000, MAP_H = 3000, DOT_DENSITY = 1 / 20000, BASE_DOTS = MAP_W * MAP_H * DOT_DENSITY;
const CONNECT_DIST = 50, DISCONNECT_DIST = 50;
const SPAWN_DOTS = 5, SPAWN_MARGIN = 200, SPAWN_MIN_DIST = 300, SPAWN_SPREAD = 50;
const CLICK_RADIUS = 180, CLICK_FORCE = 12, VELOCITY_DECAY = 0.05, CLICK_RANGE = 200;
const MAX_STAMINA = 100, CLICK_COST = 15, DRAG_COST_PER_DIST = 0.15;
const MIN_DOT_VEL = 0.4, MAX_DOT_VEL = 0.8;
const REPULSION_DECAY = 1;

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

function createDot(x, y) {
  const theta = 2 * Math.PI * Math.random();
  const vel = MIN_DOT_VEL + Math.random() * (MAX_DOT_VEL - MIN_DOT_VEL);
  return { x, y, baseVx: vel * Math.cos(theta), baseVy: vel * Math.sin(theta), clickVx: 0, clickVy: 0, repVx: 0, repVy: 0, owner: null, claimTick: 0 };
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

function getRepulsion(dist) {
  let f = 0;
  if (dist < 49) f += Math.min((100 / dist ** 2), 10);
  return f;
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
    const force = getRepulsion(dist);
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
    d.x += d.baseVx + d.clickVx + d.repVx;
    d.y += d.baseVy + d.clickVy + d.repVy;

    if (d.x < 0 || d.x > MAP_W || d.y < 0 || d.y > MAP_H) {
      if (dots.length > BASE_DOTS) { dots.splice(i, 1); continue; }
      d.x = (d.x + MAP_W) % MAP_W;
      d.y = (d.y + MAP_H) % MAP_H;
      d.owner = null;
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

  const connCount = dots.map(() => ({}));
  for (const [i, j] of connections) {
    const oi = dots[i].owner, oj = dots[j].owner;
    if (oi !== null && dots[i].claimTick < currentTick - 1) connCount[j][oi] = (connCount[j][oi] || 0) + 1;
    if (oj !== null && dots[j].claimTick < currentTick - 1) connCount[i][oj] = (connCount[i][oj] || 0) + 1;
  }

  const newOwners = dots.map((d, i) => {
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
    if (newOwners[i] !== dots[i].owner) dots[i].claimTick = currentTick;
    dots[i].owner = newOwners[i];
  }

  for (const [id, player] of players) {
    if (!player.holding) player.stamina = Math.min(MAX_STAMINA, player.stamina + (MAX_STAMINA - player.stamina) * 0.1);
    else player.holding = false;

    if (!dots.some(d => d.owner === id)) respawnPlayer(id);
    if (player.ws.readyState === WebSocket.OPEN) {
      player.ws.send(JSON.stringify({ type: 'state', dots, connections, stamina: player.stamina }));
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
  ws.send(JSON.stringify({ type: 'init', id, MAP_W, MAP_H, CLICK_RANGE }));
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'click') handleClick(id, msg.x, msg.y, msg.px, msg.py);
  });
  ws.on('close', () => removePlayer(id));
});

setInterval(update, 1000 / TICK_RATE);
