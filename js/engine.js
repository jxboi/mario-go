/**
 * Go rules engine — board state, group/liberty logic, captures, ko,
 * and the editable game record with navigation frames.
 *
 * No DOM access here; this module is pure logic so it can be tested
 * and reused independently of the UI.
 */

export const EMPTY = 0;
export const BLACK = 1;
export const WHITE = 2;

export const opposite = (color) => (color === BLACK ? WHITE : BLACK);

export const BOARD_SIZES = [9, 13, 19];

export const STAR_POINTS = {
  9: [[2, 2], [6, 2], [4, 4], [2, 6], [6, 6]],
  13: [[3, 3], [9, 3], [6, 6], [3, 9], [9, 9]],
  19: [
    [3, 3], [9, 3], [15, 3],
    [3, 9], [9, 9], [15, 9],
    [3, 15], [9, 15], [15, 15],
  ],
};

export class Board {
  constructor(size, grid) {
    this.size = size;
    this.grid = grid ? grid.slice() : new Uint8Array(size * size);
  }

  idx(x, y) {
    return y * this.size + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.size && y < this.size;
  }

  get(x, y) {
    return this.grid[this.idx(x, y)];
  }

  set(x, y, value) {
    this.grid[this.idx(x, y)] = value;
  }

  clone() {
    return new Board(this.size, this.grid);
  }

  hash() {
    let h = '';
    for (let i = 0; i < this.grid.length; i++) h += this.grid[i];
    return h;
  }

  neighbors(x, y) {
    const out = [];
    if (x > 0) out.push([x - 1, y]);
    if (x < this.size - 1) out.push([x + 1, y]);
    if (y > 0) out.push([x, y - 1]);
    if (y < this.size - 1) out.push([x, y + 1]);
    return out;
  }

  /** Flood-fill the group at (x, y). Returns its stones and liberty count. */
  group(x, y) {
    const color = this.get(x, y);
    const stones = [];
    const liberties = new Set();
    const seen = new Set();
    const stack = [[x, y]];
    seen.add(this.idx(x, y));
    while (stack.length) {
      const [cx, cy] = stack.pop();
      stones.push({ x: cx, y: cy });
      for (const [nx, ny] of this.neighbors(cx, cy)) {
        const v = this.get(nx, ny);
        const key = this.idx(nx, ny);
        if (v === EMPTY) {
          liberties.add(key);
        } else if (v === color && !seen.has(key)) {
          seen.add(key);
          stack.push([nx, ny]);
        }
      }
    }
    return { color, stones, liberties };
  }
}

/**
 * Validate a stone placement against a board position.
 * Does not mutate `board`. `previousHashes` is the set/array of board
 * hashes seen earlier in the game (for ko / repetition checks).
 *
 * Returns { legal, reason?, board?, captures?, hash? }.
 */
export function computePlacement(board, color, x, y, previousHashes = []) {
  if (!board.inBounds(x, y)) return { legal: false, reason: 'out of bounds' };
  if (board.get(x, y) !== EMPTY) return { legal: false, reason: 'occupied' };

  const next = board.clone();
  next.set(x, y, color);

  const enemy = opposite(color);
  const captures = [];
  for (const [nx, ny] of next.neighbors(x, y)) {
    if (next.get(nx, ny) !== enemy) continue;
    const g = next.group(nx, ny);
    if (g.liberties.size === 0) {
      for (const s of g.stones) {
        if (next.get(s.x, s.y) !== EMPTY) {
          next.set(s.x, s.y, EMPTY);
          captures.push({ x: s.x, y: s.y, color: enemy });
        }
      }
    }
  }

  if (next.group(x, y).liberties.size === 0) {
    return { legal: false, reason: 'suicide' };
  }

  const hash = next.hash();
  if (previousHashes.includes(hash)) {
    return { legal: false, reason: 'ko' };
  }

  return { legal: true, board: next, captures, hash };
}

export const MOVE_TAGS = [
  'mistake', 'good move', 'fight', 'capture',
  'opening', 'endgame', 'review later',
];

