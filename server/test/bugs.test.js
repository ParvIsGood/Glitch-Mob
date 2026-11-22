import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { carefulLeaderAction } from '../src/quest/ai.js';
import { ENEMIES, MORVATH, PIP, POWER_UPS, ROOMS, SWORD } from '../src/quest/data.js';
import { beginFight, createRun, distance, routeOptions, step } from '../src/quest/engine.js';
import { FEATURE_NAMES, decisionFeatures } from '../src/quest/features.js';
import { loadForest, predictGood } from '../src/quest/forest.js';
import { isWise } from '../src/quest/oracle.js';
import { questRouter } from '../src/quest/routes.js';
import { QuestRuns, cleanAction } from '../src/quest/runs.js';
import { makeProfile } from '../src/quest/teams.js';

const profile = (seed = 'test') => makeProfile({ teamId: 'test', seed, tier: 'strong' });
const fresh = () => createRun(profile());
const kael = (s) => s.party[0];

function withApi(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'quest-test-'));
  try {
    const runs = new QuestRuns({ profiles: [profile('api')], saveDir: dir });
    const router = questRouter(runs);
    const routeFor = (method, path) => router.stack.find((l) => l.route?.methods[method] && l.match(path))?.route;
    const call = (method, path, body = {}) => {
      const layer = router.stack.find((l) => l.route?.methods[method] && l.match(path));
      const out = { status: 200, body: null };
      const res = { status: (n) => ((out.status = n), res), json: (v) => ((out.body = v), res) };
      layer.route.stack[0].handle({ params: layer.params, body, get: () => undefined }, res);
      return out;
    };
    return fn({ runs, routeFor, call });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// --- Round 1 ---

test('R1.1: GET /teams and GET /meta are not shadowed by /:teamId', () => {
  withApi(({ routeFor }) => {
    assert.equal(routeFor('get', '/teams')?.path, '/teams');
    assert.equal(routeFor('get', '/meta')?.path, '/meta');
  });
});

test('R1.2: cleanAction preserves attack and defend without swapping', () => {
  assert.equal(cleanAction({ type: 'attack', targetId: 'skeleton-0-0' }).type, 'attack');
  assert.equal(cleanAction({ type: 'defend' }).type, 'defend');
});

test('R1.3: travel deducts exact corridor cost in torches', () => {
  const s0 = fresh();
  const opt = routeOptions(s0).find((o) => o.to === 'r4');
  assert.equal(opt.cost, distance(s0, 'camp', 'r4'));
  const s1 = step(s0, { type: 'travel', to: 'r4' });
  assert.equal(s1.torches, s0.torches - opt.cost);
});

test('R1.4: winning a room adds loot potions to existing potions', () => {
  const s = beginFight({ ...fresh(), potions: 5 }, 'r1');
  s.combat.waveIndex = ROOMS.r1.waves.length - 1;
  s.combat.enemies = [{ ...s.combat.enemies[0], hp: 0 }];
  const after = step(s, { type: 'wait' });
  assert.equal(after.phase, 'map');
  assert.equal(after.potions, 5 + ROOMS.r1.loot.potions);
});

test('R1.5: wave clears when all enemies reach 0 HP', () => {
  let s = beginFight(fresh(), 'r1');
  for (let i = 0; i < 300 && s.phase === 'combat'; i++) {
    s = step(s, carefulLeaderAction(s));
  }
  assert.equal(s.phase, 'map');
  assert.deepEqual(s.fragments, ['r1']);
});

test('R1.6: POST /:teamId/act returns updated state after applying action', () => {
  withApi(({ call }) => {
    const out = call('post', '/test/act', { action: { type: 'travel', to: 'r1' } });
    assert.equal(out.status, 200);
    assert.equal(out.body?.ok, true);
    assert.equal(out.body.state.turn, 1);
    assert.equal(out.body.state.phase, 'combat');
  });
});

test('R1.7: cleared room waystone connects room directly to camp at distance 1', () => {
  const s = { ...fresh(), fragments: ['r4'] };
  assert.equal(distance(s, 'camp', 'r4'), 1);
  assert.equal(distance(s, 'r4', 'camp'), 1);
});

// --- Round 2 ---

test('R2.1: Rune Altar adds +3 ATK and +3 DEF and deducts altar gold', () => {
  const s0 = { ...fresh(), gold: 100 };
  const s1 = step(s0, { type: 'altar', memberId: 'knight' });
  assert.equal(kael(s1).atk, kael(s0).atk + 3);
  assert.equal(kael(s1).def, kael(s0).def + 3);
  assert.equal(s1.gold, 100 - POWER_UPS.altar.gold);
});

test('R2.2: resting at camp restores Kael to full maxHp', () => {
  const s0 = fresh();
  kael(s0).hp = 20;
  const s1 = step(s0, { type: 'rest' });
  assert.equal(kael(s1).hp, kael(s1).maxHp);
});

test('R2.3: trading with Pip for a potion increments potions and deducts gold', () => {
  const s1 = step({ ...fresh(), gold: 100, potions: 1 }, { type: 'trade', item: 'potion' });
  assert.equal(s1.gold, 100 - PIP.potion.gold);
  assert.equal(s1.potions, 2);
});

test('R2.4: oracle isWise uses 0.5 threshold', () => {
  for (const p of [0, 0.1, 0.3, 0.49]) assert.equal(isWise(p), false);
  for (const p of [0.5, 0.8, 1]) assert.equal(isWise(p), true);
});

test('R2.5: shield absorbs incoming damage before HP is reduced', () => {
  const s = beginFight(fresh(), 'r1');
  kael(s).shield = 999;
  const startHp = kael(s).hp;
  const after = step(s, { type: 'defend' });
  assert.ok(kael(after).shield < 999);
  assert.equal(kael(after).hp, startHp);
});

test('R2.6: cage Weaponsmith restores full sword sharpness and durability', () => {
  const s0 = { ...fresh(), fragments: ['r1'], location: 'r1' };
  kael(s0).sword = { sharpness: 12, durability: 4 };
  const s1 = step(s0, { type: 'smith' });
  assert.equal(kael(s1).sword.sharpness, SWORD.sharpness);
  assert.equal(kael(s1).sword.durability, SWORD.durability);
});

test('R2.7: POST /:teamId/rewind reads target turn from request body', () => {
  withApi(({ call }) => {
    call('post', '/test/act', { action: { type: 'rest' } });
    const out = call('post', '/test/rewind', { to: 0 });
    assert.equal(out.status, 200);
    assert.equal(out.body?.ok, true);
    assert.equal(out.body.state.turn, 0);
  });
});

test('R2.8: enemy DEF scaling stays bounded as rooms are cleared', () => {
  for (const room of ['r2', 'r3', 'r4']) {
    const s = beginFight({ ...fresh(), stats: { ...fresh().stats, roomsCleared: 3 } }, room);
    for (const e of s.combat.enemies) {
      assert.ok(e.def <= Math.ceil(ENEMIES[e.kind].def * 1.3), `${room} ${e.kind} def=${e.def} too high`);
    }
  }
});

// --- Round 3 ---

test('R3.1: random forest predictions match exported scikit-learn check vectors', () => {
  const forest = loadForest();
  assert.ok(forest, 'route-forest.json should load');
  for (const { x, p } of forest.checks) {
    assert.ok(Math.abs(predictGood(forest, x) - p) < 1e-4);
  }
});

test('R3.2: decisionFeatures places torches and gold at their named feature indices', () => {
  const s = { ...fresh(), torches: 7, gold: 55, potions: 3 };
  const x = decisionFeatures(s, { type: 'rest' });
  assert.equal(x.length, FEATURE_NAMES.length);
  assert.equal(x[FEATURE_NAMES.indexOf('torches')], 7);
  assert.equal(x[FEATURE_NAMES.indexOf('gold')], 55);
  assert.equal(x[FEATURE_NAMES.indexOf('potions')], 3);
});

test('R3.3: cleanAction preserves lane field', () => {
  assert.equal(cleanAction({ type: 'wait', lane: 'left' }).lane, 'left');
  assert.equal(cleanAction({ type: 'attack', targetId: 'x', lane: 'right' }).lane, 'right');
});

// --- Round 4 ---

test('R4.1: saving and reloading a run with more than 40 actions preserves exact state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quest-long-'));
  try {
    const p = profile('long-run');
    const a = new QuestRuns({ profiles: [p], saveDir: dir });
    for (let i = 0; i < 70; i++) {
      const s = a.run('test').state;
      if (s.phase !== 'map' && s.phase !== 'combat') break;
      const opt = routeOptions(s).find((o) => o.fight) ?? routeOptions(s).find((o) => o.type === 'rest') ?? routeOptions(s)[0];
      a.act('test', s.phase === 'combat' ? { type: 'wait' } : { type: opt.type, to: opt.to, memberId: opt.memberId });
    }
    const b = new QuestRuns({ profiles: [p], saveDir: dir });
    assert.ok(a.run('test').state.turn > 40);
    assert.deepEqual(b.run('test').state, a.run('test').state);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R4.2: combat lane selection is deterministic across identical runs', () => {
  const play = () => {
    let s = beginFight(fresh(), 'r4', 1);
    for (let i = 0; i < 30 && s.phase === 'combat'; i++) s = step(s, { type: 'defend' });
    return JSON.stringify(s);
  };
  assert.equal(play(), play());
});

