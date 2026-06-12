/**
 * Go Journal — application controller.
 * Wires the engine, renderer, storage, sound and SGF modules to the UI.
 */

import {
  BLACK, WHITE, EMPTY, opposite,
  createGame, Navigator, finalFrame, keyMoments, hasReviewLater, MOVE_TAGS,
} from './engine.js';
import { BoardRenderer, drawThumbnail } from './board.js';
import { gameToSgf, sgfToGame } from './sgf.js';
import * as store from './storage.js';
import { SoundEngine } from './sound.js';
import { AmbientBackground } from './ambient.js';

const $ = (id) => document.getElementById(id);
const COL_LETTERS = 'ABCDEFGHJKLMNOPQRST';

const state = {
  games: store.loadGames(),
  settings: { sfx: true, ambientAudio: false, showNumbers: false, ...store.loadSettings() },
  game: null,
  nav: null,
  view: 'library',
  colorMode: 'auto',
  summaryReturn: 'library',
  replay: { playing: false, paused: false, speed: 1, timer: null },
};

const sound = new SoundEngine();
const ambient = new AmbientBackground($('ambient-canvas'));
const renderer = new BoardRenderer($('board-canvas'));

// ---------------------------------------------------------------- helpers

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

let toastTimer = null;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
}

function confirmDialog(message) {
  return new Promise((resolve) => {
    const dialog = $('dialog-confirm');
    $('confirm-text').textContent = message;
    const yes = $('btn-confirm-yes');
    const no = $('btn-confirm-no');
    const done = (value) => {
      yes.onclick = null;
      no.onclick = null;
      dialog.onclose = null;
      dialog.close();
      resolve(value);
    };
    yes.onclick = () => done(true);
    no.onclick = () => done(false);
    dialog.onclose = () => resolve(false);
    dialog.showModal();
  });
}

let persistTimer = null;
function persist(immediate = false) {
  if (!state.game) return;
  const write = () => { state.games = store.upsertGame(state.game); };
  clearTimeout(persistTimer);
  if (immediate) write();
  else persistTimer = setTimeout(write, 350);
}

function coordLabel(move) {
  if (!move || move.pass) return 'pass';
  return `${COL_LETTERS[move.x]}${state.game.size - move.y}`;
}

function colorName(color) {
  return color === BLACK ? 'Black' : 'White';
}

function escapeFilename(s) {
  return (s || '').replace(/[^\w一-鿿-]+/g, '_') || 'player';
}

// ---------------------------------------------------------------- views

function showView(name) {
  state.view = name;
  for (const id of ['view-library', 'view-editor', 'view-summary']) {
    $(id).hidden = id !== `view-${name}`;
  }
  renderer.setActive(name === 'editor');
  if (name === 'library') renderLibrary();
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------- library

function gameCard(game, compact = false) {
  const card = el('article', `game-card${compact ? ' compact' : ''}`);
  const thumb = el('canvas', 'card-thumb');
  card.appendChild(thumb);

  const body = el('div', 'card-body');
  const title = el('h3', 'card-title',
    `${game.playerBlack || 'Black'} vs ${game.playerWhite || 'White'}`);
  body.appendChild(title);

  const sub = el('p', 'card-sub',
    [game.date, game.location].filter(Boolean).join(' · ') || 'No date');
  body.appendChild(sub);

  const badges = el('div', 'card-badges');
  badges.appendChild(el('span', 'badge', `${game.size}×${game.size}`));
  badges.appendChild(el('span', 'badge', `${game.moves.length} moves`));
  if (game.result) badges.appendChild(el('span', 'badge result', game.result));
  const moments = keyMoments(game).length;
  if (moments) badges.appendChild(el('span', 'badge gold', `★ ${moments}`));
  if (hasReviewLater(game)) badges.appendChild(el('span', 'badge review', 'review later'));
  body.appendChild(badges);
  card.appendChild(body);

  const actions = el('div', 'card-actions');
  const mkBtn = (label, title, fn) => {
    const b = el('button', 'icon-btn', label);
    b.title = title;
    b.addEventListener('click', (e) => { e.stopPropagation(); fn(); });
    actions.appendChild(b);
  };
  mkBtn('📖', 'Game memory', () => { state.summaryReturn = 'library'; openSummary(game); });
  mkBtn('⬇', 'Export SGF', () => exportSgf(game));
  mkBtn('🗑', 'Delete game', async () => {
    const ok = await confirmDialog(
      `Delete "${game.playerBlack || 'Black'} vs ${game.playerWhite || 'White'}" forever?`);
    if (!ok) return;
    state.games = store.deleteGame(game.id);
    if (state.game && state.game.id === game.id) state.game = null;
    renderLibrary();
    toast('Game deleted');
  });
  card.appendChild(actions);

  card.addEventListener('click', () => openGame(game));
  card.tabIndex = 0;
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openGame(game);
  });

  requestAnimationFrame(() => {
    try {
      const frame = finalFrame(game);
      drawThumbnail(thumb, game.size, frame.grid);
    } catch (err) {
      console.error('thumbnail failed', err);
    }
  });
  return card;
}