let idCounter = 0;
export function generateId() {
  idCounter += 1;
  return `g${Date.now().toString(36)}${idCounter.toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** Create a fresh game record. */
export function createGame(meta = {}) {
  const now = new Date();
  return {
    id: meta.id || generateId(),
    size: meta.size || 19,
    playerBlack: meta.playerBlack || '',
    playerWhite: meta.playerWhite || '',
    blackRank: meta.blackRank || '',
    whiteRank: meta.whiteRank || '',
    komi: meta.komi != null ? meta.komi : 6.5,
    date: meta.date || now.toISOString().slice(0, 10),
    location: meta.location || '',
    result: meta.result || '',
    notes: meta.notes || '',
    thoughts: meta.thoughts || '',
    reviewLater: !!meta.reviewLater,
    /** moves: { pass?, color, x?, y?, note?, tags?, bookmarked? } */
    moves: Array.isArray(meta.moves) ? meta.moves : [],
    createdAt: meta.createdAt || now.toISOString(),
    updatedAt: meta.updatedAt || now.toISOString(),
  };
}

/**
 * Navigator over a game record. Replays the move list into per-move
 * snapshot "frames" so jumping anywhere is O(1), and re-validates the
 * whole record after any edit (dropping moves that became illegal).
 */
export class Navigator {
  constructor(game) {
    this.game = game;
    this.index = 0; // number of moves currently applied (0..moves.length)
    this.redoStack = [];
    this.rebuild();
  }

  /** Replay game.moves from scratch; drops moves that are illegal. */
  rebuild() {
    const size = this.game.size;
    let board = new Board(size);
    const hashes = [board.hash()];
    const frames = [{
      grid: board.grid.slice(),
      capturedByBlack: 0,
      capturedByWhite: 0,
      lastMove: null,
      captures: [],
    }];
    const validMoves = [];
    let dropped = 0;
    let capturedByBlack = 0;
    let capturedByWhite = 0;

    for (const move of this.game.moves) {
      if (move.pass) {
        validMoves.push(move);
        frames.push({
          grid: board.grid.slice(),
          capturedByBlack,
          capturedByWhite,
          lastMove: move,
          captures: [],
        });
        continue;
      }
      const result = computePlacement(board, move.color, move.x, move.y, hashes);
      if (!result.legal) {
        dropped += 1;
        continue;
      }
      board = result.board;
      hashes.push(result.hash);
      if (move.color === BLACK) capturedByBlack += result.captures.length;
      else capturedByWhite += result.captures.length;
      validMoves.push(move);
      frames.push({
        grid: board.grid.slice(),
        capturedByBlack,
        capturedByWhite,
        lastMove: move,
        captures: result.captures,
      });
    }

    this.game.moves = validMoves;
    this.frames = frames;
    this.hashes = hashes;
    this.index = Math.min(this.index, validMoves.length);
    return dropped;
  }

  get moveCount() {
    return this.game.moves.length;
  }

  get atEnd() {
    return this.index === this.moveCount;
  }

  frame() {
    return this.frames[this.index];
  }

  board() {
    return new Board(this.game.size, this.frames[this.index].grid);
  }

  /** Move currently shown as "last played" (null at index 0). */
  currentMove() {
    return this.index > 0 ? this.game.moves[this.index - 1] : null;
  }

  /** Color whose turn it is at the current index (alternating). */
  nextColor() {
    if (this.index === 0) return BLACK;
    return opposite(this.game.moves[this.index - 1].color);
  }

  goTo(index) {
    this.index = Math.max(0, Math.min(index, this.moveCount));
    return this.frame();
  }

  /**
   * Validate a placement at the current index without committing it.
   * Returns the computePlacement result.
   */
  tryPlacement(color, x, y) {
    const board = this.board();
    // ko/repetition: only positions up to the current index matter
    const priorHashes = this.passAwareHashes();
    return computePlacement(board, color, x, y, priorHashes);
  }

  /** Board hashes for positions reached by placements up to this.index. */
  passAwareHashes() {
    // this.hashes has one entry per placement (plus the empty board);
    // recompute the prefix that corresponds to the first `index` moves.
    let placements = 0;
    for (let i = 0; i < this.index; i++) {
      if (!this.game.moves[i].pass) placements += 1;
    }
    return this.hashes.slice(0, placements + 1);
  }

  /**
   * Play a stone at the current index. If not at the end of the record,
   * the remaining moves are truncated (caller should confirm first).
   * Returns { ok, reason?, move?, captures? }.
   */
  play(color, x, y) {
    const result = this.tryPlacement(color, x, y);
    if (!result.legal) return { ok: false, reason: result.reason };
    if (!this.atEnd) this.truncateToIndex();
    const move = { color, x, y, tags: [], note: '', bookmarked: false };
    this.game.moves.push(move);
    this.redoStack = [];
    this.appendFrame(move, result);
    this.index = this.moveCount;
    return { ok: true, move, captures: result.captures };
  }

  pass(color) {
    if (!this.atEnd) this.truncateToIndex();
    const move = { pass: true, color, tags: [], note: '', bookmarked: false };
    this.game.moves.push(move);
    this.redoStack = [];
    const prev = this.frames[this.frames.length - 1];
    this.frames.push({
      grid: prev.grid.slice(),
      capturedByBlack: prev.capturedByBlack,
      capturedByWhite: prev.capturedByWhite,
      lastMove: move,
      captures: [],
    });
    this.index = this.moveCount;
    return { ok: true, move };
  }

  appendFrame(move, result) {
    const prev = this.frames[this.frames.length - 1];
    this.hashes.push(result.hash);
    this.frames.push({
      grid: result.board.grid.slice(),
      capturedByBlack: prev.capturedByBlack + (move.color === BLACK ? result.captures.length : 0),
      capturedByWhite: prev.capturedByWhite + (move.color === WHITE ? result.captures.length : 0),
      lastMove: move,
      captures: result.captures,
    });
  }

  truncateToIndex() {
    this.game.moves.length = this.index;
    this.frames.length = this.index + 1;
    let placements = 0;
    for (const m of this.game.moves) if (!m.pass) placements += 1;
    this.hashes.length = placements + 1;
    this.redoStack = [];
  }

  /** Undo: remove the last move (it can be redone). */
  undo() {
    if (this.moveCount === 0) return null;
    const move = this.game.moves[this.moveCount - 1];
    this.redoStack.push(move);
    this.game.moves.length = this.moveCount - 1;
    this.frames.length = this.game.moves.length + 1;
    if (!move.pass) this.hashes.length -= 1;
    this.index = Math.min(this.index, this.moveCount);
    return move;
  }

  redo() {
    if (this.redoStack.length === 0) return null;
    const move = this.redoStack.pop();
    if (move.pass) {
      const prev = this.frames[this.frames.length - 1];
      this.game.moves.push(move);
      this.frames.push({
        grid: prev.grid.slice(),
        capturedByBlack: prev.capturedByBlack,
        capturedByWhite: prev.capturedByWhite,
        lastMove: move,
        captures: [],
      });
    } else {
      const board = new Board(this.game.size, this.frames[this.frames.length - 1].grid);
      const result = computePlacement(board, move.color, move.x, move.y, this.hashes);
      if (!result.legal) return null;
      this.game.moves.push(move);
      this.appendFrame(move, result);
    }
    this.index = this.moveCount;
    return move;
  }

  /**
   * Delete the move at position `moveIndex` (0-based). The rest of the
   * record is re-validated; any later moves that become illegal are
   * dropped. Returns the number of additional moves dropped.
   */
  deleteMove(moveIndex) {
    if (moveIndex < 0 || moveIndex >= this.moveCount) return 0;
    this.game.moves.splice(moveIndex, 1);
    this.redoStack = [];
    const before = this.game.moves.length;
    this.rebuild();
    this.index = Math.min(moveIndex, this.moveCount);
    return before - this.game.moves.length;
  }
}

/** Final position summary used for thumbnails and the library list. */
export function finalFrame(game) {
  const nav = new Navigator(game);
  nav.goTo(nav.moveCount);
  return nav.frame();
}

/** Moves that the player marked as worth revisiting. */
export function keyMoments(game) {
  const out = [];
  game.moves.forEach((move, i) => {
    const tagged = move.tags && move.tags.length > 0;
    if (move.bookmarked || tagged || (move.note && move.note.trim())) {
      out.push({ move, number: i + 1 });
    }
  });
  return out;
}

export function hasReviewLater(game) {
  return game.reviewLater
    || game.moves.some((m) => m.tags && m.tags.includes('review later'));
}
