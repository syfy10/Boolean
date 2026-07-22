const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
const scoreEl = document.getElementById('score');
const highScoreEl = document.getElementById('high-score');
const messageEl = document.getElementById('message');

const GRID = 20;
const COLS = canvas.width / GRID;
const ROWS = canvas.height / GRID;
const TICK_MS = 110;

let snake, dir, nextDir, food, score, highScore, alive, loopId, started;

highScore = parseInt(localStorage.getItem('snake_high') || '0', 10);
highScoreEl.textContent = highScore;

function reset() {
  const cx = Math.floor(COLS / 2);
  const cy = Math.floor(ROWS / 2);
  snake = [{ x: cx, y: cy }, { x: cx - 1, y: cy }, { x: cx - 2, y: cy }];
  dir = { x: 1, y: 0 };
  nextDir = { ...dir };
  score = 0;
  scoreEl.textContent = 0;
  alive = true;
  placeFood();
}

function placeFood() {
  let pos;
  do {
    pos = { x: Math.floor(Math.random() * COLS), y: Math.floor(Math.random() * ROWS) };
  } while (snake.some(s => s.x === pos.x && s.y === pos.y));
  food = pos;
}

function step() {
  dir = { ...nextDir };
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };

  // wall collision
  if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) return die();
  // self collision
  if (snake.some(s => s.x === head.x && s.y === head.y)) return die();

  snake.unshift(head);

  if (head.x === food.x && head.y === food.y) {
    score++;
    scoreEl.textContent = score;
    if (score > highScore) {
      highScore = score;
      highScoreEl.textContent = highScore;
      localStorage.setItem('snake_high', highScore);
    }
    placeFood();
  } else {
    snake.pop();
  }
}

function die() {
  alive = false;
  clearInterval(loopId);
  loopId = null;
  messageEl.innerHTML = 'Game Over! Score: <strong>' + score + '</strong> — Press <strong>Space</strong> or <strong>Tap</strong> to restart';
  draw();
}

function draw() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // grid lines (subtle)
  ctx.strokeStyle = '#1a2744';
  ctx.lineWidth = 0.5;
  for (let x = 0; x <= COLS; x++) {
    ctx.beginPath(); ctx.moveTo(x * GRID, 0); ctx.lineTo(x * GRID, canvas.height); ctx.stroke();
  }
  for (let y = 0; y <= ROWS; y++) {
    ctx.beginPath(); ctx.moveTo(0, y * GRID); ctx.lineTo(canvas.width, y * GRID); ctx.stroke();
  }

  // food
  ctx.fillStyle = '#e94560';
  ctx.shadowColor = '#e94560';
  ctx.shadowBlur = 8;
  ctx.beginPath();
  ctx.arc(food.x * GRID + GRID / 2, food.y * GRID + GRID / 2, GRID / 2 - 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowBlur = 0;

  // snake
  snake.forEach((seg, i) => {
    const brightness = Math.max(80, 255 - i * 12);
    ctx.fillStyle = i === 0 ? '#0f0' : `rgb(0,${brightness},0)`;
    const pad = i === 0 ? 1 : 2;
    ctx.fillRect(seg.x * GRID + pad, seg.y * GRID + pad, GRID - pad * 2, GRID - pad * 2);
  });
}

function start() {
  if (loopId) return;
  reset();
  started = true;
  messageEl.textContent = '';
  loopId = setInterval(() => { step(); draw(); }, TICK_MS);
  draw();
}

// --- Input ---

const OPPOSITE = { '1,0': '-1,0', '-1,0': '1,0', '0,1': '0,-1', '0,-1': '0,1' };

function setDir(x, y) {
  const key = `${x},${y}`;
  const curKey = `${dir.x},${dir.y}`;
  if (OPPOSITE[curKey] === key) return; // no 180°
  nextDir = { x, y };
}

document.addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); if (!alive || !started) start(); return; }
  if (!alive) return;
  switch (e.code) {
    case 'ArrowUp':    case 'KeyW': e.preventDefault(); setDir(0, -1); break;
    case 'ArrowDown':  case 'KeyS': e.preventDefault(); setDir(0, 1);  break;
    case 'ArrowLeft':  case 'KeyA': e.preventDefault(); setDir(-1, 0); break;
    case 'ArrowRight': case 'KeyD': e.preventDefault(); setDir(1, 0);  break;
  }
});

// Touch / tap to start, swipe to steer
let touchStart = null;
canvas.addEventListener('touchstart', e => {
  e.preventDefault();
  if (!alive || !started) { start(); return; }
  touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
}, { passive: false });

canvas.addEventListener('touchend', e => {
  if (!touchStart || !alive) { touchStart = null; return; }
  const dx = e.changedTouches[0].clientX - touchStart.x;
  const dy = e.changedTouches[0].clientY - touchStart.y;
  touchStart = null;
  if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
  if (Math.abs(dx) > Math.abs(dy)) setDir(dx > 0 ? 1 : -1, 0);
  else setDir(0, dy > 0 ? 1 : -1);
});

// On-screen buttons
document.getElementById('btn-up').addEventListener('click', () => { if (!alive && started) start(); else setDir(0, -1); });
document.getElementById('btn-down').addEventListener('click', () => { if (!alive && started) start(); else setDir(0, 1); });
document.getElementById('btn-left').addEventListener('click', () => { if (!alive && started) start(); else setDir(-1, 0); });
document.getElementById('btn-right').addEventListener('click', () => { if (!alive && started) start(); else setDir(1, 0); });

// Initial draw
reset();
draw();