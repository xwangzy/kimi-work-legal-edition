/**
 * IM 运行时（firm-node 侧，方案 §11.2/§9/§6.3）：连接器选主、收文件入事项的对话流、
 * IM 确认（节点见证签名）、数据去向记录、离线行为如实计数。
 *
 * 红线落实：
 * - 唯一消费者：启动前取 im_connector_lease 租约（企业微信单连接语义；飞书/钉钉双活属 G1 声明）；
 * - 卡片动作校验 actorImId 绑定与事项权限——未绑定用户点卡片一律拒绝（群转发不扩权）；
 *   审批动作（确认/退回）只允许该审批意向的目标签发人本人，校验先于应答（非本人不得得到「已收到」）；
 * - 卡片只列已授权节点的事项（strict/伦理墙不入列）；文案脱敏：不含客户名称与案情（事项标题也不上卡）；
 * - 高敏事项 IM 零文件；IM 确认只用于 internal/client 受众与已授权事项；
 * - 收发全部写数据去向记录（文件名、hash、对象哈希化、平台）。
 *
 * 卡片文案纪律（三类卡片统一）：卡片内容永不含事项标题与客户名；文件名由发送人提供、
 * 可能含当事人名——只在单聊中对本人（选项/回执卡）或签发人（审批卡）展示；
 * 当前没有群卡片路径（群消息只回引导语、不回显文件名），若未来支持群卡片，一律不得展示文件名。
 *
 * v0 简化（如实注释）：卡片选择窗口内文件字节存内存（进程重启则该次投递失效，请重新发送——
 * 生产为意向表持久化 + 临时密文块，G1）；真实平台凭据与联调属部署工作。
 */
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { b64urlDecode, canonicalJson, sha256B64, signBytes } from "@zr-legal/keys";
import { recordImEgress, type LedgerSigner } from "@zr-legal/kernel/ledger-signer";
import { getDeviceKeys, keysDirOf } from "@zr-legal/kernel";
import { DingtalkStreamConnector, type ImCard, type ImConnector, type ImFileMessage, type ImPlatform } from "@zr-legal/im-connectors";
import type { Kernel } from "@zr-legal/kernel";

export interface ImRuntimeConfig {
  platform: ImPlatform;
  endpoint: string;
  appKey?: string;
  appSecret?: string;
}

export interface ImRuntimeHandle {
  connector: ImConnector;
  stop(): Promise<void>;
  /** 节点 tick 调用：处理 approval_request 意向。 */
  processApprovals(): Promise<void>;
  status(): Record<string, unknown>;
}

interface IntentRow {
  intent_id: string;
  kind: string;
  platform: string;
  status: string;
  payload: string;
  created_by: string;
}

/** 连接器选主租约（企业微信单连接语义；另一活连接器持租约时拒绝启动）。 */
export function claimImLease(db: Kernel["db"], platform: string, owner: string, leaseMs: number): boolean {
  const now = new Date().toISOString();
  const until = new Date(Date.now() + leaseMs).toISOString();
  const r = db.run(
    `INSERT INTO im_connector_lease (platform, owner, lease_until, updated_at) VALUES (?,?,?,?)
     ON CONFLICT(platform) DO UPDATE SET owner = excluded.owner, lease_until = excluded.lease_until, updated_at = excluded.updated_at
     WHERE im_connector_lease.owner = ? OR im_connector_lease.lease_until < ?`,
    [platform, owner, until, now, owner, now],
  );
  return r.changes === 1;
}