function renderLibrary() {
  const games = [...state.games].sort(
    (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  const grid = $('games-grid');
  grid.replaceChildren();
  const reviewGrid = $('review-later-grid');
  reviewGrid.replaceChildren();

  const reviewGames = games.filter(hasReviewLater);
  $('review-later-section').hidden = reviewGames.length === 0;
  for (const g of reviewGames) reviewGrid.appendChild(gameCard(g, true));
  for (const g of games) grid.appendChild(gameCard(g));

  $('empty-state').hidden = games.length > 0;
  document.querySelector('.library-header').hidden = games.length === 0;
}

// ---------------------------------------------------------------- editor

function openGame(game, atIndex = null) {
  state.game = game;
  state.nav = new Navigator(game);
  state.nav.goTo(atIndex == null ? state.nav.moveCount : atIndex);
  state.colorMode = 'auto';
  renderer.setBoardSize(game.size);
  renderer.showNumbers = state.settings.showNumbers;
  $('btn-numbers').classList.toggle('on', state.settings.showNumbers);
  showView('editor');
  syncBoard(false);
  renderTimeline();
  renderMetaPanel();
  renderMoments();
}

function nextColor() {
  if (state.colorMode === 'black') return BLACK;
  if (state.colorMode === 'white') return WHITE;
  return state.nav.nextColor();
}

function buildMoveNumbers() {
  const map = new Map();
  for (let i = 0; i < state.nav.index; i++) {
    const m = state.game.moves[i];
    if (!m.pass) map.set(`${m.x},${m.y}`, i + 1);
  }
  return map;
}

function buildBookmarks() {
  const set = new Set();
  for (let i = 0; i < state.nav.index; i++) {
    const m = state.game.moves[i];
    if (!m.pass && m.bookmarked) set.add(`${m.x},${m.y}`);
  }
  return set;
}

function syncBoard(animate) {
  const { nav } = state;
  const frame = nav.frame();
  renderer.setPosition(frame.grid, frame.lastMove, { animate });
  renderer.setMoveNumbers(buildMoveNumbers());
  renderer.setBookmarks(buildBookmarks());
  renderer.setGhostColor(nextColor());

  $('move-counter').textContent = `${nav.index} / ${nav.moveCount}`;
  $('pb-captures').textContent = `captures ${frame.capturedByBlack}`;
  $('pw-captures').textContent = `captures ${frame.capturedByWhite}`;
  updateMovePanel();
  updateTimelineHighlight();
}

function updateMovePanel() {
  const { nav } = state;
  const move = nav.currentMove();
  const hasMove = !!move;
  $('move-title').textContent = hasMove
    ? `Move ${nav.index} · ${colorName(move.color)} ${coordLabel(move)}`
    : 'Game start';
  $('move-note').value = hasMove ? (move.note || '') : '';
  $('move-note').disabled = !hasMove;
  $('btn-bookmark').disabled = !hasMove;
  $('btn-bookmark').textContent = hasMove && move.bookmarked ? '★' : '☆';
  $('btn-bookmark').classList.toggle('gold', hasMove && !!move.bookmarked);
  $('btn-delete-move').disabled = !hasMove;

  const tagBox = $('move-tags');
  tagBox.replaceChildren();
  for (const tag of MOVE_TAGS) {
    const chip = el('button', 'tag-chip', tag);
    chip.type = 'button';
    chip.disabled = !hasMove;
    if (hasMove && move.tags && move.tags.includes(tag)) chip.classList.add('on');
    chip.addEventListener('click', () => {
      if (!move.tags) move.tags = [];
      const i = move.tags.indexOf(tag);
      if (i >= 0) move.tags.splice(i, 1);
      else move.tags.push(tag);
      chip.classList.toggle('on', i < 0);
      persist();
      renderTimeline();
      renderMoments();
      renderMetaPanel();
    });
    tagBox.appendChild(chip);
  }
}

function renderTimeline() {
  const box = $('timeline');
  box.replaceChildren();
  const start = el('button', 'tl-chip start', '◦');
  start.title = 'Game start';
  start.addEventListener('click', () => { state.nav.goTo(0); syncBoard(false); });
  box.appendChild(start);

  state.game.moves.forEach((move, i) => {
    const chip = el('button', `tl-chip ${move.color === BLACK ? 'black' : 'white'}`);
    chip.textContent = move.pass ? 'P' : String(i + 1);
    chip.title = `Move ${i + 1}: ${colorName(move.color)} ${coordLabel(move)}`
      + (move.note ? ` — ${move.note}` : '');
    if (move.bookmarked) chip.classList.add('starred');
    if (move.tags && move.tags.length) chip.classList.add('tagged');
    chip.addEventListener('click', () => {
      state.nav.goTo(i + 1);
      syncBoard(false);
    });
    box.appendChild(chip);
  });
  updateTimelineHighlight();
}

function updateTimelineHighlight() {
  const chips = $('timeline').children;
  for (let i = 0; i < chips.length; i++) {
    chips[i].classList.toggle('current', i === state.nav.index);
  }
  const current = chips[state.nav.index];
  if (current) {
    // scroll only the timeline strip — scrollIntoView would also scroll the page
    const box = $('timeline');
    box.scrollTo({
      left: current.offsetLeft - box.clientWidth / 2 + current.offsetWidth / 2,
      behavior: 'smooth',
    });
  }
}

function renderMetaPanel() {
  const g = state.game;
  $('meta-title').textContent =
    `${g.playerBlack || 'Black'} vs ${g.playerWhite || 'White'}`;
  $('pb-name').textContent = g.playerBlack || 'Black';
  $('pw-name').textContent = g.playerWhite || 'White';

  const rows = [
    ['Ranks', [g.blackRank, g.whiteRank].filter(Boolean).join(' / ')],
    ['Date', g.date],
    ['Place', g.location],
    ['Komi', String(g.komi)],
    ['Result', g.result || 'unfinished'],
    ['Notes', g.notes],
  ];
  const box = $('meta-summary');
  box.replaceChildren();
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-label', label));
    row.appendChild(el('span', 'meta-value', value));
    box.appendChild(row);
  }
  $('chk-review-later').checked = !!g.reviewLater;
}

function momentRow(moment, large = false) {
  const { move, number } = moment;
  const row = el('button', `moment-row${large ? ' large' : ''}`);
  const dot = el('span', `stone-dot small ${move.color === BLACK ? 'black' : 'white'}`);
  row.appendChild(dot);
  const text = el('div', 'moment-text');
  const headParts = [`Move ${number}`, coordLabel(move)];
  if (move.bookmarked) headParts.push('★');
  text.appendChild(el('div', 'moment-head', headParts.join(' · ')));
  if (move.tags && move.tags.length) {
    text.appendChild(el('div', 'moment-tags', move.tags.join(', ')));
  }
  if (move.note && move.note.trim()) {
    text.appendChild(el('div', 'moment-note', move.note.trim()));
  }
  row.appendChild(text);
  row.addEventListener('click', () => {
    if (state.view !== 'editor') {
      openGame(state.game, number);
    } else {
      state.nav.goTo(number);
      syncBoard(false);
    }
  });
  return row;
}

function renderMoments() {
  const list = $('moments-list');
  list.replaceChildren();
  const moments = keyMoments(state.game);
  if (moments.length === 0) {
    list.appendChild(el('p', 'muted',
      'Bookmark moves or add tags and notes — they will gather here.'));
    return;
  }
  for (const m of moments) list.appendChild(momentRow(m));
}

// ------------------------------------------------------------- gameplay

renderer.onPlay = async (x, y) => {
  if (state.replay.playing || !state.nav) return;
  const { nav } = state;
  if (!nav.atEnd) {
    const n = nav.moveCount - nav.index;
    const ok = await confirmDialog(
      `Place a stone here and discard the ${n} move${n > 1 ? 's' : ''} that come after this position?`);
    if (!ok) { renderer.clearPending(); return; }
  }
  const result = nav.play(nextColor(), x, y);
  if (!result.ok) {
    toast(`Illegal move (${result.reason})`);
    renderer.clearPending();
    return;
  }
  sound.stoneClick();
  if (result.captures.length) {
    setTimeout(() => sound.captureSwish(result.captures.length), 130);
  }
  persist();
  syncBoard(true);
  renderTimeline();
  renderMoments();
};

async function doPass() {
  const { nav } = state;
  if (!nav) return;
  if (!nav.atEnd) {
    const n = nav.moveCount - nav.index;
    const ok = await confirmDialog(
      `Pass here and discard the ${n} move${n > 1 ? 's' : ''} after this position?`);
    if (!ok) return;
  }
  nav.pass(nextColor());
  persist();
  syncBoard(false);
  renderTimeline();
  toast(`${colorName(nav.currentMove().color)} passes`);
}

function doUndo() {
  if (!state.nav || !state.nav.undo()) return;
  persist();
  syncBoard(true);
  renderTimeline();
  renderMoments();
}

function doRedo() {
  if (!state.nav || !state.nav.redo()) return;
  sound.stoneClick();
  persist();
  syncBoard(true);
  renderTimeline();
  renderMoments();
}

async function doDeleteMove() {
  const { nav } = state;
  if (!nav || nav.index === 0) return;
  const i = nav.index - 1;
  const ok = await confirmDialog(`Delete move ${i + 1} from the record?`);
  if (!ok) return;
  const dropped = nav.deleteMove(i);
  persist();
  syncBoard(false);
  renderTimeline();
  renderMoments();
  toast(dropped > 0
    ? `Move deleted (${dropped} later move${dropped > 1 ? 's' : ''} became illegal and were removed)`
    : 'Move deleted');
}

function step(delta, animate = true) {
  const { nav } = state;
  if (!nav) return;
  const target = nav.index + delta;
  if (target < 0 || target > nav.moveCount) return;
  nav.goTo(target);
  if (delta === 1) {
    const move = nav.currentMove();
    if (move && !move.pass) sound.stoneClick();
  }
  syncBoard(animate);
}

// ---------------------------------------------------------------- replay

function startReplay() {
  const { nav, replay } = state;
  if (!nav || nav.moveCount === 0) {
    toast('Nothing to replay yet — place some stones first.');
    return;
  }
  replay.playing = true;
  replay.paused = false;
  nav.goTo(0);
  syncBoard(false);
  document.body.classList.add('cinematic');
  $('replay-controls').hidden = false;
  $('btn-replay-pause').textContent = '⏸';
  scheduleReplayStep();
}

function scheduleReplayStep() {
  const { replay } = state;
  clearTimeout(replay.timer);
  replay.timer = setTimeout(replayStep, 1500 / replay.speed);
}

function replayStep() {
  const { nav, replay } = state;
  if (!replay.playing || replay.paused) return;
  if (nav.atEnd) {
    setTimeout(stopReplay, 1200);
    return;
  }
  nav.goTo(nav.index + 1);
  const move = nav.currentMove();
  syncBoard(true);
  if (move && !move.pass) sound.stoneClick();
  const frame = nav.frame();
  if (frame.captures.length) {
    setTimeout(() => sound.captureSwish(frame.captures.length), 130);
  }
  showReplayCaption(move);
  scheduleReplayStep();
}

function showReplayCaption(move) {
  const cap = $('replay-caption');
  if (move && (move.note || move.pass || (move.tags && move.tags.length))) {
    const parts = [`Move ${state.nav.index}`];
    if (move.pass) parts.push(`${colorName(move.color)} passes`);
    if (move.tags && move.tags.length) parts.push(move.tags.join(', '));
    if (move.note) parts.push(move.note);
    cap.textContent = parts.join(' — ');
    cap.hidden = false;
    cap.classList.remove('fade');
    void cap.offsetWidth; // restart the fade animation
    cap.classList.add('fade');
  } else {
    cap.hidden = true;
  }
}

function stopReplay() {
  const { replay } = state;
  if (!replay.playing) return;
  replay.playing = false;
  clearTimeout(replay.timer);
  document.body.classList.remove('cinematic');
  $('replay-controls').hidden = true;
  $('replay-caption').hidden = true;
}

function toggleReplayPause() {
  const { replay } = state;
  replay.paused = !replay.paused;
  $('btn-replay-pause').textContent = replay.paused ? '▶' : '⏸';
  if (!replay.paused) scheduleReplayStep();
  else clearTimeout(replay.timer);
}

// ---------------------------------------------------------------- summary

function openSummary(game) {
  state.game = game;
  if (!state.nav || state.nav.game !== game) state.nav = new Navigator(game);

  $('summary-versus').textContent =
    `${game.playerBlack || 'Black'}  vs  ${game.playerWhite || 'White'}`;
  const result = $('summary-result');
  result.textContent = game.result || 'Unfinished game';
  result.classList.toggle('unfinished', !game.result);

  const rows = [
    ['Date', game.date],
    ['Place', game.location],
    ['Board', `${game.size}×${game.size}`],
    ['Komi', String(game.komi)],
    ['Ranks', [game.blackRank, game.whiteRank].filter(Boolean).join(' / ')],
    ['Moves', String(game.moves.length)],
    ['Notes', game.notes],
  ];
  const meta = $('summary-meta');
  meta.replaceChildren();
  for (const [label, value] of rows) {
    if (!value) continue;
    const row = el('div', 'meta-row');
    row.appendChild(el('span', 'meta-label', label));
    row.appendChild(el('span', 'meta-value', value));
    meta.appendChild(row);
  }

  const frame = finalFrame(game);
  $('summary-captures').textContent =
    `Black captured ${frame.capturedByBlack} · White captured ${frame.capturedByWhite}`;
  $('summary-thoughts').value = game.thoughts || '';

  const list = $('summary-moments');
  list.replaceChildren();
  const moments = keyMoments(game);
  if (moments.length === 0) {
    list.appendChild(el('p', 'muted',
      'No key moments marked yet. Open the game and bookmark or tag the moves that mattered.'));
  } else {
    for (const m of moments) list.appendChild(momentRow(m, true));
  }

  showView('summary');
  requestAnimationFrame(() => drawThumbnail($('summary-thumb'), game.size, frame.grid));
}

// ------------------------------------------------------------ game form

let editingGame = null;

function openGameForm(game) {
  editingGame = game;
  const form = $('game-form');
  form.reset();
  $('game-form-title').textContent = game ? 'Edit game details' : 'New game';
  const sizeInputs = form.elements.size;
  for (const input of sizeInputs) {
    input.disabled = !!(game && game.moves.length > 0);
    input.checked = input.value === String(game ? game.size : 19);
  }
  if (game) {
    form.elements.playerBlack.value = game.playerBlack;
    form.elements.blackRank.value = game.blackRank;
    form.elements.playerWhite.value = game.playerWhite;
    form.elements.whiteRank.value = game.whiteRank;
    form.elements.date.value = game.date;
    form.elements.komi.value = game.komi;
    form.elements.location.value = game.location;
    form.elements.result.value = game.result;
    form.elements.notes.value = game.notes;
  } else {
    form.elements.date.value = new Date().toISOString().slice(0, 10);
    form.elements.komi.value = 6.5;
  }
  $('dialog-game').showModal();
}

function submitGameForm() {
  const form = $('game-form');
  const data = {
    size: parseInt(form.elements.size.value, 10) || 19,
    playerBlack: form.elements.playerBlack.value.trim(),
    blackRank: form.elements.blackRank.value.trim(),
    playerWhite: form.elements.playerWhite.value.trim(),
    whiteRank: form.elements.whiteRank.value.trim(),
    date: form.elements.date.value,
    komi: parseFloat(form.elements.komi.value),
    location: form.elements.location.value.trim(),
    result: form.elements.result.value.trim(),
    notes: form.elements.notes.value.trim(),
  };
  if (Number.isNaN(data.komi)) data.komi = 6.5;

  if (editingGame) {
    Object.assign(editingGame, data, { size: editingGame.moves.length ? editingGame.size : data.size });
    state.games = store.upsertGame(editingGame);
    if (state.view === 'editor' && state.game === editingGame) {
      if (state.nav.game.size !== renderer.boardSize) renderer.setBoardSize(editingGame.size);
      renderMetaPanel();
    } else {
      renderLibrary();
    }
    toast('Game details saved');
  } else {
    const game = createGame(data);
    state.games = store.upsertGame(game);
    openGame(game);
    toast('New game created — tap the board to place the first stone');
  }
  editingGame = null;
}

// ------------------------------------------------------------ SGF I/O

function exportSgf(game) {
  const sgf = gameToSgf(game);
  const blob = new Blob([sgf], { type: 'application/x-go-sgf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${escapeFilename(game.playerBlack)}-vs-${escapeFilename(game.playerWhite)}-${game.date || 'game'}.sgf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('SGF exported');
}

function importSgfFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const game = sgfToGame(String(reader.result));
      state.games = store.upsertGame(game);
      openGame(game);
      toast(`Imported ${game.moves.length} moves`);
    } catch (err) {
      console.error(err);
      toast(`Could not import SGF: ${err.message}`);
    }
  };
  reader.readAsText(file);
}

