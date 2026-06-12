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

// ----- truncation when playing mid-game -----
{
  console.log('truncation:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 0);
  nav.play(WHITE, 1, 1);
  nav.play(BLACK, 2, 2);
  nav.goTo(1);
  nav.play(WHITE, 5, 5);
  assert(nav.moveCount === 2, 'later moves truncated');
  assert(nav.board().get(5, 5) === WHITE && nav.board().get(1, 1) === EMPTY, 'new line applied');
}

// ----- delete move with revalidation -----
{
  console.log('delete:');
  const game = createGame({ size: 9 });
  const nav = new Navigator(game);
  nav.play(BLACK, 0, 0);
  nav.play(WHITE, 5, 5);
  nav.play(BLACK, 0, 0 + 1); // B(0,1)
  nav.goTo(3);
  const dropped = nav.deleteMove(1); // remove W(5,5)
  assert(dropped === 0 && nav.moveCount === 2, 'simple delete keeps later moves');
  assert(nav.game.moves[1].x === 0 && nav.game.moves[1].y === 1, 'later move kept');
}

// ----- delete that makes a later move illegal -----
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
  nav.play(WHITE, 4, 4); // W replays into the now-empty point (1 liberty? no -
  // surrounded on 4 sides by black = suicide... so use a different point)
  // The above would be illegal; check engine said so:
  assert(nav.moveCount === 7, 'suicide replay was rejected by play()');
  nav.play(WHITE, 2, 2);
  // deleting black's first surround stone makes the capture move still legal,
  // but deleting the capture itself is the interesting case:
  const before = nav.moveCount;
  nav.deleteMove(6); // remove the capturing move B(4,5)
  assert(nav.moveCount === before - 1, 'delete capture move');
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
  assert(game.moves.length === 4, 'main line only (variations ignored)');
  assert(game.moves[2].pass === true, 'B[] read as pass');
  assert(game.moves[3].x === 6 && game.moves[3].y === 6, 'first variation followed');
  assert(game.moves[1].note === 'nice move', 'external comment kept');
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
