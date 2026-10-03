import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useSaveCourtDocMutation, useGetCourtDocQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  acquireControl,
  addObjection,
  hydrate,
  releaseControl,
  resolveObjection,
  restore,
  setActiveDevice,
  setDeviceOnline,
  setDeviceRole,
  setMode,
  setPhase,
  snapshot,
  submitOp,
  tick,
  type CourtState
} from "./store/courtSlice";
import { selectLeaseView } from "./store/selectors";
import type { Role, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }
function toDoc(state: CourtState): Omit<CourtState, "initialized"> {
  const { initialized: _initialized, ...doc } = state;
  return doc;
}

function LeasePanel() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const view = useAppSelector((root) => selectLeaseView(root));
  const active = state.devices.find((device) => device.id === state.activeDeviceId);
  const holder = state.devices.find((device) => device.id === state.lease?.holderId);

  return <Card className="lease-card" title="控制权租约" extra={<Space><Tag color={view.alive ? "green" : "red"}>{view.alive ? `租约 epoch ${view.epoch}` : "租约空缺"}</Tag>{view.alive && holder && <Tag>{holder.label} 持有中 · 心跳 {Math.ceil(view.heartbeatRemainMs / 1000)}s</Tag>}</Space>}>
    <div className="device-list">
      {state.devices.map((device) => {
        const isHolder = state.lease?.holderId === device.id;
        const waitPos = state.waitlist.find((entry) => entry.deviceId === device.id)?.seq;
        return <div key={device.id} className={device.id === state.activeDeviceId ? "device-row active" : "device-row"}>
          <Space>
            <Radio checked={device.id === state.activeDeviceId} onChange={() => dispatch(setActiveDevice(device.id))}>{device.label}</Radio>
            {isHolder && view.alive && <Tag color="gold" size="small">持有者</Tag>}
            {waitPos !== undefined && <Tag color="arcoblue" size="small">候补 #{waitPos}</Tag>}
            {!device.online && <Tag color="red" size="small">断网</Tag>}
            {device.believedEpoch !== null && !isHolder && <Tag size="small">自认旧租约 {device.believedEpoch}</Tag>}
          </Space>
          <Space>
            <Select size="mini" value={device.role} style={{ width: 92 }} onChange={(value) => dispatch(setDeviceRole({ id: device.id, role: value as Role }))} options={[{ value: "书记员", label: "书记员" }, { value: "法官", label: "法官" }]} />
            <Switch size="small" checked={device.online} checkedText="在线" uncheckedText="断网" onChange={(value) => {
              dispatch(setDeviceOnline({ id: device.id, online: value }));
              Message.info(value ? `${device.label} 回网，开始重放待合并操作` : `${device.label} 断网，心跳将停止`);
            }} />
          </Space>
        </div>;
      })}
    </div>
    {active && <div className="lease-actions">
      <Space wrap>
        <Button size="small" type="primary" disabled={!active.online || (isHolderFor(state, active.id) && view.alive)} onClick={() => dispatch(acquireControl(active.id))}>领取 / 续租控制权</Button>
        <Button size="small" status="warning" disabled={state.lease?.holderId !== active.id} onClick={() => dispatch(releaseControl(active.id))}>释放并回滚租约</Button>
      </Space>
      {view.blockedReason && <Alert className="lease-alert" type={view.offlineHolder ? "warning" : "info"} content={view.blockedReason} />}
    </div>}
  </Card>;
}

function isHolderFor(state: CourtState, deviceId: string) {
  return state.lease?.holderId === deviceId;
}

const OP_LABEL_TEXT: Record<string, string> = {
  reorder: "调整证据顺序", select: "切换展示证据", show: "开始展示", complete: "完成质证", setSensitive: "设置敏感遮罩"
};

