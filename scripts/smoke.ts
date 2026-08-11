// Dev-only smoke test for the cube mechanics. Run with: bun run smoke
import { RubiksCube, CUBIE_SIZE } from '../src/cube';

let failures = 0;

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function settle(cube: RubiksCube, frames = 120): void {
  for (let i = 0; i < frames; i++) cube.update(1 / 60);
}

function assertIntegrity(cube: RubiksCube): string | null {
  for (const c of cube.cubies) {
    const l = c.logical;
    for (const v of [l.x, l.y, l.z]) {
      if (!Number.isInteger(v) || v < -1 || v > 1) return `cubie at ${l.toArray()} out of range`;
    }
    if (!c.mesh.position.toArray().every((v) => Number.isFinite(v))) return 'non-finite position';
    if (!Number.isFinite(c.mesh.quaternion.x) || !Number.isFinite(c.mesh.quaternion.y) || !Number.isFinite(c.mesh.quaternion.z) || !Number.isFinite(c.mesh.quaternion.w)) {
      return 'non-finite quaternion';
    }
  }
  const seen = new Set<string>();
  for (const c of cube.cubies) {
    const key = c.logical.toArray().join(',');
    if (seen.has(key)) return `duplicate logical position ${key}`;
    seen.add(key);
  }
  if (seen.size !== 27) return `expected 27 cubies, got ${seen.size}`;
  // cubie meshes are centred on integer multiples of CUBIE_SIZE in cube-local space
  for (const c of cube.cubies) {
    const expected = c.logical.clone().multiplyScalar(CUBIE_SIZE);
    if (c.mesh.position.distanceTo(expected) > 0.0001) {
      return `mesh position ${c.mesh.position.toArray()} != logical ${expected.toArray()}`;
    }
  }
  return null;
}

console.log('— build & initial state —');
const cube = new RubiksCube();
check('starts solved', cube.isSolved());
check('no history', cube.history.length === 0);
check('27 cubies', cube.cubies.length === 27);

console.log('— simple turn: R (axis 0, layer +1) —');
check('queueTurn accepted', cube.queueTurn(0, 1, 1, 20));
settle(cube);
check('history has 1 move', cube.history.length === 1, cube.history.length.toString());
check('no longer solved', !cube.isSolved());
check('integrity after R', assertIntegrity(cube) === null, assertIntegrity(cube) ?? '');

console.log('— undo —');
cube.undo();
settle(cube);
check('solved after undo', cube.isSolved());
check('history empty', cube.history.length === 0);
check('integrity after undo', assertIntegrity(cube) === null, assertIntegrity(cube) ?? '');

console.log('— live turn (drag) —');
check('beginLiveTurn ok', cube.beginLiveTurn(2, 1));
cube.setLiveAngle(Math.PI * 0.5); // drag half way
cube.endLiveTurn();
settle(cube);
check('history 1 after live', cube.history.length === 1);
check('solved after +90', !cube.isSolved());
cube.undo();
settle(cube);
check('solved after live undo', cube.isSolved());

console.log('— live turn snapping (release near 180°) —');
cube.beginLiveTurn(1, 1);
cube.setLiveAngle(Math.PI * 0.95);
cube.endLiveTurn();
settle(cube);
check('snapped to 180 (dir 2)', cube.history[cube.history.length - 1].dir === 2, JSON.stringify(cube.history[cube.history.length - 1]));

console.log('— live turn release at 0 (no move) —');
cube.beginLiveTurn(0, -1);
cube.setLiveAngle(Math.PI * 0.2);
cube.setLiveAngle(0.02);
cube.endLiveTurn();
settle(cube);
const before = cube.history.length;
cube.undo();
settle(cube);
const after = cube.history.length;
check('no-op drag adds no move', after === before - 1 && cube.isSolved(), `${before} -> ${after}`);

console.log('— scramble —');
cube.scramble(22);
check('scramble queues moves', cube.isAnimating());
settle(cube, 900);
check('scramble finished', !cube.isAnimating());
check('scramble broke solved state', !cube.isSolved());
check('history length 22', cube.history.length === 22, cube.history.length.toString());
check('integrity after scramble', assertIntegrity(cube) === null, assertIntegrity(cube) ?? '');

console.log('— undo entire scramble —');
while (cube.history.length > 0) {
  cube.undo();
  settle(cube, 120);
}
check('solved after full undo', cube.isSolved());
check('integrity after full undo', assertIntegrity(cube) === null, assertIntegrity(cube) ?? '');

console.log('— reset rebuild —');
cube.scramble(10);
settle(cube, 400);
check('scrambled', !cube.isSolved());
cube.buildSolved();
check('reset to solved', cube.isSolved());
check('history cleared', cube.history.length === 0);
check('27 cubies after reset', cube.cubies.length === 27);

console.log('');
if (failures === 0) {
  console.log('ALL PASS');
} else {
  console.error(`${failures} FAILURES`);
  process.exit(1);
}
