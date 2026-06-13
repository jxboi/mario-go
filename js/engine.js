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

/**
 * A game record is a tree of variations. Each node holds one move and a
 * list of child continuations; `children[0]` is the "main line". The root
 * node carries no move (it represents the empty board).
 *   node: { id, move, children: [] }
 */
export function createNode(move = null) {
  return { id: generateId(), move, children: [] };
}

/** Build a linear tree (root → child → …) from a flat move list. */
export function movesToTree(moves) {
  const root = createNode(null);
  let cur = root;
  for (const move of (moves || [])) {
    const node = createNode(move);
    cur.children.push(node);
    cur = node;
  }
  return root;
}

/** The main line (following children[0]) as a flat list of moves. */
export function mainlineMoves(root) {
  const out = [];
  let n = root;
  while (n && n.children && n.children.length) {
    n = n.children[0];
    out.push(n.move);
  }
  return out;
}

/** Create a fresh game record. */
export function createGame(meta = {}) {
  const now = new Date();
  // The tree is the source of truth; `moves` is a derived mirror of the
  // main line kept for the many read-only consumers (cards, summary, SGF).
  const tree = (meta.tree && Array.isArray(meta.tree.children))
    ? meta.tree
    : movesToTree(meta.moves);
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
    /** move: { pass?, color, x?, y?, note?, tags?, bookmarked? } */
    tree,
    /** derived main line of `tree` */
    moves: mainlineMoves(tree),
    createdAt: meta.createdAt || now.toISOString(),
    updatedAt: meta.updatedAt || now.toISOString(),
  };
}

/**
 * Navigator over a game record's variation tree. Tracks the "active line"
 * (a path of nodes from the root to a leaf) and replays it into per-move
 * snapshot "frames" so jumping anywhere is O(1). Playing a move that
 * differs from the existing continuation creates a new branch beside it
 * rather than discarding the old line.
 */
export class Navigator {
  constructor(game) {
    this.game = game;
    if (!game.tree || !Array.isArray(game.tree.children)) {
      game.tree = movesToTree(game.moves);
    }
    this.tree = game.tree;
    this.index = 0; // number of moves currently applied (0..line length)
    this.redoStack = [];
    this.rebuild();
  }

  /** Follow children[0] from `node` to its deepest leaf. */
  mainlineFrom(node) {
    const out = [];
    let n = node;
    while (n.children && n.children.length) {
      n = n.children[0];
      out.push(n);
    }
    return out;
  }

  /**
   * Reset the active line to the tree's main line and replay it. Called on
   * construction and after structural edits (deleteMove).
   */
  rebuild() {
    this.path = [this.tree, ...this.mainlineFrom(this.tree)];
    this.replayPath();
    this.index = Math.min(this.index, this.moveCount);
  }