test('R4.3: Hollow King roar summons skeletons with distinct enemy IDs', () => {
  const s = beginFight(fresh(), 'r4', 1);
  const king = s.combat.enemies.find((e) => e.kind === 'hollow_king');
  king.hp = Math.floor(king.maxHp * 0.4);
  const after = step(s, { type: 'defend' });
  const ids = after.combat.enemies.map((e) => e.id);
  assert.ok(ids.length > 1);
  assert.equal(new Set(ids).size, ids.length);
});

// --- Round 5 ---

test('R5.1: defeating Morvath on the Throne transitions phase to victory', () => {
  const s = beginFight(fresh(), 'r5', ROOMS.r5.waves.length - 1);
  const morvath = s.combat.enemies.find((e) => e.ultimate);
  morvath.hp = 0;
  const after = step(s, { type: 'wait' });
  assert.equal(after.phase, 'victory');
  assert.equal(after.combat, null);
});

test('R5.2: Rune Strike cooldown ticks down to 0 for the controlled hero', () => {
  let s = beginFight(fresh(), 'r5', ROOMS.r5.waves.length - 1);
  const morvath = s.combat.enemies.find((e) => e.ultimate);
  s = step(s, { type: 'rune', targetId: morvath.id });
  for (let i = 0; i < 6 && s.phase === 'combat'; i++) s = step(s, { type: 'defend' });
  assert.ok(s.phase !== 'combat' || kael(s).runeCooldown === 0);
});

test('R5.3: defending halves Morvath Dragon Breath damage', () => {
  const s = beginFight(fresh(), 'r5', ROOMS.r5.waves.length - 1);
  const morvath = s.combat.enemies.find((e) => e.ultimate);
  Object.assign(morvath, { phase: 3, charged: true });
  s.combat.telegraph = { move: 'breath', name: MORVATH.moves.breath.name, targetId: null, damage: MORVATH.moves.breath.damage, all: true };
  kael(s).shield = 0;
  const hpBefore = kael(s).hp;
  const after = step(s, { type: 'defend' });
  assert.equal(hpBefore - kael(after).hp, Math.ceil(MORVATH.moves.breath.damage / 2));
});

test('R5.4: createRun sets leaderId to Kael hero id (knight)', () => {
  const s = fresh();
  assert.equal(s.leaderId, kael(s).id);
});
