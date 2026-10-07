import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';

const { db } = await import('../src/utils/db.ts');
const { inspectAdvance, backfillRounds, advanceRound, AdvanceBlockedError } = await import(
  '../src/services/roundAdvance.ts'
);
const { newId } = await import('../src/utils/id.ts');

function makePlot(id: string, surveyRound?: number) {
  return {
    id,
    plotNo: id,
    locality: '测试地点',
    lng: 128,
    lat: 47,
    shape: '方形',
    area: 600,
    elevation: 400,
    slope: 8,
    aspect: '东南',
    forestType: '阔叶林',
    canopyDensity: 0.7,
    dominantSpecies: '蒙古栎',
    ...(surveyRound === undefined ? {} : { surveyRound }),
    surveyedAt: Date.now(),
    crew: '测试组',
    locked: false,
    createdAt: Date.now(),
  } as any;
}

function makeTree(plotId: string, treeNo: string, status: string, round?: number, dbh = 20) {
  return {
    id: newId('tree'),
    plotId,
    treeNo,
    species: '蒙古栎',
    dbhCm: dbh,
    heightM: 12,
    underBranchH: 4,
    crownWidth: 3,
    status,
    origin: '天然',
    healthClass: '健康',
    tiltDeg: 0,
    remark: '',
    ...(round === undefined ? {} : { round }),
    measuredAt: Date.now(),
  } as any;
}

test('推进：活立木/枯立木带最近胸径树高进入新期，采伐/倒木仅留旧期，旧期原样保存', async () => {
  const id = 'plot-a';
  const now = Date.now();
  await db.plots.add(makePlot(id, 1));
  await db.trees.bulkAdd([
    makeTree(id, '1', '活立木', 1, 10),
    makeTree(id, '2', '活立木', 1, 20),
    makeTree(id, '3', '枯立木', 1, 30),
    makeTree(id, '4', '采伐', 1, 40),
    makeTree(id, '5', '倒木', 1, 50),
  ]);
  await db.regens.add({
    id: newId('regen'),
    plotId: id,
    layer: '更新苗',
    species: '红松',
    heightCm: 30,
    count: 5,
    ageGroup: '1 年生',
    distribution: '均匀',
    browseDamage: '无',
    round: 1,
  } as any);
  await db.rechecks.add({
    id: newId('diff'),
    plotId: id,
    baseRound: 1,
    targetRound: 1,
    treeNo: '1',
    species: '蒙古栎',
    dbhGrowth: 0,
    heightGrowth: 0,
    statusChange: '',
    missingReason: '',
    generatedAt: now,
  } as any);

  const info = await inspectAdvance(id);
  assert.equal(info.carriedTrees.length, 3, '1/2/3 号立木带入新期');
  assert.equal(info.archivedTrees.length, 2, '4/5 号采伐倒木留档');
  assert.deepEqual(info.occupiedTreeNos, []);

  const result = await advanceRound(id);
  assert.equal(result.nextRound, 2);
  assert.equal(result.carriedCount, 3);
  assert.equal(result.archivedCount, 2);
  assert.equal(result.deletedRechecks, 1, '已保存逐株比对作废');

  const plot = await db.plots.get(id);
  assert.equal(plot!.surveyRound, 2);

  const round1 = await db.trees.where('plotId').equals(id).and((t) => t.round === 1).toArray();
  const round2 = await db.trees.where('plotId').equals(id).and((t) => t.round === 2).toArray();
  assert.equal(round1.length, 5, '旧期 5 条原值原样保存');
  assert.equal(round2.length, 3, '新期只有 3 株立木');
  assert.deepEqual(
    round2.map((t) => t.treeNo).sort(),
    ['1', '2', '3'],
  );
  const t1 = round2.find((t) => t.treeNo === '1')!;
  assert.equal(t1.dbhCm, 10, '带着最近胸径');
  assert.equal(t1.heightM, 12, '带着最近树高');
  assert.notEqual(t1.id, round1.find((t) => t.treeNo === '1')!.id, '新期是新行');
  assert.equal(t1.status, '活立木');
  assert.equal(round2.find((t) => t.treeNo === '3')!.status, '枯立木', '枯立木同样带入');

  // 新期能取到两期数据
  const rounds = Array.from(
    new Set((await db.trees.where('plotId').equals(id).toArray()).map((t) => t.round)),
  ).sort();
  assert.deepEqual(rounds, [1, 2]);
  assert.equal(await db.rechecks.where('plotId').equals(id).count(), 0, '比对记录已删除');
});

