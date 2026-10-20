// v9.3 第 15 批 B-6（评审 Z1 P1-5：问答是裸模型输出、不做引用核验；验收线“含法条的回答 100% 带核验标记”）：
// 回答里的每条引用按本机法规库离线核对（与签发门禁同一口径），显示时现算；没有引用的回答不带标记，核对出错如实标“没有核对”。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openLawdb } from "@zr-legal/lawdb";
import { makeKernel } from "./helpers.ts";
import { QaChatService } from "../src/services/qa-chat.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const signerPub = (JSON.parse(readFileSync(repo("content/keys/content-signing-dev.pub.json"), "utf8")) as { publicKeyPem: string }).publicKeyPem;
const lawdb = openLawdb(repo("content/lawdb/dist/lawdb.sqlite"), { expectedSignerPubPem: signerPub });
const k = await makeKernel({}, "qa-cite-firm");
after(() => k.kernel.close());
const TID = "ten_qa-cite-firm";
const UID = "usr_qa-cite-firm_test-lawyer";
const noParties = { partiesIn: () => [] } as any;

test("B-6 回答里的引用逐条核对：核到、条款对不上、法规库外、案号离线；没有引用的回答不带标记", async () => {
  const answers = [
    "违约金过高可以请求调整，依据《民法典》第五百八十五条第二款；另见民法典第五百八十五条第四款（应为第二款）、《公司法》第二十条，参见（2023）最高法民终123号。",
    "这个问题需要结合合同约定判断，建议先梳理履行过程。",
  ];
  const qa = new QaChatService({ db: k.kernel.db, tokens: noParties, lawdb, ask: async () => answers.shift()! });
  const r1 = await qa.send({ text: "违约金过高怎么办？" }, TID, UID);
  const a1 = r1.messages.find((m) => m.role === "assistant")!;
  assert.ok(a1.citations, "含法条的回答带核验标记");
  assert.equal(a1.citations!.total, 4);
  assert.equal(a1.citations!.verified, 1);
  assert.equal(a1.citations!.wrong, 0, "款项对不上归“须人工核对”（复核 R15B-03）");
  assert.equal(a1.citations!.outside, 2, "第五百八十五条只有三款 + 公司法不在演示法规库");
  assert.equal(a1.citations!.cases, 1);
  assert.deepEqual(a1.citations!.items.map((i) => i.kind), ["ok", "outside", "outside", "case"]);
  const r2 = await qa.send({ conversationId: r1.conversation_id, text: "还有别的办法吗？" }, TID, UID);
  const a2 = r2.messages.filter((m) => m.role === "assistant")[1]!;
  assert.equal(a2.citations, undefined, "没有引用：不带标记");
  // 没有法规库（不应发生）：不带标记，不冒充核过
  const bare = new QaChatService({ db: k.kernel.db, tokens: noParties, ask: async () => "依据《民法典》第五百零九条" });
  const r3 = await bare.send({ text: "履行原则？" }, TID, UID);
  assert.equal(r3.messages.find((m) => m.role === "assistant")!.citations, undefined);
  // 法规库读出错：如实标“没有核对”
  const broken = new QaChatService({ db: k.kernel.db, tokens: noParties, lawdb: { ...lawdb, findLawVersions: () => { throw new Error("坏了"); }, packageVersion: "x" } as any, ask: async () => "依据《民法典》第五百零九条" });
  const r4 = await broken.send({ text: "全面履行？" }, TID, UID);
  assert.equal(r4.messages.find((m) => m.role === "assistant")!.citations?.unchecked, true);
});

test("B-6 内核问答接口返回核对结果（chat.get 与 chat.send 同一视图）", async () => {
  const sent = await k.inv("chat.send", { text: "合同全面履行原则的依据？" });
  const got = await k.inv("chat.get", { conversation_id: sent.conversation_id });
  assert.deepEqual(
    got.messages.map((m: any) => m.citations ?? null),
    sent.messages.map((m: any) => m.citations ?? null),
  );
});
