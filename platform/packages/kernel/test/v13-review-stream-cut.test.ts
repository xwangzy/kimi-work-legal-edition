// V13 真实走查 N2b（审仓储合同，K3.1-Pro）：交付前独立复核的流式调用读到一半被切断（undici 抛不带 code 的 “terminated”），
// 有界重试只认 provider_unavailable，复核一次没重试就记“没有复核”。流中途中断按模型通道暂不可用处理，交给有界重试。
import { test } from "node:test";
import assert from "node:assert/strict";
import { DomainError } from "@zr-legal/domain";
import { chatStreamText } from "../src/executor/executor.ts";

function broker(chunks: (string | Error)[]) {
  return {
    chatStream: async () => ({
      chunks: (async function* () {
        for (const c of chunks) {
          if (c instanceof Error) throw c;
          yield c;
        }
      })(),
      finalize: async () => {},
    }),
  } as never;
}

test("流读到一半被切断：抛 provider_unavailable（交给有界重试）；完整的流照常拼出回答；已分类的领域错误原样抛出", async () => {
  const delta = (t: string) => JSON.stringify({ choices: [{ delta: { content: t } }] });
  await assert.rejects(() => chatStreamText(broker([delta("{\"trace\":"), new TypeError("terminated")]), {} as never), (e: any) => e instanceof DomainError && e.code === "provider_unavailable");
  assert.equal(await chatStreamText(broker([delta("{\"a\":"), delta("1}"), "[DONE]"]), {} as never), "{\"a\":1}");
  await assert.rejects(() => chatStreamText(broker([new DomainError("quota_exceeded", "点数不足", 402)]), {} as never), (e: any) => e.code === "quota_exceeded");
});
