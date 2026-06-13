/**
 * Logic tests for the Go engine and SGF round-trip.
 * Run with: node test/engine.test.mjs
 */

import {
  BLACK, WHITE, EMPTY, Board, computePlacement,
  createGame, Navigator, finalFrame, keyMoments,
} from '../js/engine.js';
import { gameToSgf, sgfToGame } from '../js/sgf.js';

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok  ${msg}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${msg}`);
  }
}

// ----- basic placement & capture -----
{
  console.log('capture:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  // White stone at (4,4) surrounded by black
  assert(nav.play(BLACK, 4, 3).ok, 'B above');
  assert(nav.play(WHITE, 4, 4).ok, 'W center');
  assert(nav.play(BLACK, 3, 4).ok, 'B left');
  assert(nav.play(WHITE, 0, 0).ok, 'W elsewhere');
  assert(nav.play(BLACK, 5, 4).ok, 'B right');
  assert(nav.play(WHITE, 0, 1).ok, 'W elsewhere 2');
  const res = nav.play(BLACK, 4, 5);
  assert(res.ok && res.captures.length === 1, 'capture single white stone');
  assert(nav.board().get(4, 4) === EMPTY, 'captured point is empty');
  assert(nav.frame().capturedByBlack === 1, 'capture count tracked');
}

// ----- suicide -----
{
  console.log('suicide:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 1);
  nav.play(WHITE, 8, 8);
  nav.play(BLACK, 1, 0);
  const res = nav.play(WHITE, 0, 0);
  assert(!res.ok && res.reason === 'suicide', 'suicide is rejected');
}

// ----- ko -----
{
  console.log('ko:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  // classic ko shape
  nav.play(BLACK, 2, 2); // B
  nav.play(WHITE, 5, 2); // W
  nav.play(BLACK, 3, 1);
  nav.play(WHITE, 4, 1);
  nav.play(BLACK, 3, 3);
  nav.play(WHITE, 4, 3);
  nav.play(BLACK, 4, 2); // B plays into ko mouth
  const take = nav.play(WHITE, 3, 2); // W captures the B stone at 4,2
  assert(take.ok && take.captures.length === 1, 'white takes ko');
  const retake = nav.play(BLACK, 4, 2); // immediate recapture = ko
  assert(!retake.ok && retake.reason === 'ko', 'immediate ko recapture rejected');
  // black plays elsewhere; then the retake is legal? (superko: position would
  // repeat exactly only if nothing else changed — playing elsewhere changes it)
  assert(nav.play(BLACK, 8, 8).ok, 'black ko threat elsewhere');
  assert(nav.play(WHITE, 8, 7).ok, 'white answers');
  assert(nav.play(BLACK, 4, 2).ok, 'ko retake legal after exchange');
}

// ----- undo / redo -----
{
  console.log('undo/redo:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 4, 4);
  nav.play(WHITE, 2, 2);
  nav.undo();
  assert(nav.moveCount === 1 && nav.board().get(2, 2) === EMPTY, 'undo removes move');
  nav.redo();
  assert(nav.moveCount === 2 && nav.board().get(2, 2) === WHITE, 'redo restores move');
  nav.undo(); nav.undo();
  assert(nav.moveCount === 0, 'undo to empty');
  nav.redo(); nav.redo();
  assert(nav.moveCount === 2, 'redo twice');
}

// ----- pass & navigation -----
{
  console.log('pass/navigation:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 4, 4);
  nav.pass(WHITE);
  nav.play(BLACK, 2, 2);
  assert(nav.moveCount === 3, 'pass recorded');
  assert(nav.nextColor() === WHITE, 'alternation after pass');
  nav.goTo(1);
  assert(nav.board().get(2, 2) === EMPTY, 'goTo earlier position');
  nav.goTo(3);
  assert(nav.board().get(2, 2) === BLACK, 'goTo end');
}

// ----- branching when playing mid-game -----
{
  console.log('branching:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 0);
  nav.play(WHITE, 1, 1);
  nav.play(BLACK, 2, 2);
  nav.goTo(1);
  const res = nav.play(WHITE, 5, 5);
  assert(res.ok && res.branched === true, 'mid-game move flagged as a new branch');
  assert(nav.moveCount === 2, 'active line is the new branch');
  assert(nav.board().get(5, 5) === WHITE && nav.board().get(1, 1) === EMPTY, 'new line applied');
  // the original continuation is preserved as a sibling, not discarded
  nav.goTo(1);
  const vars = nav.variations();
  assert(vars.length === 2, 'both continuations preserved at the branch point');
  assert(nav.isBranchPoint(2), 'move 2 reported as a branch point');
  // switching back restores the original W(1,1) line and its later move
  const sel = vars.findIndex((c) => c.move.x === 1 && c.move.y === 1);
  nav.selectVariation(sel);
  assert(nav.board().get(1, 1) === WHITE, 'original variation re-selected');
  nav.goTo(nav.moveCount);
  assert(nav.board().get(2, 2) === BLACK, 'original later move still present');
}

// ----- selecting an existing variation by replaying its move -----
{
  console.log('reselect:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 0);
  nav.play(WHITE, 1, 1);
  nav.goTo(1);
  const res = nav.play(WHITE, 1, 1); // same move as the existing continuation
  assert(res.ok && !res.branched, 'replaying the same move does not create a duplicate branch');
  nav.goTo(1);
  assert(nav.variations().length === 1, 'no duplicate child added');
}

// ----- delete prunes the move and the line that follows it -----
{
  console.log('delete:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 0);
  nav.play(WHITE, 5, 5);
  nav.play(BLACK, 0, 0 + 1); // B(0,1)
  nav.goTo(3);
  const dropped = nav.deleteMove(1); // remove W(5,5) and the move after it
  assert(nav.moveCount === 1, 'delete removes the move and its continuation');
  assert(dropped === 1, 'reports the one trailing move removed');
  assert(nav.game.moves[0].x === 0 && nav.game.moves[0].y === 0, 'earlier move kept');
}

// ----- delete a capturing move restores the captured stone -----
{
  console.log('delete cascade:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  // build a capture: B surrounds W at (4,4)
  nav.play(BLACK, 4, 3);
  nav.play(WHITE, 4, 4);
  nav.play(BLACK, 3, 4);
  nav.play(WHITE, 8, 8);
  nav.play(BLACK, 5, 4);
  nav.play(WHITE, 8, 7);
  nav.play(BLACK, 4, 5); // captures W(4,4)
  nav.play(WHITE, 4, 4); // W replays into the surrounded point = suicide, rejected
  assert(nav.moveCount === 7, 'suicide replay was rejected by play()');
  nav.play(WHITE, 2, 2);
  const before = nav.moveCount; // 8
  const dropped = nav.deleteMove(6); // remove the capturing move B(4,5) + the line after
  assert(nav.moveCount === 6, 'capture move and its continuation removed');
  assert(dropped === 1, 'one trailing move removed besides the deleted one');
  assert(nav.frames[nav.frames.length - 1].grid[4 * 9 + 4] === WHITE, 'white stone restored after delete');
}

// ----- SGF round trip -----
{
  console.log('sgf:');
  const game = createGame({
    size: 13, playerBlack: 'Aki', playerWhite: 'Ben ]bracket[',
    komi: 7.5, date: '2026-06-12', location: 'Club', result: 'B+3.5',
    notes: 'Friendly game',
  });
  const nav = new Navigator(game);
  nav.play(BLACK, 3, 3);
  nav.play(WHITE, 9, 9);
  nav.pass(BLACK);
  nav.play(WHITE, 9, 3);
  game.moves[0].note = 'Solid corner ] with bracket';
  game.moves[0].tags = ['opening', 'good move'];
  game.moves[1].bookmarked = true;

  const sgf = gameToSgf(game);
  const back = sgfToGame(sgf);
  assert(back.size === 13, 'size round-trip');
  assert(back.playerBlack === 'Aki', 'player round-trip');
  assert(back.playerWhite === 'Ben ]bracket[', 'escaped player round-trip');
  assert(back.komi === 7.5, 'komi round-trip');
  assert(back.result === 'B+3.5', 'result round-trip');
  assert(back.moves.length === 4, 'move count round-trip');
  assert(back.moves[0].x === 3 && back.moves[0].y === 3, 'coords round-trip');
  assert(back.moves[0].note === 'Solid corner ] with bracket', 'note round-trip');
  assert(back.moves[0].tags.join(',') === 'opening,good move', 'tags round-trip');
  assert(back.moves[1].bookmarked === true, 'bookmark round-trip');
  assert(back.moves[2].pass === true, 'pass round-trip');
  // imported game must replay cleanly
  const nav2 = new Navigator(back);
  assert(nav2.moveCount === 4, 'imported game replays with no drops');
}

// ----- SGF from another app (no journal extensions) -----
{
  console.log('sgf external:');
  const external = `(;GM[1]FF[4]SZ[9]PB[Foo]PW[Bar]KM[5.5]RE[W+R]
;B[ee];W[cc]C[nice move];B[](;W[gg])(;W[hh]))`;
  const game = sgfToGame(external);
  assert(game.size === 9 && game.playerWhite === 'Bar', 'external metadata');
  assert(game.moves.length === 4, 'main line follows the first variation');
  assert(game.moves[2].pass === true, 'B[] read as pass');
  assert(game.moves[3].x === 6 && game.moves[3].y === 6, 'first variation followed');
  assert(game.moves[1].note === 'nice move', 'external comment kept');
  // the second variation is preserved as a branch, not dropped
  const navExt = new Navigator(game);
  navExt.goTo(3);
  const vExt = navExt.variations();
  assert(vExt.length === 2, 'both variations imported as branches');
  assert(vExt.some((c) => c.move.x === 7 && c.move.y === 7), 'second variation (hh) kept');
}

// ----- SGF round-trip preserves variations -----
{
  console.log('sgf variations:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 3, 3);
  nav.play(WHITE, 5, 5);
  nav.goTo(1);
  nav.play(WHITE, 6, 6); // a second continuation for white -> branch
  const sgf = gameToSgf(game);
  const back = sgfToGame(sgf);
  const nav2 = new Navigator(back);
  nav2.goTo(1);
  const vars = nav2.variations();
  assert(vars.length === 2, 'both branches survive SGF round-trip');
  const coords = vars.map((c) => `${c.move.x},${c.move.y}`).sort();
  assert(coords.join('|') === '5,5|6,6', 'both branch moves round-tripped');
}

// ----- key moments / final frame -----
{
  console.log('moments:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 4, 4);
  nav.play(WHITE, 2, 2);
  game.moves[0].bookmarked = true;
  game.moves[1].tags = ['fight'];
  const moments = keyMoments(game);
  assert(moments.length === 2 && moments[0].number === 1, 'key moments collected');
  const frame = finalFrame(game);
  assert(frame.grid[4 * 9 + 4] === BLACK, 'final frame correct');
}

console.log(failures === 0 ? '\nAll tests passed.' : `\n${failures} test(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
