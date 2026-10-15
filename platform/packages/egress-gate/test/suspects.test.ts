/**
 * 闸门的发送前二次检测（v9.2 R7；Y5 §4.3）：模型请求体令牌化之后，对每个文字值再找“像姓名的原文”，按不同的值计数；
 * 去向记录只带计数（高、中两档），具体的值不进任何记录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { processChatPayload } from "../src/chat-payload.ts";

test("模型请求：令牌化后仍像姓名的原文按不同的值计数；同一值跨消息只计一次；值只在内存报告里", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 3), parties: [{ name: "陈建国", kind: "person" }], table: [] });
  const r = processChatPayload(
    {
      model: "kimi",
      messages: [
        { role: "user", content: "陈建国与李华共同签署了补充协议；尚文琳和汪英波在餐厅见面。" },
        { role: "assistant", content: [{ type: "text", text: "已知陈建国与李华的关系。" }] },
        { role: "user", content: "赵敏，女，汉族。" },
      ],
    },
    tz,
  );
  // 赵敏的表头写法已被规则识别直接替换，不再计入；李华、尚文琳、汪英波为中档
  assert.deepEqual(r.suspects, { high: 0, medium: 3 });
  assert.deepEqual(r.suspectValues.map((x) => x.value).sort(), ["李华", "尚文琳", "汪英波"].sort());
  const sent = JSON.stringify(r.body);
  assert.equal(sent.includes("陈建国"), false, "词典里的当事人已替换");
  assert.equal(sent.includes("赵敏"), false, "表头写法已替换");
  const clean = processChatPayload({ model: "kimi", messages: [{ role: "user", content: "请审查第七条保密义务。" }] }, tz);
  assert.deepEqual(clean.suspects, { high: 0, medium: 0 });
  assert.deepEqual(clean.suspectValues, []);
});
