import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';

// 使用独立的 IDBFactory，确保从空库开始
(globalThis as any).indexedDB = new IDBFactory();

// v2 → v3 迁移：先手工建一个 v2 库，灌入缺少 round 的老 regen，再用现版代码打开触发升级
test('v2 → v3 升级：为缺少期次的老样木/样方/样地补第 1 期', async () => {
  const idb = new IDBFactory();
  (globalThis as any).indexedDB = idb;

  const DB_NAME = 'gbforestplot';

  // 1) 按 v2 结构建库（带 v2 的 upgrade：补 locked / surveyRound / trees.round / measuredAt）
  await new Promise<void>((resolve, reject) => {
    const req = idb.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const database = req.result;
      database.createObjectStore('plots', { keyPath: 'id' }).createIndex('surveyRound', 'surveyRound');
      const treeStore = database.createObjectStore('trees', { keyPath: 'id' });
      treeStore.createIndex('plotId', 'plotId');
      treeStore.createIndex('round', 'round');
      const regenStore = database.createObjectStore('regens', { keyPath: 'id' });
      regenStore.createIndex('plotId', 'plotId');
      regenStore.createIndex('round', 'round');
      const recheckStore = database.createObjectStore('rechecks', { keyPath: 'id' });
      recheckStore.createIndex('plotId', 'plotId');
    };
    req.onsuccess = () => {
      req.result.close();
      resolve();
    };
    req.onerror = () => reject(req.error);
  });

  // 2) 灌入老数据：plot 无 surveyRound、tree 无 round、regen 无 round
  await new Promise<void>((resolve, reject) => {
    const req = idb.open(DB_NAME, 2);
    req.onsuccess = () => {
      const database = req.result;
      const tx = database.transaction(['plots', 'trees', 'regens'], 'readwrite');
      tx.objectStore('plots').put({ id: 'p1', plotNo: 'OLD-1', area: 600, canopyDensity: 0.6 });
      tx.objectStore('trees').put({ id: 't1', plotId: 'p1', treeNo: '1', dbhCm: 20, status: '活立木' });
      tx.objectStore('regens').put({ id: 'r1', plotId: 'p1', layer: '更新苗', count: 5 });
      tx.oncomplete = () => {
        database.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });

  // 3) 用现版代码（v3）打开，触发 upgrade
  const { db } = await import('../src/utils/db.ts');
  assert.equal(db.verno, 3);

  const plot = await db.plots.get('p1');
  assert.equal(plot?.surveyRound, 1, '样地期次回填为 1');
  const tree = await db.trees.get('t1');
  assert.equal(tree?.round, 1, '样木期次回填为 1');
  const regen = await db.regens.get('r1');
  assert.equal(regen?.round, 1, '样方期次回填为 1');
});
