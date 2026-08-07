/* ============================================================
   FLOPPY BIRD  —  vanilla JS, frame-rate independent physics
   ============================================================ */

// ----- Canvas / DPR scaling so it stays crisp on any display -----
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const VIEW_W = 400;
const VIEW_H = 600;

function setupDPR() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width  = VIEW_W * dpr;
  canvas.height = VIEW_H * dpr;
  canvas.style.width  = '100%';
  canvas.style.height = '100%';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in logical 400x600 space
}
setupDPR();

// ----- DOM refs -----
const hud         = document.getElementById('hud');
const scoreEl     = document.getElementById('scoreDisplay');
const overlay     = document.getElementById('overlay');
const startScreen = document.getElementById('startScreen');
const overScreen  = document.getElementById('gameoverScreen');
const finalScore  = document.getElementById('finalScore');
const bestScoreEl = document.getElementById('bestScore');
const medalEl     = document.getElementById('medal');

// ----- Tunable game constants -----
const GRAVITY        = 820;    // gentler fall gives the player more reaction time
const FLAP_VELOCITY  = -390;   // softer flap makes height easier to control
const PIPE_SPEED     = 82;     // slower obstacles
const PIPE_GAP       = 220;    // larger vertical gap between each pair
const PIPE_WIDTH     = 70;
const PIPE_INTERVAL  = 2.25;   // more space between obstacles
const GROUND_HEIGHT  = 90;
const BIRD_X         = 90;     // fixed horizontal position
const BIRD_RADIUS    = 16;     // visual radius
const HITBOX_SCALE   = 0.65;   // forgiving collision box inside the visible bird

// ----- Game state -----
const STATE = { START: 0, PLAYING: 1, GAMEOVER: 2 };
let gameState = STATE.START;

let bird, pipes, score, best, spawnTimer, lastTime, elapsed;

best = parseInt(localStorage.getItem('floppyBest') || '0', 10);

// ============================================================
//  AUDIO  (Web Audio API procedural beeps — no asset files)
// ============================================================
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioCtx = null; }
  }
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}
function beep(freq, dur, type = 'square', vol = 0.15, slideTo = null) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, audioCtx.currentTime + dur);
  gain.gain.setValueAtTime(vol, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
  osc.connect(gain); gain.connect(audioCtx.destination);
  osc.start();
  osc.stop(audioCtx.currentTime + dur);
}
const sfx = {
  flap:  () => beep(520, 0.10, 'square',   0.12, 760),
  score: () => beep(880, 0.09, 'triangle', 0.14, 1180),
  hit:   () => { beep(180, 0.18, 'sawtooth', 0.20, 60);
                 setTimeout(() => beep(110, 0.22, 'sawtooth', 0.16, 50), 90); },
};

