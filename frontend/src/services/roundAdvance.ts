import { db } from '../utils/db';
import { newId } from '../utils/id';
import type { Plot } from '../types/plot';
import type { RegenShrub } from '../types/regen';
import type { TreeRecord, TreeStatus } from '../types/tree';

/** 随复查进入下一期的状态：仍立于样地上的活立木与枯立木 */
export const CARRIED_STATUSES: ReadonlySet<TreeStatus> = new Set(['活立木', '枯立木']);
/** 采伐与倒木已离开样地，只在旧期留档 */
export const ARCHIVED_STATUSES: ReadonlySet<TreeStatus> = new Set(['采伐', '倒木']);

export function isCarriedStatus(status: TreeStatus): boolean {
  return CARRIED_STATUSES.has(status);
}

export function isArchivedStatus(status: TreeStatus): boolean {
  return ARCHIVED_STATUSES.has(status);
}

export interface AdvancePreview {
  plot: Plot;
  /** 当前期次 */
  currentRound: number;
  /** 下一期待进入的期次 */
  nextRound: number;
  /** 本期活立木株数（含枯立木以外的立木口径见 carriedTrees） */
  aliveCount: number;
  /** 带入新期的立木（活立木 + 枯立木） */
  carriedTrees: TreeRecord[];
  /** 只在旧期留档的采伐木、倒木 */
  archivedTrees: TreeRecord[];
  /** 已存在的新期样木树号：说明该样地已经推进过下一期，不允许重复推进 */
  occupiedTreeNos: string[];
  /** 该样地已保存的逐株比对条数（推进后作废） */
  savedRecheckCount: number;
  /** 本期样木总数 */
  currentTreeCount: number;
}

export interface AdvanceInspection extends AdvancePreview {
  /** 推进前必须先回填期次的记录数 */
  treesMissingRound: number;
  regensMissingRound: number;
  plotMissingRound: boolean;
}

export class AdvanceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdvanceBlockedError';
  }
}

/** 同一树号取最近一次实测：优先 measuredAt，其次插入顺序（id 含时间戳） */
function latestByTreeNo(trees: TreeRecord[]): TreeRecord[] {
  const map = new Map<string, TreeRecord>();
  trees.forEach((tree) => {
    const prev = map.get(tree.treeNo);
    if (!prev || tree.measuredAt >= prev.measuredAt) map.set(tree.treeNo, tree);
  });
  return Array.from(map.values());
}

/**
 * 推进预检（只读）：
 * 1. 老样地存在没有期次的数据时，要求先回填；
 * 2. 下一期若已存在样木，阻止重复推进。
 */
export async function inspectAdvance(plotId: string): Promise<AdvanceInspection> {
  const plot = await db.plots.get(plotId);
  if (!plot) throw new AdvanceBlockedError('未找到该样地，可能已被删除');

  const plotTrees = await db.trees.where('plotId').equals(plotId).toArray();
  const plotRegens = await db.regens.where('plotId').equals(plotId).toArray();
  const recheckCount = await db.rechecks.where('plotId').equals(plotId).count();

  const treesMissingRound = plotTrees.filter((t) => typeof t.round !== 'number').length;
  const regensMissingRound = plotRegens.filter((r) => typeof r.round !== 'number').length;
  const plotMissingRound = typeof plot.surveyRound !== 'number';

  const currentRound = plot.surveyRound ?? 1;
  const nextRound = currentRound + 1;

  const currentTrees = plotTrees.filter((t) => (t.round ?? currentRound) === currentRound);
  const nextTrees = plotTrees.filter((t) => t.round === nextRound);

  // 下一期已存在树号即视为已推进过，阻止重复推进
  const occupiedTreeNos = Array.from(new Set(nextTrees.map((t) => t.treeNo))).sort((a, b) =>
    a.localeCompare(b, 'zh-Hans-CN', { numeric: true }),
  );

  const latest = latestByTreeNo(currentTrees);
  const carriedTrees = latest.filter((t) => isCarriedStatus(t.status));
  const archivedTrees = latest.filter((t) => isArchivedStatus(t.status));

  return {
    plot,
    currentRound,
    nextRound,
    aliveCount: latest.filter((t) => t.status === '活立木').length,
    carriedTrees,
    archivedTrees,
    occupiedTreeNos,
    savedRecheckCount: recheckCount,
    currentTreeCount: currentTrees.length,
    treesMissingRound,
    regensMissingRound,
    plotMissingRound,
  };
}

