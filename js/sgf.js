/**
 * SGF (Smart Game Format) import / export.
 *
 * Exports the main line of a game with standard properties plus two
 * journal extensions other SGF apps will simply ignore:
 *   TG[tag,tag]  per-move tags
 *   HO[1]        standard "hotspot" property, used for bookmarks
 */

import {
  BLACK, WHITE, createGame, createNode, movesToTree, mainlineMoves,
} from './engine.js';

const COORDS = 'abcdefghijklmnopqrstuvwxyz';

function toSgfPoint(x, y) {
  return COORDS[x] + COORDS[y];
}

function fromSgfPoint(value, size) {
  if (!value || value.length < 2) return null;
  const x = COORDS.indexOf(value[0]);
  const y = COORDS.indexOf(value[1]);
  if (x < 0 || y < 0 || x >= size || y >= size) return null;
  return { x, y };
}

function escapeSgf(text) {
  return String(text).replace(/\\/g, '\\\\').replace(/]/g, '\\]');
}

export function gameToSgf(game) {
  const props = [
    'GM[1]', 'FF[4]', 'CA[UTF-8]', 'AP[GoJournal:1.0]',
    `SZ[${game.size}]`,
    `KM[${game.komi}]`,
  ];
  if (game.playerBlack) props.push(`PB[${escapeSgf(game.playerBlack)}]`);
  if (game.playerWhite) props.push(`PW[${escapeSgf(game.playerWhite)}]`);
  if (game.blackRank) props.push(`BR[${escapeSgf(game.blackRank)}]`);
  if (game.whiteRank) props.push(`WR[${escapeSgf(game.whiteRank)}]`);
  if (game.date) props.push(`DT[${escapeSgf(game.date)}]`);
  if (game.location) props.push(`PC[${escapeSgf(game.location)}]`);
  if (game.result) props.push(`RE[${escapeSgf(game.result)}]`);
  const rootComment = [game.notes, game.thoughts && `After-game thoughts: ${game.thoughts}`]
    .filter(Boolean).join('\n\n');
  if (rootComment) props.push(`C[${escapeSgf(rootComment)}]`);

  let out = `(;${props.join('')}`;
  const root = game.tree && game.tree.children ? game.tree : movesToTree(game.moves);
  out += serializeChildren(root.children);
  out += ')\n';
  return out;
}

/** One node's move + journal extensions (no leading newline). */
function moveToSgf(move) {
  const key = move.color === BLACK ? 'B' : 'W';
  const point = move.pass ? '' : toSgfPoint(move.x, move.y);
  let s = `;${key}[${point}]`;
  if (move.note && move.note.trim()) s += `C[${escapeSgf(move.note)}]`;
  if (move.tags && move.tags.length) s += `TG[${escapeSgf(move.tags.join(','))}]`;
  if (move.bookmarked) s += 'HO[1]';
  return s;
}

/** Serialize a node and its continuation (recursing into variations). */
function serializeNode(node) {
  let s = `\n${moveToSgf(node.move)}`;
  return s + serializeChildren(node.children);
}

/**
 * Serialize a list of child nodes. A single child continues the current
 * sequence; multiple children are each wrapped in their own ( … ) branch.
 */
function serializeChildren(children) {
  if (children.length === 0) return '';
  if (children.length === 1) return serializeNode(children[0]);
  return children.map((c) => `(${serializeNode(c)})`).join('');
}

/**
 * Recursive-descent SGF parser. Returns the collection of game trees;
 * each tree is { nodes: [{ B:['pd'], ... }], children: [tree, ...] }.
 * Properties that are not understood are simply kept as raw values.
 */