// ============================================================
//  BIRD
// ============================================================
function resetBird() {
  bird = {
    y: VIEW_H * 0.45,
    vy: 0,
    rot: 0,
    flapAnim: 0,   // wing-flap animation timer
  };
}
function flap() {
  bird.vy = FLAP_VELOCITY;
  bird.flapAnim = 0.18;   // wings up for 180ms
  sfx.flap();
}
function updateBird(dt) {
  bird.vy += GRAVITY * dt;
  bird.y  += bird.vy * dt;
  // rotation: tilt up when rising, dive when falling
  const targetRot = bird.vy < 0 ? -0.45 : Math.min(Math.PI / 2, bird.vy / 480);
  bird.rot += (targetRot - bird.rot) * 0.18;
  bird.flapAnim = Math.max(0, bird.flapAnim - dt);
}
function drawBird() {
  ctx.save();
  ctx.translate(BIRD_X, bird.y);
  ctx.rotate(bird.rot);

  // body
  ctx.fillStyle = '#f7d51d';
  ctx.strokeStyle = '#000';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, BIRD_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // belly
  ctx.fillStyle = '#fff3b0';
  ctx.beginPath();
  ctx.arc(-2, 5, BIRD_RADIUS * 0.6, 0, Math.PI * 2);
  ctx.fill();

  // wing (flaps)
  const wingUp = bird.flapAnim > 0;
  ctx.fillStyle = '#e8a020';
  ctx.beginPath();
  if (wingUp) {
    ctx.ellipse(-4, -6, 10, 6, -0.5, 0, Math.PI * 2);
  } else {
    ctx.ellipse(-4, 4, 10, 6, 0.4, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();

  // eye
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(8, -5, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(10, -5, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // beak
  ctx.fillStyle = '#ff8c00';
  ctx.beginPath();
  ctx.moveTo(13, -1);
  ctx.lineTo(22, 1);
  ctx.lineTo(13, 5);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  ctx.restore();
}

// ============================================================
//  PIPES
// ============================================================
function spawnPipe() {
  const minTop = 60;
  const maxTop = VIEW_H - GROUND_HEIGHT - PIPE_GAP - 60;
  const topH = minTop + Math.random() * (maxTop - minTop);
  pipes.push({
    x: VIEW_W + 10,
    topH,
    bottomY: topH + PIPE_GAP,
    passed: false,
  });
}
function updatePipes(dt) {
  spawnTimer += dt;
  if (spawnTimer >= PIPE_INTERVAL) {
    spawnTimer = 0;
    spawnPipe();
  }
  for (let i = pipes.length - 1; i >= 0; i--) {
    const p = pipes[i];
    p.x -= PIPE_SPEED * dt;

    // score when bird passes the pipe center
    if (!p.passed && p.x + PIPE_WIDTH < BIRD_X) {
      p.passed = true;
      score++;
      scoreEl.textContent = score;
      sfx.score();
    }
    if (p.x + PIPE_WIDTH < -10) pipes.splice(i, 1);
  }
}
function drawPipes() {
  for (const p of pipes) {
    drawPipe(p.x, 0, PIPE_WIDTH, p.topH, true);             // top pipe (points down)
    drawPipe(p.x, p.bottomY, PIPE_WIDTH, VIEW_H - p.bottomY - GROUND_HEIGHT, false); // bottom
  }
}
function drawPipe(x, y, w, h, isTop) {
  // gradient body
  const grad = ctx.createLinearGradient(x, 0, x + w, 0);
  grad.addColorStop(0,   '#5aa02c');
  grad.addColorStop(0.3, '#8ed14f');
  grad.addColorStop(1,   '#4a8626');
  ctx.fillStyle = grad;
  ctx.fillRect(x, y, w, h);

  // outline
  ctx.strokeStyle = '#2e5e18';
  ctx.lineWidth = 2.5;
  ctx.strokeRect(x, y, w, h);

  // highlight stripe
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(x + 8, y, 6, h);

  // cap (lip)
  const capH = 26;
  const capY = isTop ? y + h - capH : y;
  const capX = x - 4;
  const capW = w + 8;
  ctx.fillStyle = grad;
  ctx.fillRect(capX, capY, capW, capH);
  ctx.strokeRect(capX, capY, capW, capH);
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(capX + 8, capY, 6, capH);
}

// ============================================================
//  BACKGROUND  (parallax clouds + ground)
// ============================================================
const clouds = [];
for (let i = 0; i < 4; i++) {
  clouds.push({ x: Math.random() * VIEW_W, y: 40 + Math.random() * 180, s: 0.5 + Math.random() * 0.7 });
}
function drawBackground(dt) {
  // sky
  const sky = ctx.createLinearGradient(0, 0, 0, VIEW_H - GROUND_HEIGHT);
  sky.addColorStop(0, '#4ec0ca');
  sky.addColorStop(1, '#71d1d8');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H - GROUND_HEIGHT);

  // clouds drift slowly (parallax)
  for (const c of clouds) {
    c.x -= 18 * c.s * dt;
    if (c.x < -60) { c.x = VIEW_W + 30; c.y = 40 + Math.random() * 180; }
    drawCloud(c.x, c.y, c.s);
  }
}
function drawCloud(x, y, s) {
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.arc(x, y, 18 * s, 0, Math.PI * 2);
  ctx.arc(x + 20 * s, y - 6 * s, 22 * s, 0, Math.PI * 2);
  ctx.arc(x + 42 * s, y, 18 * s, 0, Math.PI * 2);
  ctx.fill();
}

// animated ground stripes
let groundOffset = 0;
function drawGround(dt) {
  const gy = VIEW_H - GROUND_HEIGHT;
  // base
  ctx.fillStyle = '#ded895';
  ctx.fillRect(0, gy, VIEW_W, GROUND_HEIGHT);
  // top grass strip
  ctx.fillStyle = '#5ec857';
  ctx.fillRect(0, gy, VIEW_W, 14);
  ctx.fillStyle = '#3da537';
  ctx.fillRect(0, gy + 14, VIEW_W, 4);
  // moving dirt stripes
  groundOffset = (groundOffset + PIPE_SPEED * dt) % 24;
  ctx.fillStyle = '#caa86a';
  for (let x = -groundOffset; x < VIEW_W; x += 24) {
    ctx.fillRect(x, gy + 22, 12, GROUND_HEIGHT - 22);
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, gy); ctx.lineTo(VIEW_W, gy);
  ctx.stroke();
}

// ============================================================
//  COLLISION
// ============================================================
function checkCollision() {
  const r = BIRD_RADIUS * HITBOX_SCALE;
  const bl = BIRD_X - r, br = BIRD_X + r;
  const bt = bird.y - r,  bb = bird.y + r;

  // ground / ceiling
  if (bb >= VIEW_H - GROUND_HEIGHT) return true;
  if (bt <= 0) { bird.y = r; bird.vy = 0; }

  for (const p of pipes) {
    const pl = p.x, pr = p.x + PIPE_WIDTH;
    if (br > pl && bl < pr) {
      if (bt < p.topH || bb > p.bottomY) return true;
    }
  }
  return false;
}

// ============================================================
//  STATE TRANSITIONS
// ============================================================
function startGame() {
  ensureAudio();
  gameState = STATE.PLAYING;
  resetBird();
  pipes = [];
  score = 0;
  spawnTimer = PIPE_INTERVAL - 1.4;  // give the player time to settle before the first pipe
  scoreEl.textContent = '0';
  hud.style.display = 'block';
  overlay.classList.add('hidden');
}

function gameOver() {
  gameState = STATE.GAMEOVER;
  sfx.hit();
  if (score > best) {
    best = score;
    localStorage.setItem('floppyBest', String(best));
  }
  finalScore.textContent = score;
  bestScoreEl.textContent = best;
  // medal tiers
  medalEl.className = 'medal';
  if      (score >= 40) medalEl.classList.add('plat');
  else if (score >= 30) medalEl.classList.add('gold');
  else if (score >= 20) medalEl.classList.add('silver');
  else if (score >= 10) medalEl.classList.add('bronze');

  startScreen.style.display = 'none';
  overScreen.style.display = 'block';
  hud.style.display = 'none';
  overlay.classList.remove('hidden');
}

function backToStart() {
  gameState = STATE.START;
  resetBird();
  bird.vy = 0;
  pipes = [];
  startScreen.style.display = 'block';
  overScreen.style.display = 'none';
  overlay.classList.remove('hidden');
  hud.style.display = 'none';
}

// ============================================================
//  MAIN LOOP  (delta-time based)
// ============================================================
function loop(timestamp) {
  if (!lastTime) lastTime = timestamp;
  let dt = (timestamp - lastTime) / 1000;
  lastTime = timestamp;
  dt = Math.min(dt, 0.05);   // clamp to avoid huge jumps after tab switch

  drawBackground(dt);

  if (gameState === STATE.START) {
    // idle bobbing bird
    elapsed += dt;
    bird.y = VIEW_H * 0.45 + Math.sin(elapsed * 3) * 12;
    bird.rot = Math.sin(elapsed * 3) * 0.1;
    bird.flapAnim = (Math.sin(elapsed * 6) > 0) ? 0.1 : 0;
    drawPipes();
    drawBird();
  } else if (gameState === STATE.PLAYING) {
    updateBird(dt);
    updatePipes(dt);
    drawPipes();
    drawBird();
    if (checkCollision()) gameOver();
  } else if (gameState === STATE.GAMEOVER) {
    // bird falls to ground
    bird.vy += GRAVITY * dt;
    bird.y  += bird.vy * dt;
    bird.rot += (Math.PI / 2 - bird.rot) * 0.1;
    if (bird.y > VIEW_H - GROUND_HEIGHT - BIRD_RADIUS) {
      bird.y = VIEW_H - GROUND_HEIGHT - BIRD_RADIUS;
      bird.vy = 0;
    }
    drawPipes();
    drawBird();
  }

  drawGround(dt);
  requestAnimationFrame(loop);
}

// ============================================================
//  INPUT
// ============================================================
function handleInput(e) {
  // ignore clicks on the overlay's PLAY/RETRY buttons — they have their own handlers
  if (e && e.target && e.target.classList && e.target.classList.contains('play-btn')) return;

  if (gameState === STATE.START) {
    startGame();
    flap();
  } else if (gameState === STATE.PLAYING) {
    flap();
  }
  // GAMEOVER: only the RETRY button restarts (avoids accidental instant restart)
}

// keyboard
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' || e.code === 'ArrowUp' || e.code === 'KeyW') {
    e.preventDefault();
    handleInput();
  }
});
// mouse / touch on canvas
canvas.addEventListener('mousedown', handleInput);
canvas.addEventListener('touchstart', (e) => { e.preventDefault(); handleInput(); }, { passive: false });

// play / retry buttons AND overlay screens (entire start/gameover screen is clickable)
function onPlayClick(e) {
  e.stopPropagation();
  if (gameState === STATE.GAMEOVER || gameState === STATE.START) {
    startGame();
    flap();
  }
}
document.querySelectorAll('.play-btn').forEach(btn => btn.addEventListener('click', onPlayClick));
startScreen.addEventListener('click', onPlayClick);
overScreen.addEventListener('click', onPlayClick);

// ============================================================
//  BOOT
// ============================================================
resetBird();
pipes = [];
score = 0;
spawnTimer = 0;
elapsed = 0;
lastTime = 0;
requestAnimationFrame(loop);
