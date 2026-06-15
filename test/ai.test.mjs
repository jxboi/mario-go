/**
 * Tests for the AI-review helpers (coordinate mapping, query building,
 * response parsing and win-rate loss math). Pure logic, no network.
 * Run with: node test/ai.test.mjs
 */

import { BLACK, WHITE, createGame, Navigator } from '../js/engine.js';
import {
  moveToGtp, gtpToXY, lineSignature, buildQuery,
  parseResponse, digestTurns, computeLosses,
} from '../js/ai.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ----- coordinate conversion (no "I", row counts from the bottom) -----
{
  console.log('coordinates:');
  assert(moveToGtp({ color: BLACK, x: 4, y: 4 }, 9) === 'E5', 'centre of 9x9 → E5');
  assert(moveToGtp({ color: WHITE, x: 8, y: 0 }, 9) === 'J9', 'skips I → J9');
  assert(moveToGtp({ pass: true, color: BLACK }, 19) === 'pass', 'pass → "pass"');
  const xy = gtpToXY('E5', 9);
  assert(xy.x === 4 && xy.y === 4, 'E5 → {4,4}');
  assert(gtpToXY('J9', 9).x === 8, 'J column maps back to x=8');
  assert(gtpToXY('pass', 9) === null, 'pass → null');
}

// ----- query building -----
{
  console.log('query:');
  const game = createGame({ size: 9, komi: 5.5 });
  const nav = new Navigator(game);
  nav.play(BLACK, 4, 4);
  nav.play(WHITE, 2, 6);
  const q = buildQuery(game, { maxVisits: 50 });
  assert(q.boardXSize === 9 && q.boardYSize === 9, 'board size set');
  assert(q.komi === 5.5, 'komi carried through');
  assert(q.maxVisits === 50, 'maxVisits set');
  assert(q.reportAnalysisWinratesAs === 'BLACK', 'win-rates pinned to Black');
  assert(JSON.stringify(q.moves) === JSON.stringify([['B', 'E5'], ['W', 'C3']]),
    'moves serialized to GTP pairs');
  assert(JSON.stringify(q.analyzeTurns) === JSON.stringify([0, 1, 2]),
    'every turn (0..N) requested');
}

// ----- response parsing accepts several shapes -----
{
  console.log('parsing:');
  const turn = { turnNumber: 0, rootInfo: { winrate: 0.5 }, moveInfos: [] };
  assert(parseResponse(JSON.stringify([turn])).length === 1, 'JSON array');
  assert(parseResponse(JSON.stringify({ turnInfos: [turn] })).length === 1, 'wrapped in turnInfos');
  assert(parseResponse(JSON.stringify(turn)).length === 1, 'single turn object');
  const ndjson = `${JSON.stringify(turn)}\n${JSON.stringify({ ...turn, turnNumber: 1 })}`;
  assert(parseResponse(ndjson).length === 2, 'newline-delimited JSON');
  assert(parseResponse('').length === 0, 'empty text → no turns');
}

// ----- digest + win-rate loss (a clear White blunder) -----
{
  console.log('losses:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 4, 4);
  nav.play(WHITE, 2, 6);
  const responses = [
    { turnNumber: 0, rootInfo: { winrate: 0.5, scoreLead: 0 },
      moveInfos: [{ move: 'E5', winrate: 0.55, scoreLead: 1, order: 0, visits: 100 }] },
    { turnNumber: 1, rootInfo: { winrate: 0.55, scoreLead: 1 },
      moveInfos: [{ move: 'C3', winrate: 0.50, scoreLead: 0, order: 0, visits: 100 }] },
    // White's move left Black at 0.70 — a 20% drop from the best (0.50) line.
    { turnNumber: 2, rootInfo: { winrate: 0.70, scoreLead: 4 }, moveInfos: [] },
  ];
  const turns = digestTurns(responses, game);
  assert(close(turns[0].blackWinrate, 0.5), 'turn 0 win-rate digested');
  assert(turns[0].candidates[0].xy.x === 4, 'candidate resolved to coordinates');

  const losses = computeLosses(turns, game);
  assert(close(losses[0].loss, 0), 'Black played the best move → no loss');
  assert(losses[1].mover === WHITE && close(losses[1].loss, 0.2),
    'White blunder measured as a 0.20 loss');
}

// ----- signature changes when the line changes -----
{
  console.log('signature:');
  const a = createGame({ size: 9 });
  const navA = new Navigator(a);
  navA.play(BLACK, 4, 4);
  const sig1 = lineSignature(a);
  navA.play(WHITE, 2, 6);
  assert(sig1 !== lineSignature(a), 'adding a move changes the signature');
}

if (failures === 0) console.log('\nAll tests passed.');
else { console.error(`\n${failures} test(s) failed.`); process.exit(1); }