/** 老样地历史数据缺少期次时，先统一回填为第 1 期（同一事务） */
export async function backfillRounds(plotId: string): Promise<{
  plot: number;
  trees: number;
  regens: number;
}> {
  const result = { plot: 0, trees: 0, regens: 0 };
  await db.transaction('rw', db.plots, db.trees, db.regens, async () => {
    const plot = await db.plots.get(plotId);
    if (plot && typeof plot.surveyRound !== 'number') {
      await db.plots.update(plotId, { surveyRound: 1 });
      result.plot = 1;
    }
    await db.trees
      .where('plotId')
      .equals(plotId)
      .modify((tree: TreeRecord) => {
        if (typeof tree.round !== 'number') {
          tree.round = 1;
          result.trees += 1;
        }
      });
    await db.regens
      .where('plotId')
      .equals(plotId)
      .modify((regen: RegenShrub) => {
        if (typeof regen.round !== 'number') {
          regen.round = 1;
          result.regens += 1;
        }
      });
  });
  return result;
}

/** 由本期立木复制出新期待复测记录：带着最近胸径与树高，其余档案原样带上 */
function buildCarriedRecord(
  source: TreeRecord,
  plotId: string,
  nextRound: number,
  now: number,
): TreeRecord {
  return {
    ...source,
    id: newId('tree'),
    plotId,
    round: nextRound,
    dbhCm: source.dbhCm,
    heightM: source.heightM,
    measuredAt: now,
  };
}

export interface AdvanceResult {
  plotId: string;
  nextRound: number;
  carriedCount: number;
  archivedCount: number;
  deletedRechecks: number;
}

/**
 * 把样地从本期推进到下一期（单次收尾动作）。
 *
 * - 以本期实测为准：活立木、枯立木带着最近胸径与树高进入新期（生成待复测行）；
 * - 采伐与倒木不进入新期，只在旧期留档；
 * - 上一期原值原样保存，新期可同时取到两期数据做逐株比对；
 * - 期次一变，已保存的逐株比对结果作废删除（汇总本即实时计算，自动重算）。
 *
 * 全程单个 IndexedDB 事务，任一步失败整体回滚到推期前，调用方可以原样重试。
 */
export async function advanceRound(plotId: string): Promise<AdvanceResult> {
  const info = await inspectAdvance(plotId);
  if (info.plotMissingRound || info.treesMissingRound > 0 || info.regensMissingRound > 0) {
    throw new AdvanceBlockedError('存在没有期次的历史数据，请先回填期次后再推进');
  }
  if (info.occupiedTreeNos.length > 0) {
    throw new AdvanceBlockedError(
      `第 ${info.nextRound} 期已存在树号 ${info.occupiedTreeNos.join('、')} 的样木，请勿重复推进`,
    );
  }

  const now = Date.now();
  let deletedRechecks = 0;

  await db.transaction(
    'rw',
    db.plots,
    db.trees,
    db.regens,
    db.rechecks,
    async () => {
      // 事务内复核，避免预检之后被其他操作改写
      const occupied = await db.trees
        .where('plotId')
        .equals(plotId)
        .and((t) => t.round === info.nextRound)
        .count();
      if (occupied > 0) {
        throw new AdvanceBlockedError(`第 ${info.nextRound} 期已有样木，请勿重复推进`);
      }

      const carried = info.carriedTrees.map((tree) =>
        buildCarriedRecord(tree, plotId, info.nextRound, now),
      );
      if (carried.length > 0) await db.trees.bulkAdd(carried);

      await db.plots.update(plotId, {
        surveyRound: info.nextRound,
        surveyedAt: now,
      });

      deletedRechecks = await db.rechecks.where('plotId').equals(plotId).delete();
    },
  );

  return {
    plotId,
    nextRound: info.nextRound,
    carriedCount: info.carriedTrees.length,
    archivedCount: info.archivedTrees.length,
    deletedRechecks,
  };
}
