import { useMemo, useState } from 'react';
import { Alert, Button, Modal, Space, Typography } from 'antd';
import { FastForwardOutlined } from '@ant-design/icons';
import type { Plot } from '../../types/plot';
import { useTreeStore } from '../../stores/treeStore';
import { useRegenStore } from '../../stores/regenStore';
import { db } from '../../utils/db';
import {
  advancePlotRound,
  isValidRound,
  CARRY_FORWARD_STATUSES,
  type AdvanceResult,
} from '../../utils/advanceRound';

export interface AdvanceRoundButtonProps {
  plot: Plot;
  /** 推进成功后回调（父组件负责刷新各 store） */
  onDone?: (result: AdvanceResult) => void;
}

/** 推进到下一期：弹窗确认推期后果，一次事务收尾，失败回滚可重试 */
export default function AdvanceRoundButton({ plot, onDone }: AdvanceRoundButtonProps) {
  const trees = useTreeStore((s) => s.items);
  const regens = useRegenStore((s) => s.items);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [diffCount, setDiffCount] = useState(0);

  const preview = useMemo(() => {
    const plotTrees = trees.filter((t) => t.plotId === plot.id);
    const plotRegens = regens.filter((r) => r.plotId === plot.id);
    const current = plotTrees.filter((t) => t.round === plot.surveyRound);
    const carried = current.filter((t) => CARRY_FORWARD_STATUSES.includes(t.status)).length;
    return {
      carried,
      archived: current.length - carried,
      regenCount: plotRegens.filter((r) => r.round === plot.surveyRound).length,
      missingTrees: plotTrees.filter((t) => !isValidRound(t.round)).length,
      missingRegens: plotRegens.filter((r) => !isValidRound(r.round)).length,
    };
  }, [trees, regens, plot.id, plot.surveyRound]);

  const needBackfill = preview.missingTrees + preview.missingRegens > 0 || !isValidRound(plot.surveyRound);

  const openModal = async () => {
    setError('');
    setOpen(true);
    setDiffCount(await db.rechecks.where('plotId').equals(plot.id).count());
  };

  const confirm = async () => {
    setLoading(true);
    setError('');
    try {
      const result = await advancePlotRound(plot.id);
      setOpen(false);
      onDone?.(result);
    } catch (e) {
      // 事务已整体回滚，数据保持推期前的样子，可直接重试
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button size="small" type="primary" ghost icon={<FastForwardOutlined />} onClick={() => void openModal()}>
        推进到下一期
      </Button>
      <Modal
        open={open}
        title={`推进期次 · ${plot.plotNo}`}
        okText={`确认推进到第 ${plot.surveyRound + 1} 期`}
        cancelText="再想想"
        confirmLoading={loading}
        onOk={() => void confirm()}
        onCancel={() => setOpen(false)}
      >
        <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
          {error ? (
            <Alert
              type="error"
              showIcon
              message="推进失败，数据已回滚到推期前的状态"
              description={`${error}。可修正后直接再次确认推进。`}
            />
          ) : null}
          {needBackfill ? (
            <Alert
              type="warning"
              showIcon
              message="检测到老数据缺少期次"
              description={`${preview.missingTrees} 条样木、${preview.missingRegens} 条样方记录将先回填为第 ${plot.surveyRound} 期，再推进。`}
            />
          ) : null}
          <Typography.Text>以第 {plot.surveyRound} 期实测为准，推进后：</Typography.Text>
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            <li>
              活立木/枯立木 <b>{preview.carried}</b> 株带最近胸径、树高进入第 {plot.surveyRound + 1} 期
            </li>
            <li>
              采伐/倒木 <b>{preview.archived}</b> 株只在第 {plot.surveyRound} 期留档，不进入新期
            </li>
            <li>第 {plot.surveyRound} 期原值照旧保存，新期可直接与旧期做逐株比对</li>
            <li>
              更新苗与灌木 <b>{preview.regenCount}</b> 条保留在第 {plot.surveyRound} 期，新期重新登记
            </li>
            <li>
              已保存的逐株比对结果 <b>{diffCount}</b> 条作废，林分汇总按新期次重算
            </li>
          </ul>
        </Space>
      </Modal>
    </>
  );
}
