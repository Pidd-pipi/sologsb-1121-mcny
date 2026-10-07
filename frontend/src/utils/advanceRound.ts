import { db } from './db';
import { newId } from './id';
import type { TreeRecord, TreeStatus } from '../types/tree';

/** 推期结果摘要 */
export interface AdvanceResult {
  plotId: string;
  /** 推期前所在期次 */
  fromRound: number;
  /** 推进后的新期次 */
  toRound: number;
  /** 带入新期的样木数（活立木/枯立木，含最近胸径与树高） */
  carried: number;
  /** 仅在旧期留档的样木数（采伐/倒木） */
  archived: number;
  /** 回填期次的样木记录数 */
  backfilledTrees: number;
  /** 回填期次的样方记录数 */
  backfilledRegens: number;
  /** 作废的已保存逐株比对结果数 */
  invalidatedDiffs: number;
}

/** 仍立在样地上的状态才随推期进入下一期；采伐、倒木只在旧期留档 */
export const CARRY_FORWARD_STATUSES: TreeStatus[] = ['活立木', '枯立木'];

/** 期次是否有效（老档案里的数据可能缺期次） */
export function isValidRound(round: unknown): round is number {
  return typeof round === 'number' && Number.isFinite(round) && round >= 1;
}

/**
 * 把样地推进到下一期，一次事务收尾：
 * 1. 老数据缺期次的先回填到当前期，再允许推进；
 * 2. 以本期实测为准，活立木/枯立木带最近胸径、树高复制进新期，采伐/倒木只在旧期留档；
 * 3. 上一期原值照旧保存，新期与旧期并存，可直接取两期数据做逐株比对；
 * 4. 期次一变，已保存的逐株比对结果作废删除，林分汇总随期次自动重算。
 * 任一步失败整个事务回滚，数据回到推期前的样子，可重试。
 */
export async function advancePlotRound(plotId: string): Promise<AdvanceResult> {
  return db.transaction('rw', [db.plots, db.trees, db.regens, db.rechecks], async () => {
    const plot = await db.plots.get(plotId);
    if (!plot) throw new Error('样地不存在或已被删除');

    const trees = await db.trees.where('plotId').equals(plotId).toArray();
    const regens = await db.regens.where('plotId').equals(plotId).toArray();

    // 1) 回填期次：先定当前期（样地期次缺失时取数据中的最大期次），无期次数据归入当前期
    const knownRounds = [...trees, ...regens].map((r) => r.round).filter(isValidRound);
    const currentRound = isValidRound(plot.surveyRound)
      ? plot.surveyRound
      : knownRounds.length > 0
        ? Math.max(...knownRounds)
        : 1;

    let backfilledTrees = 0;
    trees.forEach((t) => {
      if (!isValidRound(t.round)) {
        t.round = currentRound;
        backfilledTrees += 1;
      }
    });
    let backfilledRegens = 0;
    regens.forEach((r) => {
      if (!isValidRound(r.round)) {
        r.round = currentRound;
        backfilledRegens += 1;
      }
    });

    // 2) 一致性校验：存在比当前期更新的数据说明期次已乱，拒绝推进（事务回滚）
    const futureRounds = trees.map((t) => t.round).filter((r) => r > currentRound);
    if (futureRounds.length > 0) {
      throw new Error(
        `检测到第 ${Math.max(...futureRounds)} 期的样木数据，晚于样地当前期次（第 ${currentRound} 期），请先核对期次后再推进`,
      );
    }

    // 3) 以本期实测为准：活立木/枯立木带最近胸径、树高进入新期；采伐/倒木仅留档本期
    const now = Date.now();
    const toRound = currentRound + 1;
    const currentTrees = trees.filter((t) => t.round === currentRound);
    const carriedTrees = currentTrees.filter((t) => CARRY_FORWARD_STATUSES.includes(t.status));
    const copies: TreeRecord[] = carriedTrees.map((t) => ({
      ...t,
      id: newId('tree'),
      round: toRound,
      measuredAt: now,
    }));

    // 4) 期次变更，已保存的逐株比对结果作废（林分汇总随期次自动重算）
    const invalidatedDiffs = await db.rechecks.where('plotId').equals(plotId).delete();

    if (backfilledTrees > 0) await db.trees.bulkPut(trees);
    if (backfilledRegens > 0) await db.regens.bulkPut(regens);
    if (copies.length > 0) await db.trees.bulkAdd(copies);
    await db.plots.update(plotId, { surveyRound: toRound, surveyedAt: now });

    return {
      plotId,
      fromRound: currentRound,
      toRound,
      carried: copies.length,
      archived: currentTrees.length - copies.length,
      backfilledTrees,
      backfilledRegens,
      invalidatedDiffs,
    };
  });
}