export async function startImRuntime(kernel: Kernel, cfg: ImRuntimeConfig, deps: { leaseMs?: number } = {}): Promise<ImRuntimeHandle> {
  const db = kernel.db;
  const signer: LedgerSigner = kernel.signer;
  const tenantId = kernel.identity.tenantId;
  const owner = `firm-node:im:${process.pid}`;
  if (!claimImLease(db, cfg.platform, owner, deps.leaseMs ?? 60_000)) {
    throw new Error(`另一活连接器已持有 ${cfg.platform} 租约（唯一消费者语义：企业微信单连接；飞书/钉钉双活属 G1）`);
  }

  const connector = new DingtalkStreamConnector({
    endpoint: cfg.endpoint,
    ...(cfg.appKey !== undefined ? { appKey: cfg.appKey } : {}),
    ...(cfg.appSecret !== undefined ? { appSecret: cfg.appSecret } : {}),
  });
  const offlineEvents: { kind: string; detail: string; at: string }[] = [];
  /** 卡片选择窗口内的文件字节暂存（v0 内存形态；重启失效请重新发送）。 */
  const staging = new Map<string, { msg: ImFileMessage; intentId: string }>();
  const recentCards = new Map<string, { cardId: string }>();

  const memberOf = (imUserId: string): string | null => {
    const r = db.get<{ member_id: string }>(`SELECT member_id FROM im_bindings WHERE tenant_id = ? AND platform = ? AND im_user_id = ?`, [tenantId, cfg.platform, imUserId]);
    return r?.member_id ?? null;
  };

  const authorizedMattersFor = (memberId: string): { matter_id: string }[] => {
    // 卡片只列「已授权节点的」事项（strict/伦理墙不入列；成员有效（墓碑过滤））
    return db.all<{ matter_id: string }>(
      `SELECT m.matter_id FROM matters m
         JOIN matter_members mm ON mm.matter_id = m.matter_id AND mm.user_id = ? AND mm.removed_at IS NULL
       WHERE m.tenant_id = ? AND m.status = 'active' AND m.node_allowed = 1 AND m.confidentiality != 'strict'
       ORDER BY m.created_at DESC LIMIT 3`,
      [memberId, tenantId],
    );
  };

  async function replyText(toImId: string, text: string): Promise<void> {
    await connector.sendCard(toImId, { title: "Kimi Work 法律助手", fields: [{ label: "回复", value: text }] });
  }

  async function onFileMessage(msg: ImFileMessage): Promise<void> {
    if (msg.chatType !== "direct") {
      await replyText(msg.senderImId, "请在单聊中发送文件（企业微信只能单聊收文件、飞书外部群拿不到文件）。");
      return;
    }
    const memberId = memberOf(msg.senderImId);
    if (!memberId) {
      await replyText(msg.senderImId, "您的 IM 账号未绑定律所成员：请管理员在桌面客户端 im.bind 后再发送（机器人只供律所内部人员使用）。");
      return;
    }
    const matters = authorizedMattersFor(memberId);
    // 入站数据去向记录（文件名、hash、对象哈希化、平台；事项归属以「待选择」标注在最近候选上）
    const inboxMatter = matters[0]?.matter_id ?? "mat_im_inbox";
    recordImEgress(db, signer, { tenantId, matterId: inboxMatter, kind: "im_inbound", platform: cfg.platform, filename: msg.filename, bytes: msg.bytes, peerImId: msg.senderImId });
    if (matters.length === 0) {
      await replyText(msg.senderImId, "没有可投递的已授权事项：strict/伦理墙事项请在桌面客户端处理。");
      return;
    }
    const intentId = `imi_${randomUUID()}`;
    db.run(`INSERT INTO im_intents (intent_id, tenant_id, kind, platform, status, payload, created_by) VALUES (?,?,?,?,'awaiting_choice',?,?)`, [
      intentId,
      tenantId,
      "file_inbound",
      cfg.platform,
      JSON.stringify({ filename: msg.filename, mime: msg.mime, size: msg.bytes.length, sender_im_id: msg.senderImId, member_id: memberId, message_id: msg.messageId, candidates: matters.map((m) => m.matter_id) }),
      memberId,
    ]);
    staging.set(intentId, { msg, intentId });
    const actions = matters.map((m, i) => ({ actionId: `choose:${intentId}:${m.matter_id}`, text: `事项 ${i + 1} · ${m.matter_id.slice(4, 12)}` }));
    // 卡片文案脱敏：事项以序号+短 ID 呈现，不含标题/客户名/案情
    const card = await connector.sendCard(msg.senderImId, {
      title: "选择投递事项",
      fields: [
        { label: "文件", value: `${msg.filename}（${(msg.bytes.length / 1024).toFixed(0)} KB）` },
        { label: "来源", value: `单聊 · 已绑定成员（im:${sha256B64(msg.senderImId).slice(0, 8)}）` },
      ],
      actions: [...actions, { actionId: `cancel:${intentId}`, text: "取消投递" }],
      note: "只显示已授权节点的事项；其余事项请在桌面客户端处理。",
    });
    recentCards.set(intentId, card);
  }

  async function onCardAction(action: { actionId: string; actorImId: string; payload: Record<string, unknown>; respondWithinMs: number; respond: (text: string) => Promise<void> }): Promise<void> {
    const actorMember = memberOf(action.actorImId);
    // 群转发不扩权：未绑定用户点卡片一律拒绝
    if (!actorMember) {
      await action.respond("未绑定成员，操作无效");
      return;
    }
    const [verb, intentId, matterId] = action.actionId.split(":");
    const intent = intentId ? (db.get<IntentRow>(`SELECT * FROM im_intents WHERE intent_id = ?`, [intentId]) ?? null) : null;
    if (verb === "cancel" && intent && intentId) {
      db.run(`UPDATE im_intents SET status = 'rejected', result = ?, updated_at = ? WHERE intent_id = ?`, ["用户取消", new Date().toISOString(), intentId]);
      staging.delete(intentId);
      await action.respond("已取消投递");
      return;
    }
    if (verb === "choose" && intent && intentId && matterId) {
      const staged = staging.get(intentId);
      if (!staged) {
        await action.respond("该次投递已失效（进程重启或已处理），请重新发送文件");
        return;
      }
      if (staged.msg.senderImId !== action.actorImId) {
        await action.respond("只有发送者本人能选择投递事项（群转发不扩权）");
        return;
      }
      await action.respond("已收到，正在入库并派发任务"); // 2 秒内同步应答
      db.run(`UPDATE im_intents SET status = 'processing', payload = json_set(payload, '$.matter_id', ?), updated_at = ? WHERE intent_id = ?`, [matterId, new Date().toISOString(), intentId]);
      try {
        const imp = (await kernel.invoke("materials.import", {
          matter_id: matterId,
          filename: staged.msg.filename,
          mime: staged.msg.mime,
          data_base64: staged.msg.bytes.toString("base64"),
        })) as any;
        const enq = (await kernel.invoke("runs.node_enqueue", {
          matter_id: matterId,
          scenario: "s1.contract_review",
          input: { document_version_ids: [imp.document_version_id] },
          idempotency_key: `im-${intentId}`,
        })) as any;
        db.run(`UPDATE im_intents SET status = 'done', result = ?, updated_at = ? WHERE intent_id = ?`, [
          JSON.stringify({ matter_id: matterId, document_version_id: imp.document_version_id, task_id: enq.task_id }),
          new Date().toISOString(),
          intentId,
        ]);
        // 回执卡片（脱敏：只报进度事实，不含案情；文件名由发送人提供、仅单聊对本人展示——见文件头卡片文案纪律）
        await connector.sendCard(staged.msg.senderImId, {
          title: "已收到并派发",
          fields: [
            { label: "文件", value: staged.msg.filename },
            { label: "状态", value: "已入库，任务已转交节点执行（完成后请在桌面查看结果）" },
          ],
          note: "本通知按脱敏口径发送，不含客户名称与案情。",
        });
      } catch (e) {
        db.run(`UPDATE im_intents SET status = 'rejected', result = ?, updated_at = ? WHERE intent_id = ?`, [(e as Error)?.message ?? String(e), new Date().toISOString(), intent.intent_id]);
        await replyText(staged.msg.senderImId, `入库失败：${(e as Error)?.message ?? e}`);
      } finally {
        staging.delete(intentId);
      }
      return;
    }
    if (verb === "confirm" && intent) {
      const payload = JSON.parse(intent.payload || "{}") as { issuer_member_id?: string };
      // 先做签发人校验再应答：非签发人点确认不得得到「已收到」（与 confirm 落库内复核同口径）
      if (actorMember !== payload.issuer_member_id) {
        await action.respond("仅签发人本人可操作");
        return;
      }
      await action.respond("已收到"); // 先同步应答（2 秒硬限语义），结果异步落库后更新卡片
      void handleApprovalConfirm(intent, action.actorImId, actorMember).catch(async (e) => {
        // 异步落库失败必须可观测：意向如实标记 + 审计事件上链 + 卡片如实更新
        const msg = ((e as Error)?.message ?? String(e)).slice(0, 500);
        db.run(`UPDATE im_intents SET status = 'rejected', result = ?, updated_at = ? WHERE intent_id = ?`, [`IM 确认落库失败：${msg}`, new Date().toISOString(), intent.intent_id]);
        signer.append({ kind: "audit_event", refId: intent.intent_id, matterId: null, type: "im.confirm_failed", payloadHash: sha256B64(msg) });
        const cardId = (JSON.parse(intent.payload || "{}") as { intent_im_card_id?: string }).intent_im_card_id;
        if (cardId) {
          await connector
            .updateCard({ cardId }, { title: "签发确认未完成", fields: [{ label: "结果", value: "确认落库失败，请在桌面客户端复核后重试" }], note: "本通知按脱敏口径发送，不含客户名称与案情。" })
            .catch(() => {});
        }
      });
      return;
    }
    if (verb === "reject" && intent) {
      const payload = JSON.parse(intent.payload || "{}") as { issuer_member_id?: string };
      // 与 confirm 同口径：退回也只允许该审批意向的目标签发人本人（任何绑定成员不得退回他人审批意向）
      if (actorMember !== payload.issuer_member_id) {
        await action.respond("仅签发人本人可操作");
        return;
      }
      db.run(`UPDATE im_intents SET status = 'rejected', result = ?, updated_at = ? WHERE intent_id = ?`, [`签发人拒绝（IM）`, new Date().toISOString(), intentId]);
      await action.respond("已记录退回");
      return;
    }
    await action.respond("未知操作");
  }

  async function handleApprovalConfirm(intent: IntentRow, actorImId: string, actorMember: string): Promise<void> {
    const payload = JSON.parse(intent.payload || "{}") as { artifact_version_id: string; audience: string; issuer_member_id: string; artifact_sha256: string; intent_im_card_id?: string };
    if (actorMember !== payload.issuer_member_id) return; // 纵深复核（onCardAction 已在应答前校验；非本人根本到不了这里）
    const art = db.get<any>(`SELECT * FROM artifact_versions WHERE artifact_version_id = ?`, [payload.artifact_version_id]);
    if (!art) {
      db.run(`UPDATE im_intents SET status = 'rejected', result = '成果版本不存在，IM 确认无效', updated_at = ? WHERE intent_id = ?`, [new Date().toISOString(), intent.intent_id]);
      return;
    }
    // 复核资产 hash（确认的是哪个文件 hash，防调包；artifact_sha256 为 hex 口径）
    const bytes = kernel.blobs.read(String(art.storage_uri));
    if (createHash("sha256").update(bytes).digest("hex") !== payload.artifact_sha256) {
      db.run(`UPDATE im_intents SET status = 'rejected', result = '文件 hash 已变化，IM 确认无效', updated_at = ? WHERE intent_id = ?`, [new Date().toISOString(), intent.intent_id]);
      return;
    }
    const approvalId = `apr_${randomUUID()}`;
    const epoch = (db.get<{ e: number | null }>(`SELECT MAX(epoch) AS e FROM key_epochs WHERE scope = 'tenant' AND scope_id = ?`, [tenantId]))?.e ?? 1;
    const signedPayload = canonicalJson({
      approval_id: approvalId,
      artifact_version_id: payload.artifact_version_id,
      artifact_sha256: payload.artifact_sha256,
      audience: payload.audience,
      assurance_level: "im_witnessed",
      witness: {
        confirmer_member_id: payload.issuer_member_id,
        confirmer_im_id_hash: sha256B64(actorImId).slice(0, 16),
        confirmed_at: new Date().toISOString(),
        node_device_id: kernel.signer.deviceId,
        note: "IM 确认（节点见证）：节点服务密钥签名记录「谁在何时确认了哪个文件 hash」，低于设备签名",
      },
      key_epoch: epoch,
    });
    const nodeKeys = getDeviceKeys(keysDirOf(kernel.config.workspaceDir));
    const signature = signBytes(nodeKeys.signPrivateKeyPem, new TextEncoder().encode(signedPayload));
    const completenessHash = sha256B64(canonicalJson({ via: "im_witnessed", intent_id: intent.intent_id }));
    db.tx(() => {
      db.run(
        `INSERT INTO approvals (approval_id, artifact_version_id, artifact_sha256, approver_id, decision, audience, assurance_level, checklist, signer_device_id, signature, completeness_hash, key_epoch, signed_payload)
         VALUES (?,?,?,?,'approved',?,'im_witnessed','{}',?,?,?,?,?)`,
        [approvalId, payload.artifact_version_id, payload.artifact_sha256, payload.issuer_member_id, payload.audience, kernel.signer.deviceId, signature, completenessHash, epoch, signedPayload],
      );
      db.run(`UPDATE artifact_versions SET status = 'approved' WHERE artifact_version_id = ?`, [payload.artifact_version_id]);
      db.run(`UPDATE im_intents SET status = 'done', result = ?, updated_at = ? WHERE intent_id = ?`, [JSON.stringify({ approval_id: approvalId }), new Date().toISOString(), intent.intent_id]);
      signer.append({ kind: "approval", refId: approvalId, matterId: art.matter_id, type: "approval.im_witnessed", payloadHash: sha256B64(signedPayload) });
    });
    // 更新卡片（结果异步落账本后）
    if (payload.intent_im_card_id) {
      await connector.updateCard({ cardId: payload.intent_im_card_id }, {
        title: "签发已记录（IM 确认）",
        fields: [{ label: "结果", value: `已确认 ${payload.artifact_sha256.slice(0, 12)}…（节点见证签名，assurance_level=im_witnessed）` }],
        note: "该保证等级低于设备签名；法院版/对方版必须设备签名。",
      });
    }
  }

  async function processApprovals(): Promise<void> {
    const rows = db.all<IntentRow>(`SELECT * FROM im_intents WHERE kind = 'approval_request' AND status = 'pending' ORDER BY created_at LIMIT 10`, []);
    for (const intent of rows) {
      const payload = JSON.parse(intent.payload || "{}") as { artifact_version_id: string; audience: string; issuer_member_id: string; artifact_sha256: string };
      const art = db.get<any>(`SELECT * FROM artifact_versions WHERE artifact_version_id = ?`, [payload.artifact_version_id]);
      const matter = art ? db.get<any>(`SELECT node_allowed, confidentiality FROM matters WHERE matter_id = ?`, [art.matter_id]) : null;
      // 处理前硬门禁复核（授权撤销/strict 一律拒）
      if (!art || !matter || matter.node_allowed !== 1 || matter.confidentiality === "strict" || !["internal", "client"].includes(payload.audience)) {
        db.run(`UPDATE im_intents SET status = 'rejected', result = '授权或受众门禁复核未过', updated_at = ? WHERE intent_id = ?`, [new Date().toISOString(), intent.intent_id]);
        continue;
      }
      const binding = db.get<{ im_user_id: string }>(`SELECT im_user_id FROM im_bindings WHERE tenant_id = ? AND platform = ? AND member_id = ?`, [tenantId, cfg.platform, payload.issuer_member_id]);
      if (!binding) {
        db.run(`UPDATE im_intents SET status = 'rejected', result = '签发人未绑定 IM', updated_at = ? WHERE intent_id = ?`, [new Date().toISOString(), intent.intent_id]);
        continue;
      }
      // 先把确切待交付文件单独发给签发人（§6.3：签发必须先看到完整文件）
      const bytes = kernel.blobs.read(String(art.storage_uri));
      await connector.sendFile(binding.im_user_id, { filename: String(art.filename), bytes, mime: "application/octet-stream" });
      recordImEgress(db, signer, { tenantId, matterId: art.matter_id, kind: "im_outbound", platform: cfg.platform, filename: String(art.filename), bytes, peerImId: binding.im_user_id, note: "审批投递（确切待交付文件）" });
      const card = await connector.sendCard(binding.im_user_id, {
        // 审批卡脱敏纪律：不含事项标题/客户名；文件名可能含当事人名，只在单聊对签发人本人展示（见文件头卡片文案纪律）
        title: "签发确认（IM 确认，低于设备签名）",
        fields: [
          { label: "文件", value: `${String(art.filename)}` },
          { label: "hash", value: `${String(art.sha256).slice(0, 16)}…` },
          { label: "受众", value: payload.audience === "client" ? "客户版" : "内部稿" },
        ],
        actions: [
          { actionId: `confirm:${intent.intent_id}`, text: "确认签发（IM 确认）" },
          { actionId: `reject:${intent.intent_id}`, text: "退回" },
        ],
        note: "确认即代表您已查看上方完整文件；法院版/对方版必须到电脑上设备签名。",
      });
      recordImEgress(db, signer, { tenantId, matterId: art.matter_id, kind: "im_outbound", platform: cfg.platform, filename: `approval-card-${intent.intent_id}`, bytes: Buffer.from(String(art.sha256)), peerImId: binding.im_user_id, note: "审批卡片" });
      db.run(`UPDATE im_intents SET status = 'awaiting_choice', payload = json_set(payload, '$.intent_im_card_id', ?), updated_at = ? WHERE intent_id = ?`, [card.cardId, new Date().toISOString(), intent.intent_id]);
      recentCards.set(intent.intent_id, card);
    }
  }

  await connector.start({
    onFileMessage: (msg) => void onFileMessage(msg),
    onCardAction: (action) => void onCardAction(action),
    onOfflineEvent: (kind, detail) => {
      offlineEvents.push({ kind, detail, at: new Date().toISOString() });
    },
  });
  await connector.waitReady(); // 就绪后再交给调用方（在此之前平台侧投递会按离线语义丢弃）

  return {
    connector,
    processApprovals,
    status: () => ({
      platform: cfg.platform,
      online: connector.isOnline(),
      offline_events: offlineEvents.slice(-20),
      note:
        cfg.platform === "dingtalk"
          ? "钉钉语义：机器人消息不重投，离线即丢（dropped_offline 计数可见）"
          : cfg.platform === "feishu"
            ? "飞书语义：消息事件重推（约 7 小时内 4 次）；卡片点击在离线时立即报错"
            : cfg.platform === "wecom"
              ? "企业微信语义：每个机器人同时只能一条连接，新连接踢旧连接；文件只能单聊"
              : "模拟器平台（非真实平台）",
    }),
    async stop() {
      await connector.stop();
      db.run(`DELETE FROM im_connector_lease WHERE platform = ? AND owner = ?`, [cfg.platform, owner]);
    },
  };
}