function PendingMergeCard() {
  const state = useAppSelector((root) => root.court);
  return <Card title="待合并区与重放审计" extra={<Tag color={state.pendingOps.length ? "orange" : "gray"}>{state.pendingOps.length} 条待合并</Tag>}>
    {state.pendingOps.length > 0 && <div className="pending-list">
      {state.pendingOps.map((op) => {
        const device = state.devices.find((item) => item.id === op.originDeviceId);
        const item = op.evidenceId ? state.evidence.find((entry) => entry.id === op.evidenceId) : undefined;
        return <div key={op.id} className="pending-row">
          <b>{OP_LABEL_TEXT[op.type]}{item ? ` · ${item.exhibitNo}` : ""}</b>
          <Space size={4}><Tag size="small">{device?.label}</Tag><Tag size="small" color={device?.online ? "green" : "red"}>{device?.online ? "已回网" : "断网中"}</Tag><Tag size="small">旧租约 {op.originEpoch}</Tag><Tag size="small">修订 {op.revision}</Tag></Space>
        </div>;
      })}
      <p className="hint">回网时按租约代号、修订号重放；同一证据已公开则跳过旧操作；遮罩开启先于展示生效。</p>
    </div>}
    <div className="merge-log">
      {state.mergeLog.slice(0, 8).map((entry) => <div key={entry.id} className={`merge-row ${entry.kind}`}>
        <Tag size="small" color={entry.kind === "merged" ? "green" : entry.kind === "skipped" ? "gray" : "arcoblue"}>{entry.kind === "merged" ? "已合并" : entry.kind === "skipped" ? "已跳过" : "租约"}</Tag>
        <span><b>{entry.action}</b> <small>{entry.detail} · {new Date(entry.time).toLocaleTimeString("zh-CN", { hour12: false })}</small></span>
      </div>)}
    </div>
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const view = useAppSelector((root) => selectLeaseView(root));
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  /** 证据目录操作门禁：在线持租约可实时生效；断网旧持有者仅进待合并区 */
  const gate = (): boolean => {
    if (view.canControl || view.offlineHolder) return true;
    Message.warning(view.blockedReason ?? "未持有控制权租约");
    return false;
  };
  const submit = (input: Parameters<typeof submitOp>[0]) => { if (gate()) { dispatch(submitOp(input)); if (view.offlineHolder) Message.info("旧租约操作已停在待合并区"); } };

  return <div className="control-wrap">
    <LeasePanel />
    <div className="court-grid">
      <Card className="operator" title="证据操作台" extra={<Space><Tag color={view.canControl ? "green" : view.offlineHolder ? "orange" : "red"}>{view.canControl ? "持有控制权" : view.offlineHolder ? "断网旧端 · 待合并" : "只读"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
        {view.blockedReason && <Alert className="lease-alert" type={view.offlineHolder ? "warning" : "error"} content={view.blockedReason} />}
        <div className={`evidence-list ${view.canControl || view.offlineHolder ? "" : "locked"}`}>{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          if (!gate()) return;
          const from = Number(event.dataTransfer.getData("text/plain"));
          const ids = state.evidence.map((entry) => entry.id);
          const [moved] = ids.splice(from, 1);
          ids.splice(index, 0, moved);
          submit({ type: "reorder", order: ids });
        }} className={current?.id === item.id ? "active" : ""}>
          <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => submit({ type: "select", evidenceId: item.id })}>选中</Button>
        </article>)}</div>
        <div className="control-strip"><Button type="primary" onClick={() => submit({ type: "show", evidenceId: current?.id })} disabled={!current}>开始展示</Button><Button onClick={() => submit({ type: "complete", evidenceId: current?.id })} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => submit({ type: "setSensitive", evidenceId: current?.id ?? "", value: !current?.sensitive })} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></div>
      </Card>
      <div className="side-stack">
        <PendingMergeCard />
        <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "控制", label: "控制者视图" }, { value: "预览", label: "公开屏" }]} />} className="preview-card">
          <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
        </Card>
        <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
      </div>
      <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>
      <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
    </div>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><div className="side-stack"><Card title="租约与重放审计">{state.mergeLog.map((entry) => <div key={entry.id} className={`merge-row ${entry.kind}`}><Tag size="small" color={entry.kind === "merged" ? "green" : entry.kind === "skipped" ? "gray" : "arcoblue"}>{entry.kind === "merged" ? "已合并" : entry.kind === "skipped" ? "已跳过" : "租约"}</Tag><span><b>{entry.action}</b><small>{entry.detail}</small></span></div>)}</Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div></div>;
}

function EvidencePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const view = useAppSelector((root) => selectLeaseView(root));
  const gate = (): boolean => {
    if (view.canControl || view.offlineHolder) return true;
    Message.warning(view.blockedReason ?? "未持有控制权租约");
    return false;
  };
  return <Card title="证据目录与公开属性" extra={<Tag color={view.canControl ? "green" : view.offlineHolder ? "orange" : "red"}>{view.canControl ? "持有控制权" : view.offlineHolder ? "断网旧端 · 待合并" : "只读"}</Tag>}><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} disabled={!view.canControl && !view.offlineHolder} onChange={(value) => { if (gate()) { dispatch(submitOp({ type: "setSensitive", evidenceId: item.id, value })); if (view.offlineHolder) Message.info("遮罩操作已停在待合并区，回网时先于展示重放"); } }} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data } = useGetCourtDocQuery();
  const [save] = useSaveCourtDocMutation();
  const { t, i18n } = useTranslation();

  useEffect(() => { dispatch(hydrate(data ?? null)); }, [data, dispatch]);
  useEffect(() => {
    if (!state.initialized) return;
    const timer = window.setTimeout(() => void save(toDoc(state)), 300);
    return () => window.clearTimeout(timer);
  }, [state, save]);

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);

  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  const activeDevice = state.devices.find((device) => device.id === state.activeDeviceId);

  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 控制权租约与全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>当前席位 {activeDevice?.label}（{activeDevice?.role}）</label><label>网络 <Switch checked={!!activeDevice?.online} disabled={!activeDevice} checkedText="在线" uncheckedText="断网" onChange={(value) => { if (activeDevice) { dispatch(setDeviceOnline({ id: activeDevice.id, online: value })); Message.info(value ? "回网：按租约与修订号重放待合并操作" : "断网：心跳停止，旧操作进入待合并区"); } }} /></label><Tag color={activeDevice?.online ? "green" : "orange"}>{activeDevice?.online ? "协作同步" : "离线操作"}</Tag></div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="待合并操作" value={state.pendingOps.length} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
