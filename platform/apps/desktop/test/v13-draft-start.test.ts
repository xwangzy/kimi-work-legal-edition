/**
 * V13 真实界面走查 N4：首页输入“请为我方起草《化妆品委托生产（OEM）合同》……首年最低采购量合计 30 万支……”，路由到“起草合同”后，
 * 合同类型被“采购”猜成“买卖”（委托生产是承揽，类型表里没有承揽）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { guessContractType } from "../src/lib/scenarios.ts";

const ask = "请为我方（委托方）起草《化妆品委托生产（OEM）合同》，受托方持化妆品生产许可证。首年最低采购量合计 30 万支，单价按报价单……";

test("委托生产、委托加工、OEM 不按“采购”猜成买卖；普通采购合同照旧是买卖", () => {
  assert.equal(guessContractType([], "青禾美妆化妆品委托生产（OEM）合同起草", ask), "其他（通用辅助）");
  assert.equal(guessContractType(["设备采购合同.docx"]), "买卖");
});