// ---------------------------------------------------------------- wiring

function applySoundButtons() {
  $('btn-sfx').classList.toggle('off', !state.settings.sfx);
  $('btn-ambient-audio').classList.toggle('off', !state.settings.ambientAudio);
}

function bindEvents() {
  $('brand').addEventListener('click', () => { stopReplay(); showView('library'); });
  $('btn-new-game').addEventListener('click', () => openGameForm(null));
  $('btn-empty-new').addEventListener('click', () => openGameForm(null));
  $('btn-import').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) importSgfFile(file);
    e.target.value = '';
  });

  $('btn-sfx').addEventListener('click', () => {
    state.settings.sfx = !state.settings.sfx;
    sound.setSfx(state.settings.sfx);
    store.saveSettings(state.settings);
    applySoundButtons();
    if (state.settings.sfx) sound.stoneClick();
  });
  $('btn-ambient-audio').addEventListener('click', () => {
    state.settings.ambientAudio = !state.settings.ambientAudio;
    sound.setAmbient(state.settings.ambientAudio);
    store.saveSettings(state.settings);
    applySoundButtons();
  });

  // editor controls
  $('btn-first').addEventListener('click', () => { state.nav.goTo(0); syncBoard(false); });
  $('btn-last').addEventListener('click', () => { state.nav.goTo(state.nav.moveCount); syncBoard(false); });
  $('btn-prev').addEventListener('click', () => step(-1));
  $('btn-next').addEventListener('click', () => step(1));
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-redo').addEventListener('click', doRedo);
  $('btn-pass').addEventListener('click', doPass);
  $('btn-replay').addEventListener('click', startReplay);
  $('btn-replay-exit').addEventListener('click', stopReplay);
  $('btn-replay-pause').addEventListener('click', toggleReplayPause);
  $('btn-replay-speed').addEventListener('click', () => {
    const speeds = [0.5, 1, 1.5, 2];
    const i = speeds.indexOf(state.replay.speed);
    state.replay.speed = speeds[(i + 1) % speeds.length];
    $('btn-replay-speed').textContent = `${state.replay.speed}×`;
    if (state.replay.playing && !state.replay.paused) scheduleReplayStep();
  });

  $('btn-numbers').addEventListener('click', () => {
    state.settings.showNumbers = !state.settings.showNumbers;
    renderer.showNumbers = state.settings.showNumbers;
    $('btn-numbers').classList.toggle('on', state.settings.showNumbers);
    store.saveSettings(state.settings);
    renderer.draw();
  });

  for (const btn of document.querySelectorAll('.mode-btn')) {
    btn.addEventListener('click', () => {
      state.colorMode = btn.dataset.mode;
      document.querySelectorAll('.mode-btn').forEach((b) => b.classList.toggle('selected', b === btn));
      renderer.setGhostColor(nextColor());
    });
  }

  $('btn-bookmark').addEventListener('click', () => {
    const move = state.nav && state.nav.currentMove();
    if (!move) return;
    move.bookmarked = !move.bookmarked;
    persist();
    syncBoard(false);
    renderTimeline();
    renderMoments();
  });

  $('move-note').addEventListener('input', () => {
    const move = state.nav && state.nav.currentMove();
    if (!move) return;
    move.note = $('move-note').value;
    persist();
  });
  $('move-note').addEventListener('change', () => { renderMoments(); renderTimeline(); });

  $('btn-delete-move').addEventListener('click', doDeleteMove);
  $('chk-review-later').addEventListener('change', (e) => {
    state.game.reviewLater = e.target.checked;
    persist();
  });

  $('btn-edit-meta').addEventListener('click', () => openGameForm(state.game));
  $('btn-export').addEventListener('click', () => exportSgf(state.game));
  $('btn-back-library').addEventListener('click', () => { stopReplay(); persist(true); showView('library'); });
  $('btn-summary').addEventListener('click', () => {
    state.summaryReturn = 'editor';
    persist(true);
    openSummary(state.game);
  });
  $('btn-summary-back').addEventListener('click', () => {
    if (state.summaryReturn === 'editor' && state.game) showView('editor');
    else showView('library');
  });
  $('btn-summary-open').addEventListener('click', () => openGame(state.game));
  $('summary-thoughts').addEventListener('input', () => {
    state.game.thoughts = $('summary-thoughts').value;
    persist();
  });

  // game form dialog
  $('game-form').addEventListener('submit', submitGameForm);
  $('btn-form-cancel').addEventListener('click', () => {
    editingGame = null;
    $('dialog-game').close();
  });
  for (const btn of document.querySelectorAll('.result-quick button')) {
    btn.addEventListener('click', () => {
      $('result-input').value = btn.dataset.result;
      if (btn.dataset.result.endsWith('+')) $('result-input').focus();
    });
  }

  // keyboard shortcuts (editor only, not while typing)
  document.addEventListener('keydown', (e) => {
    if (state.view !== 'editor' || !state.nav) return;
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if ($('dialog-game').open || $('dialog-confirm').open) return;

    if (e.key === 'Escape' && state.replay.playing) { stopReplay(); return; }
    if (e.key === ' ') {
      e.preventDefault();
      if (state.replay.playing) toggleReplayPause();
      else startReplay();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); doUndo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); doRedo(); return; }
    switch (e.key) {
      case 'ArrowLeft': step(-1); break;
      case 'ArrowRight': step(1); break;
      case 'Home': state.nav.goTo(0); syncBoard(false); break;
      case 'End': state.nav.goTo(state.nav.moveCount); syncBoard(false); break;
      case 'p': case 'P': doPass(); break;
      case 'n': case 'N': $('btn-numbers').click(); break;
      case 'b': case 'B': $('btn-bookmark').click(); break;
      default: break;
    }
  });

  // resume the AudioContext on first interaction (autoplay policies)
  const resumeAudio = () => {
    if (state.settings.ambientAudio) sound.setAmbient(true);
    document.removeEventListener('pointerdown', resumeAudio);
  };
  document.addEventListener('pointerdown', resumeAudio);
}

// ---------------------------------------------------------------- init

function init() {
  sound.setSfx(state.settings.sfx);
  applySoundButtons();
  bindEvents();
  ambient.start();
  renderLibrary();
  showView('library');
}

init();
