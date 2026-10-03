import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useGetStateQuery, useSaveStateMutation } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { addObjection, claimLease, completeEvidence, describeOp, expireLease, heartbeat, hydrate, reorder, replay, resolveObjection, restore, selectEvidence, setMode, setOnline, setPhase, showEvidence, snapshot, tick, toggleSensitive } from "./store/courtSlice";
import type { Evidence, Party, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

/** 本设备是否持有有效租约（与 slice 判定一致） */
function useLeaseActive() {
  const state = useAppSelector((root) => root.court);
  return !!state.lease && state.lease.status === "有效" && state.lease.deviceId === state.deviceId && new Date(state.lease.expiresAt).getTime() > Date.now();
}

/** 控制权租约面板：设备按角色领取、心跳续约、超时回滚、候补接管 */
function LeaseCard() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const active = useLeaseActive();
  const lease = state.lease;
  return <Card title="控制权租约" extra={<Tag color={active ? "green" : "red"}>{active ? "本设备持有租约" : "本设备未持有租约"}</Tag>}>
    <div className="lease-grid">
      <span>本设备</span><b>{state.deviceId.slice(0, 8)}</b>
      <span>租约编号</span><b>{lease ? lease.leaseId.slice(0, 8) : "—"}</b>
      <span>角色</span><b>{lease?.role ?? "—"}</b>
      <span>接管序号</span><b>{lease?.seq ?? "—"}</b>
      <span>修订号</span><b>{lease?.revision ?? "—"}</b>
      <span>最近心跳</span><b>{lease ? new Date(lease.heartbeatAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</b>
      <span>到期时间</span><b>{lease ? new Date(lease.expiresAt).toLocaleTimeString("zh-CN", { hour12: false }) : "已回滚"}</b>
      <span>状态</span><Tag color={lease?.status === "有效" ? "green" : "red"}>{lease?.status ?? "已回滚"}</Tag>
    </div>
    <div className="control-strip">
      <Button size="small" onClick={() => dispatch(claimLease("书记员"))}>领取书记员租约</Button>
      <Button size="small" onClick={() => dispatch(claimLease("法官"))}>领取法官租约</Button>
      <Button size="small" onClick={() => dispatch(heartbeat())}>心跳续约</Button>
      <Button size="small" status="warning" onClick={() => dispatch(expireLease())}>模拟超时回滚</Button>
    </div>
  </Card>;
}

/** 待合并区：旧端操作停留于此，回网后按租约与修订号重放 */
function PendingCard() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const pending = state.pendingOps.filter((item) => item.status === "待合并");
  return <Card title="待合并区" extra={<Space><Tag color={pending.length ? "orange" : "green"}>{pending.length} 项待合并</Tag><Button size="small" onClick={() => dispatch(replay())}>重放待合并操作</Button></Space>}>
    {state.pendingOps.length === 0 && <p>待合并区为空。旧租约失效后，其证据目录操作将停留在此，回网时按租约与修订号重放。</p>}
    {state.pendingOps.map((op) => <div className="pending-op" key={op.opId}>
      <div><b>{describeOp(op)}</b><Tag size="small" color={op.leaseId === state.lease?.leaseId ? "green" : "orange"}>{op.leaseId === state.lease?.leaseId ? "本设备租约" : "旧租约"}</Tag><Tag size="small">修订 {op.revision}</Tag></div>
      <Tag color={op.status === "已合并" ? "green" : op.status === "已跳过" ? "gray" : "orange"}>{op.status}</Tag>
      {op.skipReason && <small className="skip-reason">{op.skipReason}</small>}
      <small>{new Date(op.createdAt).toLocaleTimeString("zh-CN", { hour12: false })}</small>
    </div>)}
  </Card>;
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const leaseActive = useLeaseActive();
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  return <div className="court-grid">
    <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
      {!leaseActive && <Alert className="lease-warn" type="warning" content="当前设备未持有有效租约：证据目录操作将进入待合并区，不会覆盖新控制端的顺序、展示状态与遮罩；回网后按租约与修订号重放。" />}
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span><div><b>{item.exhibitNo} · {item.title}</b><small>{item.type} · {item.presenter} · {item.duration}分钟</small></div><Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag><Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
      </article>)}</div>
      <div className="control-strip"><Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button><Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button><Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button><Button onClick={() => dispatch(toggleSensitive({ id: current?.id ?? "", sensitive: !current?.sensitive }))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button></div>
    </Card>
    <div className="side-stack">
      <LeaseCard />
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{value:"控制",label:"控制者视图"},{value:"预览",label:"公开屏"}]} />} className="preview-card">
        <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
      <PendingCard />
    </div>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p></div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive({ id: item.id, sensitive: !item.sensitive }))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data: persisted } = useGetStateQuery();
  const [save] = useSaveStateMutation();
  const { t, i18n } = useTranslation();
  useEffect(() => { if (persisted !== undefined) dispatch(hydrate(persisted)); }, [persisted, dispatch]);
  useEffect(() => { const timer = window.setTimeout(() => { if (state.initialized) void save({ deviceId: state.deviceId, evidence: state.evidence, objections: state.objections, timeline: state.timeline, snapshots: state.snapshots, session: state.session, lease: state.lease, leaseHistory: state.leaseHistory, pendingOps: state.pendingOps }); }, 300); return () => window.clearTimeout(timer); }, [state, save]);
  const metrics = useMemo(() => ({ shown: state.evidence.filter((item) => item.status === "已展示").length, sensitive: state.evidence.filter((item) => item.sensitive).length, objections: state.objections.length }), [state]);
  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools"><label>本地恢复 <Switch checked={!state.online} onChange={(value) => dispatch(setOnline(!value))} /></label><Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag></div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="异议记录" value={metrics.objections} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