test('缺期次的老数据：预检拦截，回填后允许推进', async () => {
  const id = 'plot-b';
  await db.plots.add(makePlot(id)); // 无 surveyRound
  await db.trees.bulkAdd([
    makeTree(id, '1', '活立木'), // 无 round
    makeTree(id, '2', '活立木', 1),
  ]);
  await db.regens.add({
    id: newId('regen'),
    plotId: id,
    layer: '灌木',
    species: '榛子',
    heightCm: 80,
    count: 3,
    ageGroup: '多年生',
    distribution: '团状',
    browseDamage: '无',
  } as any);

  const info = await inspectAdvance(id);
  assert.ok(info.plotMissingRound);
  assert.equal(info.treesMissingRound, 1);
  assert.equal(info.regensMissingRound, 1);

  await assert.rejects(() => advanceRound(id), AdvanceBlockedError);

  const backfilled = await backfillRounds(id);
  assert.equal(backfilled.plot, 1);
  assert.equal(backfilled.trees, 1);
  assert.equal(backfilled.regens, 1);

  const info2 = await inspectAdvance(id);
  assert.equal(info2.currentRound, 1);
  assert.equal(info2.treesMissingRound, 0);
  assert.equal(info2.carriedTrees.length, 2);

  const result = await advanceRound(id);
  assert.equal(result.nextRound, 2);
  assert.equal(result.carriedCount, 2);
});

test('重复推进被拦截（下一期已有样木）', async () => {
  const id = 'plot-c';
  await db.plots.add(makePlot(id, 1));
  await db.trees.bulkAdd([makeTree(id, '1', '活立木', 1), makeTree(id, '1', '活立木', 2)]);
  const info = await inspectAdvance(id);
  assert.deepEqual(info.occupiedTreeNos, ['1']);
  await assert.rejects(() => advanceRound(id), AdvanceBlockedError);
});

test('推进事务失败时整体回滚，可原样重试', async () => {
  const id = 'plot-d';
  await db.plots.add(makePlot(id, 1));
  await db.trees.bulkAdd([makeTree(id, '1', '活立木', 1, 15)]);
  await db.rechecks.add({
    id: newId('diff'),
    plotId: id,
    baseRound: 1,
    targetRound: 1,
    treeNo: '1',
    species: '蒙古栎',
    dbhGrowth: 0,
    heightGrowth: 0,
    statusChange: '',
    missingReason: '',
    generatedAt: Date.now(),
  } as any);

  // 让事务在删除比对记录这一步失败（Collection.delete reject，Dexie 会回滚整个事务）
  const collProto = Object.getPrototypeOf(db.rechecks.toCollection());
  const originalDelete = collProto.delete;
  collProto.delete = () => Promise.reject(new Error('模拟存储故障'));

  await assert.rejects(() => advanceRound(id), /模拟存储故障/);
  collProto.delete = originalDelete;

  // 回滚：样地仍第 1 期、新期无树、比对仍在
  const plot = await db.plots.get(id);
  assert.equal(plot!.surveyRound, 1, '期次回滚');
  const trees = await db.trees.where('plotId').equals(id).toArray();
  assert.equal(trees.length, 1, '新期树行回滚');
  assert.equal(trees[0].round, 1);
  assert.equal(await db.rechecks.where('plotId').equals(id).count(), 1, '比对记录回滚');

  // 重试成功
  const result = await advanceRound(id);
  assert.equal(result.nextRound, 2);
  const plot2 = await db.plots.get(id);
  assert.equal(plot2!.surveyRound, 2);
  assert.equal(await db.trees.where('plotId').equals(id).count(), 2);
});

test('推进时以本期实测值带入新期', async () => {
  const id = 'plot-e';
  await db.plots.add(makePlot(id, 1));
  const t = makeTree(id, '1', '活立木', 1, 12.4);
  t.heightM = 13.6;
  await db.trees.add(t);

  const info = await inspectAdvance(id);
  assert.equal(info.carriedTrees[0].dbhCm, 12.4);

  await advanceRound(id);
  const round2 = await db.trees.where('plotId').equals(id).and((x) => x.round === 2).toArray();
  assert.equal(round2[0].dbhCm, 12.4, '带入最近胸径');
  assert.equal(round2[0].heightM, 13.6, '带入最近树高');
});
