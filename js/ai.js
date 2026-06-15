/**
 * AI game review — talks to an external KataGo Analysis Engine endpoint
 * (or any compatible proxy) over HTTP and turns its reply into the per-move
 * win-rate / score / best-move data the UI draws.
 *
 * No DOM access here; the network call lives in AnalysisClient and the rest
 * are pure helpers so they can be tested without a browser.
 *
 * Query format follows the KataGo Analysis Engine:
 *   https://github.com/lightvector/KataGo/blob/master/docs/Analysis_Engine.md
 * The browser keeps everything local except the single POST to the endpoint
 * the player configures.
 */

import { BLACK } from './engine.js';

// Go column letters (no "I", by convention) — shared with the board labels.
export const AI_COLS = 'ABCDEFGHJKLMNOPQRST';

/** A journal move → KataGo/GTP coordinate ("Q16", or "pass"). */
export function moveToGtp(move, size) {
  if (!move || move.pass) return 'pass';
  return AI_COLS[move.x] + (size - move.y);
}

/** A KataGo/GTP coordinate → { x, y } in board space, or null for a pass. */
export function gtpToXY(gtp, size) {
  if (!gtp || String(gtp).toLowerCase() === 'pass') return null;
  const letter = String(gtp)[0].toUpperCase();
  const x = AI_COLS.indexOf(letter);
  const num = parseInt(String(gtp).slice(1), 10);
  if (x < 0 || Number.isNaN(num)) return null;
  return { x, y: size - num };
}

/**
 * A compact signature of the position sequence an analysis was computed for.
 * Stored alongside the result so we can tell when the game has changed under
 * a cached analysis and mark it stale.
 */
export function lineSignature(game) {
  const parts = (game.moves || []).map(
    (m) => (m.pass ? 'p' : `${m.color}${m.x},${m.y}`));
  return `${game.size}|${game.komi}|${parts.join(';')}`;
}

const clamp01 = (v) => (typeof v === 'number' && Number.isFinite(v)
  ? Math.max(0, Math.min(1, v)) : null);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Build the KataGo Analysis Engine query for a whole game. Every turn from
 * the empty board (0) through the final position (moveCount) is requested so
 * the win-rate graph and per-move overlays have a value everywhere.
 */
export function buildQuery(game, { maxVisits = 100, rules = 'japanese', id = 'review' } = {}) {
  const size = game.size;
  const moves = (game.moves || []).map(
    (m) => [m.color === BLACK ? 'B' : 'W', moveToGtp(m, size)]);
  const analyzeTurns = [];
  for (let i = 0; i <= moves.length; i++) analyzeTurns.push(i);
  return {
    id,
    moves,
    rules,
    komi: game.komi,
    boardXSize: size,
    boardYSize: size,
    analyzeTurns,
    maxVisits,
    // Pin every win-rate to Black's perspective so the graph is unambiguous.
    reportAnalysisWinratesAs: 'BLACK',
  };
}

/**
 * Normalize whatever the endpoint returns into an array of per-turn response
 * objects. Accepts a JSON array, an object wrapping the turns, a single turn
 * object, or newline-delimited JSON (one turn per line, as the native engine
 * streams it).
 */
export function parseResponse(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return [];
  try {
    const data = JSON.parse(trimmed);
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.turnInfos)) return data.turnInfos;
    if (Array.isArray(data.results)) return data.results;
    if (Array.isArray(data.turns)) return data.turns;
    if (data.turnNumber !== undefined || data.moveInfos) return [data];
    return [];
  } catch {
    const out = [];
    for (const line of trimmed.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      try { out.push(JSON.parse(t)); } catch { /* skip malformed line */ }
    }
    return out;
  }
}

/**
 * Reduce the raw turn responses to a { [turnNumber]: turn } map. Each turn
 * carries Black-perspective win-rate / score and the engine's ranked
 * candidate moves (already resolved to board coordinates).
 */
export function digestTurns(turnResponses, game) {
  const size = game.size;
  const turns = {};
  for (const t of turnResponses) {
    const turnNumber = t.turnNumber ?? t.turn ?? null;
    if (turnNumber == null) continue;
    const root = t.rootInfo || {};
    const candidates = (t.moveInfos || [])
      .slice()
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .slice(0, 6)
      .map((mi) => ({
        gtp: mi.move,
        xy: gtpToXY(mi.move, size),
        winrateBlack: clamp01(mi.winrate),
        scoreLeadBlack: num(mi.scoreLead),
        visits: num(mi.visits),
        order: mi.order ?? 0,
        pv: Array.isArray(mi.pv) ? mi.pv : [],
      }));
    turns[turnNumber] = {
      turnNumber,
      blackWinrate: clamp01(root.winrate),
      scoreLead: num(root.scoreLead),
      candidates,
    };
  }
  return turns;
}

/**
 * For each played move, how much win-rate the mover gave up versus the
 * engine's best move at that position. Used for the mistake markers and
 * auto-tagging. Entries are null where the analysis is incomplete.
 */
export function computeLosses(turns, game) {
  const moves = game.moves || [];
  const losses = [];
  for (let i = 0; i < moves.length; i++) {
    const before = turns[i];
    const after = turns[i + 1];
    const best = before && before.candidates[0];
    if (!before || !after || !best
        || before.blackWinrate == null || after.blackWinrate == null
        || best.winrateBlack == null) {
      losses.push(null);
      continue;
    }
    const mover = moves[i].color;
    // Everything is in Black's frame; flip to the mover's frame so a loss is
    // always a non-negative drop for whoever played the move.
    const bestForMover = mover === BLACK ? best.winrateBlack : 1 - best.winrateBlack;
    const gotForMover = mover === BLACK ? after.blackWinrate : 1 - after.blackWinrate;
    losses.push({
      loss: Math.max(0, bestForMover - gotForMover),
      mover,
      bestGtp: best.gtp,
    });
  }
  return losses;
}

/** Thin client around the configured analysis endpoint. */
export class AnalysisClient {
  constructor({ endpoint, apiKey } = {}) {
    this.endpoint = endpoint;
    this.apiKey = apiKey;
  }

  get configured() {
    return !!(this.endpoint && this.endpoint.trim());
  }

  /**
   * Analyze a full game. Resolves to the stored analysis shape:
   *   { engine, maxVisits, createdAt, lineSignature, turns, losses }
   * Throws with a readable message on network / format problems.
   */
  async analyzeGame(game, { maxVisits = 100, rules = 'japanese', signal } = {}) {
    if (!this.configured) throw new Error('No analysis endpoint configured.');
    const query = buildQuery(game, { maxVisits, rules });
    const headers = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res;
    try {
      res = await fetch(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(query),
        signal,
      });
    } catch (err) {
      throw new Error(`Could not reach the analysis endpoint: ${err.message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Analysis request failed (${res.status})`
        + (body ? `: ${body.slice(0, 160)}` : ''));
    }

    const turnResponses = parseResponse(await res.text());
    if (turnResponses.length === 0) {
      throw new Error('The endpoint returned no analysis — check its response format.');
    }
    const turns = digestTurns(turnResponses, game);
    return {
      engine: 'katago',
      maxVisits,
      createdAt: new Date().toISOString(),
      lineSignature: lineSignature(game),
      turns,
      losses: computeLosses(turns, game),
    };
  }
}
