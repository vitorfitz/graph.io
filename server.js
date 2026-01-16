const WebSocket = require('ws');

const MAP_W = 3000, MAP_H = 2000, BASE_DOTS = 300, CONNECT_DIST = 50, DISCONNECT_DIST = 51;
const SPAWN_DOTS = 5, SPAWN_MARGIN = 200, SPAWN_MIN_DIST = 300, SPAWN_SPREAD = 50;
const CLICK_RADIUS = 150, CLICK_FORCE = 10, VELOCITY_DECAY = 0.05, CLICK_RANGE = 200;
const MIN_DOT_VEL = 0.4, MAX_DOT_VEL = 0.8;
const REPULSION_DECAY = 1;
const TICK_RATE = 60;

const dots = [];
const players = new Map();
const activeConnections = new Set();
let nextPlayerId = 1;

for (let i = 0; i < BASE_DOTS; i++) {
  dots.push(createDot(Math.random() * MAP_W, Math.random() * MAP_H));
}

function createDot(x, y) {
  const theta = 2 * Math.PI * Math.random();
  const vel = MIN_DOT_VEL + Math.random() * (MAX_DOT_VEL - MIN_DOT_VEL);
  return { x, y, baseVx: vel * Math.cos(theta), baseVy: vel * Math.sin(theta), clickVx: 0, clickVy: 0, repVx: 0, repVy: 0, owner: null };
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
  if (dist < 50) f += Math.min((100 / dist ** 2), 10);
  return f;
}

function update() {
  // Decay and accumulate repulsion
  for (const d of dots) {
    d.repVx *= (1 - REPULSION_DECAY);
    d.repVy *= (1 - REPULSION_DECAY);
  }

  // Repulsion between overlapping dots
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const dx = dots[j].x - dots[i].x, dy = dots[j].y - dots[i].y;
      const dist = Math.hypot(dx, dy);
      const force = getRepulsion(dist);
      if (force > 0) {
        const fx = (dx / dist) * force, fy = (dy / dist) * force;
        dots[i].repVx -= fx; dots[i].repVy -= fy;
        dots[j].repVx += fx; dots[j].repVy += fy;
      }
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

  const connections = [];
  const newActiveConnections = new Set();
  for (let i = 0; i < dots.length; i++) {
    for (let j = i + 1; j < dots.length; j++) {
      const dx = dots[i].x - dots[j].x, dy = dots[i].y - dots[j].y;
      const dist2 = dx * dx + dy * dy;
      const key = `${i},${j}`;
      const threshold = activeConnections.has(key) ? DISCONNECT_DIST : CONNECT_DIST;
      if (dist2 < threshold * threshold) {
        connections.push([i, j]);
        newActiveConnections.add(key);
      }
    }
  }
  activeConnections.clear();
  for (const k of newActiveConnections) activeConnections.add(k);

  const connCount = dots.map(() => ({}));
  for (const [i, j] of connections) {
    const oi = dots[i].owner, oj = dots[j].owner;
    if (oi !== null) connCount[j][oi] = (connCount[j][oi] || 0) + 1;
    if (oj !== null) connCount[i][oj] = (connCount[i][oj] || 0) + 1;
  }

  for (let i = 0; i < dots.length; i++) {
    const counts = connCount[i];
    const owners = Object.keys(counts).map(Number);
    const currentOwner = dots[i].owner;
    const currentCount = counts[currentOwner] || 0;

    if (owners.length === 0) {
      if (currentCount === 0) dots[i].owner = null;
    } else {
      const best = owners.reduce((a, b) => counts[a] > counts[b] ? a : b);
      if (best !== currentOwner && counts[best] > currentCount) {
        dots[i].owner = best;
      }
    }
  }

  for (const [id] of players) {
    if (!dots.some(d => d.owner === id)) respawnPlayer(id);
  }

  broadcast({ type: 'state', dots, connections });
}

function respawnPlayer(id) {
  const ws = players.get(id);
  if (ws) {
    spawnPlayer(id);
    ws.send(JSON.stringify({ type: 'respawn' }));
  }
}

function addForce(fOld, fNew) {
  if (Math.sign(fOld) != Math.sign(fNew) || Math.abs(fNew) > Math.abs(fOld)) {
    return fNew;
  }
  return fOld;
}

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function handleClick(playerId, x, y, px, py) {
  const myDots = dots.filter(d => d.owner === playerId);
  if (!myDots.some(d => Math.hypot(d.x - x, d.y - y) < CLICK_RANGE)) return;
  for (const d of dots) {
    const dist = (px !== undefined) ? distToSegment(d.x, d.y, px, py, x, y) : Math.hypot(d.x - x, d.y - y);
    if (dist < CLICK_RADIUS && dist > 0) {
      const dx = d.x - x, dy = d.y - y;
      const distToEnd = Math.hypot(dx, dy);
      if (distToEnd === 0) continue;
      const force = (1 - dist / CLICK_RADIUS) * CLICK_FORCE;
      const fx = (dx / distToEnd) * force;
      const fy = (dy / distToEnd) * force;
      d.clickVx = addForce(d.clickVx, fx);
      d.clickVy = addForce(d.clickVy, fy);
    }
  }
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of players.values()) if (ws.readyState === WebSocket.OPEN) ws.send(data);
}

const wss = new WebSocket.Server({ port: 8080 });
console.log('Server running on ws://localhost:8080');

wss.on('connection', ws => {
  const id = nextPlayerId++;
  players.set(id, ws);
  spawnPlayer(id);
  ws.send(JSON.stringify({ type: 'init', id, MAP_W, MAP_H, CLICK_RANGE }));
  ws.on('message', data => {
    const msg = JSON.parse(data);
    if (msg.type === 'click') handleClick(id, msg.x, msg.y, msg.px, msg.py);
  });
  ws.on('close', () => removePlayer(id));
});

setInterval(update, 1000 / TICK_RATE);
