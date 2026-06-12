/**
 * SGF (Smart Game Format) import / export.
 *
 * Exports the main line of a game with standard properties plus two
 * journal extensions other SGF apps will simply ignore:
 *   TG[tag,tag]  per-move tags
 *   HO[1]        standard "hotspot" property, used for bookmarks
 */

import { BLACK, WHITE, createGame } from './engine.js';

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
  for (const move of game.moves) {
    const key = move.color === BLACK ? 'B' : 'W';
    const point = move.pass ? '' : toSgfPoint(move.x, move.y);
    out += `\n;${key}[${point}]`;
    if (move.note && move.note.trim()) out += `C[${escapeSgf(move.note)}]`;
    if (move.tags && move.tags.length) out += `TG[${escapeSgf(move.tags.join(','))}]`;
    if (move.bookmarked) out += 'HO[1]';
  }
  out += ')\n';
  return out;
}

/**
 * Minimal SGF parser. Follows the main line (first child at every
 * branch) and ignores properties it does not understand.
 * Returns a list of nodes: [{ B: ['pd'], C: ['...'], ... }, ...]
 */
function parseNodes(text) {
  const nodes = [];
  let i = 0;
  let depth = 0;
  let mainLine = true;
  const n = text.length;

  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  while (i < n) {
    skipWs();
    const ch = text[i];
    if (ch === '(') {
      depth += 1;
      // only the first branch at each fork is the main line
      i += 1;
    } else if (ch === ')') {
      depth -= 1;
      mainLine = false; // anything after a close-paren is a sibling variation
      i += 1;
    } else if (ch === ';') {
      i += 1;
      if (!mainLine) { // skip variation nodes entirely
        continue;
      }
      const node = {};
      while (i < n) {
        skipWs();
        const m = /^[A-Za-z]+/.exec(text.slice(i, i + 12));
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
      }
      nodes.push(node);
    } else if (ch === undefined) {
      break;
    } else {
      i += 1;
    }
    if (depth === 0 && nodes.length > 0) break;
  }
  return nodes;
}

/**
 * Parse SGF text into a game record. Throws Error with a readable
 * message when the content is not usable.
 */
export function sgfToGame(text) {
  const nodes = parseNodes(text);
  if (nodes.length === 0) throw new Error('No SGF nodes found in file.');

  const root = nodes[0];
  const first = (key) => (root[key] && root[key][0]) || '';
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
  const moveNodes = root.B || root.W ? nodes : nodes.slice(1);

  for (const node of moveNodes) {
    let color = null;
    let value = null;
    if (node.B) { color = BLACK; value = node.B[0]; }
    else if (node.W) { color = WHITE; value = node.W[0]; }
    if (color === null) continue;

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
    game.moves.push(move);
  }

  return game;
}
