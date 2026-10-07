import { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Descriptions,
  Modal,
  Row,
  Col,
  Space,
  Spin,
  Statistic,
  Tag,
  Typography,
  message,
} from 'antd';
import { FastForwardOutlined } from '@ant-design/icons';
import { useRoundAdvance } from '../../hooks/useRoundAdvance';

export interface AdvanceRoundButtonProps {
  plotId: string;
  size?: 'small' | 'middle' | 'large';
  type?: 'primary' | 'default' | 'link' | 'dashed' | 'text';
  label?: string;
  /** 推进成功后回调（父级可切换期次、提示等） */
  onAdvanced?: (nextRound: number) => void;
}

/**
 * 「推进到下一期」入口与收尾确认：
 * 预检 → 缺期次则先回填 → 确认后事务化推进；失败可原样重试。
 */
export default function AdvanceRoundButton({
  plotId,
  size = 'small',
  type = 'default',
  label = '推进下一期',
  onAdvanced,
}: AdvanceRoundButtonProps) {
  const [open, setOpen] = useState(false);
  const { inspection, running, error, prepare, backfill, advance, reset } = useRoundAdvance();

  useEffect(() => {
    if (open) void prepare(plotId);
  }, [open, plotId, prepare]);

  const close = () => {
    if (running !== 'idle') return;
    setOpen(false);
    reset();
  };

  const missing =
    inspection?.plotMissingRound ||
    (inspection?.treesMissingRound ?? 0) > 0 ||
    (inspection?.regensMissingRound ?? 0) > 0;
  const occupied = (inspection?.occupiedTreeNos.length ?? 0) > 0;

  const confirmAdvance = async () => {
    const result = await advance(plotId);
    if (result) {
      message.success(
        `已推进到第 ${result.nextRound} 期：立木 ${result.carriedCount} 株带入新期待复测，` +
          `采伐/倒木 ${result.archivedCount} 株留档旧期，逐株比对已作废，请重算`,
      );
      setOpen(false);
      reset();
      onAdvanced?.(result.nextRound);
    }
  };

  const footer = (
    <Space>
      <Button onClick={close} disabled={running !== 'idle'}>
        取消
      </Button>
      {running === 'inspecting' ? null : !inspection ? (
        <Button type="primary" loading={running !== 'idle'} onClick={() => prepare(plotId)}>
          重新预检
        </Button>
      ) : missing ? (
        <Button type="primary" loading={running === 'backfilling'} onClick={() => backfill(plotId)}>
          回填为第 1 期
        </Button>
      ) : (
        <Button type="primary" loading={running === 'advancing'} disabled={occupied} onClick={confirmAdvance}>
          确认推进到第 {inspection.nextRound} 期
        </Button>
      )}
    </Space>
  );

  return (
    <>
      <Button
        size={size}
        type={type}
        icon={<FastForwardOutlined />}
        onClick={() => setOpen(true)}
        data-testid="advance-round-button"
      >
        {label}
      </Button>
      <Modal
        open={open}
        title={inspection ? `推进到下一期 · ${inspection.plot.plotNo}` : '推进到下一期'}
        onCancel={close}
        footer={footer}
        width={620}
        maskClosable={false}
      >
        {running === 'inspecting' ? (
          <Space style={{ padding: '32px 0', width: '100%', justifyContent: 'center' }}>
            <Spin tip="正在核对本期档案…" />
          </Space>
        ) : !inspection ? (
          <Alert type="error" showIcon message={error || '预检失败'} />
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {error ? <Alert type="error" showIcon message={error} /> : null}

            {missing ? (
              <Alert
                type="warning"
                showIcon
                message="该样地存在没有期次的老数据，必须先回填期次后才允许推进"
                description={
                  <Space direction="vertical" size={2}>
                    {inspection.plotMissingRound ? <span>· 样地档案缺少复查期次</span> : null}
                    {inspection.treesMissingRound > 0 ? (
                      <span>· 样木记录 {inspection.treesMissingRound} 条没有期次</span>
                    ) : null}
                    {inspection.regensMissingRound > 0 ? (
                      <span>· 更新苗/灌木样方 {inspection.regensMissingRound} 条没有期次</span>
                    ) : null}
                    <Typography.Text type="secondary">
                      回填将统一标注为第 1 期（可在样木录入页按期次核对后再推进）。
                    </Typography.Text>
                  </Space>
                }
              />
            ) : null}

            {occupied ? (
              <Alert
                type="error"
                showIcon
                message={`第 ${inspection.nextRound} 期已有样木（树号 ${inspection.occupiedTreeNos.join('、')}），不能重复推进`}
                description="如需重新推期，请先在样木录入页删除该期由上次推进生成的记录。"
              />
            ) : null}

            {!missing && inspection.carriedTrees.length === 0 ? (
              <Alert type="warning" showIcon message="本期没有可带入新期的立木，推进后新期样木清单为空，需全部重新登记" />
            ) : null}

            <Row gutter={8}>
              <Col span={6}>
                <Statistic title="本期" value={inspection.currentRound} prefix="第" suffix="期" />
              </Col>
              <Col span={6}>
                <Statistic title="推进到" value={inspection.nextRound} prefix="第" suffix="期" />
              </Col>
              <Col span={6}>
                <Statistic title="带入新期待复测" value={inspection.carriedTrees.length} suffix="株" />
              </Col>
              <Col span={6}>
                <Statistic title="旧期留档" value={inspection.archivedTrees.length} suffix="株" />
              </Col>
            </Row>

            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="立木带入新期">
                <Tag color="green">活立木 {inspection.aliveCount} 株</Tag>
                <Tag color="orange">枯立木 {inspection.carriedTrees.length - inspection.aliveCount} 株</Tag>
                <Typography.Text type="secondary">带着最近胸径、树高生成待复测行</Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="采伐 / 倒木">
                {inspection.archivedTrees.length} 株只在第 {inspection.currentRound} 期留档，不进入新期
              </Descriptions.Item>
              <Descriptions.Item label="旧期原值">
                第 {inspection.currentRound} 期记录原样保存，新期可同时选两期做逐株比对
              </Descriptions.Item>
              <Descriptions.Item label="逐株比对 / 汇总">
                已保存比对结果 {inspection.savedRecheckCount} 条随期次作废删除；汇总结果按新期实时重算
              </Descriptions.Item>
            </Descriptions>
          </Space>
        )}
      </Modal>
    </>
  );
}