function parseCollection(text) {
  let i = 0;
  const n = text.length;
  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  function parseNode() {
    const node = {};
    skipWs();
    while (i < n) {
      const m = /^[A-Za-z]+/.exec(text.slice(i));
      if (!m) break;
      const ident = m[0].toUpperCase();
      i += m[0].length;
      skipWs();
      const values = [];
      while (text[i] === '[') {
        i += 1;
        let value = '';
        while (i < n && text[i] !== ']') {
          if (text[i] === '\\' && i + 1 < n) {
            value += text[i + 1];
            i += 2;
          } else {
            value += text[i];
            i += 1;
          }
        }
        i += 1; // closing ]
        values.push(value);
        skipWs();
      }
      node[ident] = (node[ident] || []).concat(values);
      skipWs();
    }
    return node;
  }

  function parseGameTree() {
    skipWs();
    if (text[i] !== '(') return null;
    i += 1; // consume (
    const nodes = [];
    skipWs();
    while (text[i] === ';') {
      i += 1; // consume ;
      nodes.push(parseNode());
      skipWs();
    }
    const children = [];
    while (text[i] === '(') {
      const child = parseGameTree();
      if (child) children.push(child);
      skipWs();
    }
    if (text[i] === ')') i += 1; // consume )
    return { nodes, children };
  }

  const trees = [];
  skipWs();
  while (text[i] === '(') {
    const tree = parseGameTree();
    if (tree) trees.push(tree);
    skipWs();
  }
  return trees;
}

/** Convert one SGF node's move properties into a journal move, or null. */
function sgfNodeToMove(node, size) {
  let color = null;
  let value = null;
  if (node.B) { color = BLACK; value = node.B[0]; }
  else if (node.W) { color = WHITE; value = node.W[0]; }
  if (color === null) return null;

  const move = {
    color,
    tags: [],
    note: (node.C && node.C[0]) || '',
    bookmarked: !!node.HO,
  };
  if (node.TG && node.TG[0]) {
    move.tags = node.TG[0].split(',').map((t) => t.trim()).filter(Boolean);
  }
  // Empty value, or "tt" on boards <= 19, means pass.
  const point = fromSgfPoint(value, size);
  if (!point || (value === 'tt' && size <= 19)) {
    move.pass = true;
  } else {
    move.x = point.x;
    move.y = point.y;
  }
  return move;
}

/**
 * Attach an SGF game-tree's node sequence (and its variation subtrees) to
 * `parent` in our move tree. Non-move nodes are skipped.
 */
function attachSequence(parent, nodes, childTrees, size) {
  let cur = parent;
  for (const sgfNode of nodes) {
    const move = sgfNodeToMove(sgfNode, size);
    if (!move) continue;
    const node = createNode(move);
    cur.children.push(node);
    cur = node;
  }
  for (const child of childTrees) {
    attachSequence(cur, child.nodes, child.children, size);
  }
}

/**
 * Parse SGF text into a game record, preserving variations as branches.
 * Throws Error with a readable message when the content is not usable.
 */
export function sgfToGame(text) {
  const trees = parseCollection(text);
  if (trees.length === 0 || trees[0].nodes.length === 0) {
    throw new Error('No SGF nodes found in file.');
  }

  const gtree = trees[0];
  const rootNode = gtree.nodes[0];
  const first = (key) => (rootNode[key] && rootNode[key][0]) || '';
  const size = parseInt(first('SZ'), 10) || 19;
  if (![9, 13, 19].includes(size)) {
    throw new Error(`Unsupported board size ${size} (supported: 9, 13, 19).`);
  }

  const game = createGame({
    size,
    playerBlack: first('PB'),
    playerWhite: first('PW'),
    blackRank: first('BR'),
    whiteRank: first('WR'),
    komi: parseFloat(first('KM')) || 0,
    date: first('DT') || new Date().toISOString().slice(0, 10),
    location: first('PC'),
    result: first('RE'),
    notes: first('C'),
  });

  // Root node may itself contain a move; usually moves start at node 1.
  const moveNodes = rootNode.B || rootNode.W ? gtree.nodes : gtree.nodes.slice(1);
  const root = createNode(null);
  attachSequence(root, moveNodes, gtree.children, size);

  game.tree = root;
  game.moves = mainlineMoves(root);
  return game;
}
