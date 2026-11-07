/**
 * V13 第 38 批：称呼代号说明。“周总”与“周启明”按设计各有代号（不能断定是同一人），真实走查 W1 里模型以为是两个人，
 * 在起草说明里写出“指示人代号不一致”（评分律师列为必删）。本事项只有一位同姓全名时，给模型一句只含代号的说明。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MatterTokenizer, findTokens, nicknameLegend } from "../src/index.ts";

const KEY = Buffer.alloc(32, 7);

test("称呼与唯一同姓全名同时出现：说明两代号通常指同一人；说明里只有代号，没有姓或名", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  const mail = t.tokenize("发件人：周启明 <zhou@example.cn>\\n顾律师：协议用我们的抬头起草。周启明");
  const goal = t.tokenize("客户董事长周启明11月5日来信；周总的指示和条款清单不一致的，单独列清单。");
  const toks = findTokens(goal.text);
  assert.equal(toks.length, 2, goal.text);
  const legend = nicknameLegend(t.table(), [goal.text, mail.text]);
  assert.match(legend, /【代号说明】/);
  for (const tok of toks) assert.ok(legend.includes(tok), legend);
  assert.doesNotMatch(legend, /周|启明/, "说明里不出现姓名");
});

test("同姓全名有两位、或全名不在本次文字里：不给说明", () => {
  const t = new MatterTokenizer({ matterKey: KEY });
  const a = t.tokenize("原告：周启明。被告：周敏。周总表示同意。");
  assert.equal(nicknameLegend(t.table(), [a.text]), "", "两位同姓，不说明");
  const t2 = new MatterTokenizer({ matterKey: KEY });
  t2.tokenize("原告：周启明，男。");
  const b = t2.tokenize("周总表示同意。");
  assert.equal(nicknameLegend(t2.table(), [b.text]), "", "全名不在本次文字里，不说明");
});
