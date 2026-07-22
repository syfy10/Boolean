const DIFFICULTIES = {
  easy:   { pairs: 8,  cols: 4, emojis: ['🐶','🐱','🦊','🐼','🦁','🐸','🐵','🐧'] },
  medium: { pairs: 12, cols: 4, emojis: ['🐶','🐱','🦊','🐼','🦁','🐸','🐵','🐧','🦄','🐯','🐨','🐙'] },
  hard:   { pairs: 18, cols: 6, emojis: ['🐶','🐱','🦊','🐼','🦁','🐸','🐵','🐧','🦄','🐯','🐨','🐙','🦉','🐷','🦝','🐰','🐻','🦓'] },
};

let currentLevel = 'easy';
let cards = [];
let flipped = [];
let matched = 0;
let moves = 0;
let lock = false;
let timer = 0;
let timerInterval = null;
let started = false;

const board = document.getElementById('board');
const timerEl = document.getElementById('timer');
const movesEl = document.getElementById('moves');
const pairsEl = document.getElementById('pairs');
const winBanner = document.getElementById('winBanner');
const winStats = document.getElementById('winStats');

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function startGame() {
  clearInterval(timerInterval);
  timer = 0; moves = 0; matched = 0; flipped = []; lock = false; started = false;
  timerEl.textContent = '0';
  movesEl.textContent = '0';
  pairsEl.textContent = '0';
  winBanner.classList.add('hidden');
  board.innerHTML = '';

  const cfg = DIFFICULTIES[currentLevel];
  document.getElementById('totalPairs').textContent = cfg.pairs;

  // Update board grid columns for difficulty
  board.className = 'board ' + currentLevel;

  cards = shuffle([...cfg.emojis, ...cfg.emojis]);

  cards.forEach((emoji, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.dataset.emoji = emoji;
    card.dataset.index = i;
    card.innerHTML =
      '<div class="card-inner">' +
        '<div class="card-face card-front">❓</div>' +
        '<div class="card-face card-back">' + emoji + '</div>' +
      '</div>';
    card.addEventListener('click', () => flipCard(card));
    board.appendChild(card);
  });
}

function startTimer() {
  if (started) return;
  started = true;
  timerInterval = setInterval(() => {
    timer++;
    timerEl.textContent = timer;
  }, 1000);
}

function flipCard(card) {
  if (lock || card.classList.contains('flipped') || card.classList.contains('matched')) return;
  startTimer();

  card.classList.add('flipped');
  flipped.push(card);

  if (flipped.length === 2) {
    moves++;
    movesEl.textContent = moves;
    checkMatch();
  }
}

function checkMatch() {
  lock = true;
  const [a, b] = flipped;

  if (a.dataset.emoji === b.dataset.emoji) {
    setTimeout(() => {
      a.classList.add('matched');
      b.classList.add('matched');
      a.classList.remove('flipped');
      b.classList.remove('flipped');
      matched++;
      pairsEl.textContent = matched;
      flipped = [];
      lock = false;
      if (matched === DIFFICULTIES[currentLevel].pairs) win();
    }, 400);
  } else {
    a.classList.add('shake');
    b.classList.add('shake');
    setTimeout(() => {
      a.classList.remove('flipped', 'shake');
      b.classList.remove('flipped', 'shake');
      flipped = [];
      lock = false;
    }, 800);
  }
}

function win() {
  clearInterval(timerInterval);
  const bestKey = 'mm_best_' + currentLevel;
  let best = parseInt(localStorage.getItem(bestKey) || '999999');
  let newBest = '';
  if (moves < best) {
    localStorage.setItem(bestKey, moves);
    best = moves;
    newBest = ' 🌟 New best!';
  }
  winStats.textContent = `Time: ${timer}s · Moves: ${moves} · Best: ${best} moves${newBest}`;
  winBanner.classList.remove('hidden');
}

// Difficulty selector
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentLevel = btn.dataset.level;
    startGame();
  });
});

document.getElementById('restart').addEventListener('click', startGame);
startGame();
