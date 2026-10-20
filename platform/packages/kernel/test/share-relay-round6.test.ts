/**
 * 第 11 批第六轮复核 B 的复现转入（S11B-50）：中继重建（同一地址、新实例、空记录）之后，最近确认过的非负责人有一段待发，
 * 登记带着旧实例编号被中继拒收，按重建处理、等负责人先登记——不抢先成为控制成员；负责人照常加人。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publicKeyMap } from "@zr-legal/firm-trust";
import { createRelayApi } from "@zr-legal/relay-api";
import { makeKernel, type TestKernel } from "./helpers.ts";
import { startCloudCp, type CloudCp } from "./cloud-cp.ts";
import { createKernel } from "../src/index.ts";

const FIRM = "r6-firm";
const TID = `ten_${FIRM}`;
const usr = (s: string) => `usr_${FIRM}_${s}`;
type K = { kernel: Awaited<ReturnType<typeof createKernel>>; dir: string; inv: (m: string, p?: any) => Promise<any> };
let cloud: CloudCp;
let kA: TestKernel;
let kC: K;
let fresh: ReturnType<typeof createRelayApi> | null = null;

before(async () => {
  cloud = await startCloudCp({ tenant: TID });
  kA = await makeKernel({ ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" }, FIRM);
  await kA.inv("control_plane.sync");
  const ws = mkdtempSync(join(tmpdir(), "kwl-r6-carol-"));
  mkdirSync(join(ws, FIRM, "keys"), { recursive: true });
  copyFileSync(join(kA.dir, FIRM, "keys", "firm-root.json"), join(ws, FIRM, "keys", "firm-root.json"));
  const kernel = await createKernel({ dataDir: ws, firmSlug: FIRM, userSlug: "carol", env: { ...process.env, ...cloud.env, ZR_MODEL_PROVIDER: "upstream", ZR_RELAY_SYNC_MS: "off" } });
  kC = { kernel, dir: ws, inv: (m, p) => kernel.invoke(m, p) };
  for (const k of [kC, kA, kC]) await k.inv("control_plane.sync");
  const body = { max_mode: "default", auto_preauthorizations: [], fetch_allowlist_extra: [], l3a_standard_model: "deny", share_relay: "allow" };
  const { draft } = await kA.inv("firm_policy.create_draft", { kind: "policy", body });
  await kA.inv("firm_policy.sign", { draft_id: draft.draft_id, expected_digest: draft.digest });
  await kA.inv("firm_policy.publish", { draft_id: draft.draft_id });
  await cloud.feed.refresh();
  await kC.inv("control_plane.sync");
});
after(async () => {
  if (fresh) {
    fresh.closeAllConnections();
    await new Promise<void>((r) => fresh!.close(() => r()));
  }
  await kC.kernel.close().catch(() => {});
  await kA.kernel.close();
  await cloud.close();
});

const imp = (k: K | TestKernel, mid: string, fn: string, t: string) =>
  k.inv("materials.import", { matter_id: mid, filename: fn, data_base64: Buffer.from(t, "utf8").toString("base64"), mime: "text/plain" });

test("S11B-50：中继重建后，最近确认过的非负责人带旧实例编号登记被拒，不抢先成为控制成员；负责人照常加人", { timeout: 240_000 }, async () => {
  const { matter } = await kA.inv("matters.create", { title: "中继重建", stance: "受让方", consent_status: "not_required", collab_scope: "team" });
  const mid = matter.matter_id;
  await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("carol") });
  await imp(kA, mid, "A.txt", "A");
  await kA.inv("relay.sync");
  await kC.inv("relay.sync");
  await imp(kC, mid, "C1.txt", "C1");
  await kC.inv("relay.sync");
  // 中软重建中继：同一地址，新实例、空记录
  const port = Number(new URL(cloud.relay.base).port);
  const old = cloud.relay.server;
  old.closeAllConnections();
  await new Promise<void>((r) => old.close(() => r()));
  fresh = createRelayApi({ dir: mkdtempSync(join(tmpdir(), "kwl-relay-rebuilt-")), keys: publicKeyMap(cloud.cp.publicKeys.seat), feed: cloud.feed, opsGuard: cloud.relay.opsGuard, accessLog: () => {} });
  await new Promise<void>((r) => fresh!.listen(port, "127.0.0.1", () => r()));
  await imp(kC, mid, "C2.txt", "C2（重建后）");
  await kC.inv("relay.sync");
  assert.equal(fresh.tenant(TID)?.controller(mid) ?? null, null, "非负责人没有把事项登记到新中继上");
  await kA.inv("relay.sync");
  await kA.inv("relay.sync");
  assert.equal(fresh.tenant(TID)?.controller(mid), usr("test-lawyer"));
  assert.equal(await kA.inv("matters.members.add", { matter_id: mid, user_id: usr("bob") }).then(() => "ok"), "ok");
});