  /**
   * Replay the current `path` into frames/hashes, pruning the tail (and its
   * subtree) at the first move that turns out illegal. Keeps the derived
   * `game.moves` mirror in sync with the active line.
   */
  replayPath() {
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
    const validNodes = [this.tree];
    let capturedByBlack = 0;
    let capturedByWhite = 0;

    for (let k = 1; k < this.path.length; k++) {
      const node = this.path[k];
      const move = node.move;
      if (move.pass) {
        validNodes.push(node);
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
        // prune the illegal node (and everything after it) from the tree
        const parent = this.path[k - 1];
        const idx = parent.children.indexOf(node);
        if (idx >= 0) parent.children.splice(idx, 1);
        break;
      }
      board = result.board;
      hashes.push(result.hash);
      if (move.color === BLACK) capturedByBlack += result.captures.length;
      else capturedByWhite += result.captures.length;
      validNodes.push(node);
      frames.push({
        grid: board.grid.slice(),
        capturedByBlack,
        capturedByWhite,
        lastMove: move,
        captures: result.captures,
      });
    }

    this.path = validNodes;
    this.frames = frames;
    this.hashes = hashes;
    this.game.moves = validNodes.slice(1).map((n) => n.move);
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

  /** The tree node at the current index (the root when index === 0). */
  currentNode() {
    return this.path[this.index];
  }

  /** True when the active line follows children[0] all the way from the root. */
  onMainLine() {
    let node = this.tree;
    for (let i = 1; i < this.path.length; i++) {
      if (node.children[0] !== this.path[i]) return false;
      node = this.path[i];
    }
    return true;
  }

  /** Route the active line back to the main line, keeping the current depth. */
  goToMainLine() {
    const depth = this.index;
    this.path = [this.tree, ...this.mainlineFrom(this.tree)];
    this.replayPath();
    this.index = Math.min(depth, this.moveCount);
    return this.frame();
  }

  /** DFS from the root for `target`; returns [root, …, target] or null. */
  nodePath(target) {
    const dfs = (node, acc) => {
      acc.push(node);
      if (node === target) return acc.slice();
      for (const child of node.children) {
        const found = dfs(child, acc);
        if (found) return found;
      }
      acc.pop();
      return null;
    };
    return dfs(this.tree, []);
  }

  /**
   * Make `target` (any node in the tree) the current position. The active
   * line is routed through it and extended along its main line so the user
   * can keep stepping forward.
   */
  goToNode(target) {
    const path = this.nodePath(target);
    if (!path) return null;
    const depth = path.length - 1;
    this.path = [...path, ...this.mainlineFrom(target)];
    this.replayPath();
    this.index = Math.min(depth, this.moveCount);
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

  /** Re-point the active line through `node`, extending to its main line. */
  followFromCurrent(node) {
    this.path = this.path.slice(0, this.index + 1);
    this.path.push(node, ...this.mainlineFrom(node));
    this.replayPath();
    this.index += 1;
  }

  /**
   * Play a stone at the current index. If the current node already has a
   * matching continuation it is re-selected; otherwise a new branch is
   * created beside any existing continuations (none are discarded).
   * Returns { ok, reason?, move?, captures?, branched? }.
   */
  play(color, x, y) {
    const result = this.tryPlacement(color, x, y);
    if (!result.legal) return { ok: false, reason: result.reason };
    const cur = this.path[this.index];
    let branched = false;
    let child = cur.children.find((c) => !c.move.pass
      && c.move.color === color && c.move.x === x && c.move.y === y);
    if (!child) {
      if (cur.children.length > 0) branched = true;
      child = createNode({ color, x, y, tags: [], note: '', bookmarked: false });
      cur.children.push(child);
    }
    this.redoStack = [];
    this.followFromCurrent(child);
    return { ok: true, move: child.move, captures: result.captures, branched };
  }

  pass(color) {
    const cur = this.path[this.index];
    let branched = false;
    let child = cur.children.find((c) => c.move.pass && c.move.color === color);
    if (!child) {
      if (cur.children.length > 0) branched = true;
      child = createNode({ pass: true, color, tags: [], note: '', bookmarked: false });
      cur.children.push(child);
    }
    this.redoStack = [];
    this.followFromCurrent(child);
    return { ok: true, move: child.move, branched };
  }

  /** The continuations available at the current node (alternative branches). */
  variations() {
    return this.path[this.index].children;
  }

  /** Whether the move at active-line position `n` (1-based) has siblings. */
  isBranchPoint(n) {
    const parent = this.path[n - 1];
    return !!parent && parent.children.length > 1;
  }

  /** Make child `childIndex` of the current node the active continuation. */
  selectVariation(childIndex) {
    const cur = this.path[this.index];
    if (childIndex < 0 || childIndex >= cur.children.length) return null;
    this.redoStack = [];
    this.followFromCurrent(cur.children[childIndex]);
    return this.currentMove();
  }

  /** Undo: remove the last move of the active line (it can be redone). */
  undo() {
    if (this.moveCount === 0) return null;
    const node = this.path[this.path.length - 1];
    const parent = this.path[this.path.length - 2];
    const childIndex = parent.children.indexOf(node);
    if (childIndex >= 0) parent.children.splice(childIndex, 1);
    this.redoStack.push({ parent, node, childIndex });
    this.path.pop();
    this.replayPath();
    this.index = Math.min(this.index, this.moveCount);
    return node.move;
  }

  redo() {
    if (this.redoStack.length === 0) return null;
    const { parent, node, childIndex } = this.redoStack.pop();
    const at = childIndex >= 0 && childIndex <= parent.children.length
      ? childIndex : parent.children.length;
    parent.children.splice(at, 0, node);
    this.path.push(node, ...this.mainlineFrom(node));
    this.replayPath();
    this.index = this.moveCount;
    return node.move;
  }

  /**
   * Delete the move at active-line position `moveIndex` (0-based) and the
   * variation that follows it. The active line falls back to the main line.
   * Returns the number of additional moves removed from the active line.
   */
  deleteMove(moveIndex) {
    if (moveIndex < 0 || moveIndex >= this.moveCount) return 0;
    const node = this.path[moveIndex + 1];
    const parent = this.path[moveIndex];
    const idx = parent.children.indexOf(node);
    if (idx >= 0) parent.children.splice(idx, 1);
    this.redoStack = [];
    const before = this.moveCount;
    this.rebuild();
    this.index = Math.min(moveIndex, this.moveCount);
    return Math.max(0, before - this.moveCount - 1);
  }
}

/** Final position summary used for thumbnails and the library list. */
export function finalFrame(game) {
  const nav = new Navigator(game);
  nav.goTo(nav.moveCount);
  return nav.frame();
}

/** Moves (across every branch) that the player marked as worth revisiting. */
export function keyMoments(game) {
  const out = [];
  const root = game.tree && game.tree.children ? game.tree : movesToTree(game.moves);
  const walk = (node, depth) => {
    for (const child of node.children) {
      const move = child.move;
      const tagged = move.tags && move.tags.length > 0;
      if (move.bookmarked || tagged || (move.note && move.note.trim())) {
        out.push({ move, number: depth + 1 });
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

export function hasReviewLater(game) {
  if (game.reviewLater) return true;
  const root = game.tree && game.tree.children ? game.tree : movesToTree(game.moves);
  let found = false;
  const walk = (node) => {
    for (const child of node.children) {
      if (child.move.tags && child.move.tags.includes('review later')) found = true;
      walk(child);
    }
  };
  walk(root);
  return found;
}
