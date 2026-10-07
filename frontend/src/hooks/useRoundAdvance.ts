import { useCallback, useState } from 'react';
import { usePlotStore } from '../stores/plotStore';
import { useTreeStore } from '../stores/treeStore';
import { useRegenStore } from '../stores/regenStore';
import {
  advanceRound,
  backfillRounds,
  inspectAdvance,
  type AdvanceInspection,
  type AdvanceResult,
} from '../services/roundAdvance';

export interface RoundAdvanceApi {
  /** 最近一次预检结果 */
  inspection: AdvanceInspection | null;
  running: 'idle' | 'inspecting' | 'backfilling' | 'advancing';
  error: string;
  /** 打开推期弹窗时调用：读取当前样地的推进预检 */
  prepare: (plotId: string) => Promise<void>;
  /** 回填老数据缺失的期次，随后自动重新预检 */
  backfill: (plotId: string) => Promise<void>;
  /** 执行推期；失败不产生任何落库改动，可再次调用重试 */
  advance: (plotId: string) => Promise<AdvanceResult | null>;
  reset: () => void;
}

/** 推期动作编排：预检 → 回填 / 推进；每一步之后全量重载，保证界面与库一致 */
export function useRoundAdvance(): RoundAdvanceApi {
  const loadPlots = usePlotStore((s) => s.load);
  const loadTrees = useTreeStore((s) => s.load);
  const loadRegens = useRegenStore((s) => s.load);

  const [inspection, setInspection] = useState<AdvanceInspection | null>(null);
  const [running, setRunning] = useState<RoundAdvanceApi['running']>('idle');
  const [error, setError] = useState('');

  const reloadAll = useCallback(async () => {
    await Promise.all([loadPlots(), loadTrees(), loadRegens()]);
  }, [loadPlots, loadTrees, loadRegens]);

  const prepare = useCallback(
    async (plotId: string) => {
      setRunning('inspecting');
      setError('');
      try {
        const info = await inspectAdvance(plotId);
        setInspection(info);
      } catch (e) {
        setInspection(null);
        setError(e instanceof Error ? e.message : '预检失败，请重试');
      } finally {
        setRunning('idle');
      }
    },
    [],
  );

  const backfill = useCallback(
    async (plotId: string) => {
      setRunning('backfilling');
      setError('');
      try {
        await backfillRounds(plotId);
        await reloadAll();
        const info = await inspectAdvance(plotId);
        setInspection(info);
      } catch (e) {
        // 回填事务已整体回滚，界面数据仍是推期前的样子，允许重试
        setError(e instanceof Error ? e.message : '回填期次失败，请重试');
      } finally {
        setRunning('idle');
      }
    },
    [reloadAll],
  );

  const advance = useCallback(
    async (plotId: string) => {
      setRunning('advancing');
      setError('');
      try {
        const result = await advanceRound(plotId);
        await reloadAll();
        setInspection(null);
        return result;
      } catch (e) {
        // 事务保证：失败已整体回滚，重新拉取库内真实状态供用户重试
        await reloadAll();
        const info = await inspectAdvance(plotId).catch(() => null);
        setInspection(info);
        setError(e instanceof Error ? e.message : '推进失败，数据未改动，请重试');
        return null;
      } finally {
        setRunning('idle');
      }
    },
    [reloadAll],
  );

  const reset = useCallback(() => {
    setInspection(null);
    setError('');
    setRunning('idle');
  }, []);

  return { inspection, running, error, prepare, backfill, advance, reset };
}
