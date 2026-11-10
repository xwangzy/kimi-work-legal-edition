// V16 第 41 批真实任务：“经办人权限”“签署人权限”“代理人权限不明”认出“权限”，进了事项代号表后全案“代理权限”“签署权限”都被换成姓名代号，
// 独立复核据此误报“必须改”，修改轮把“部门章、财务章签署权限”这一实质抗辩点删掉了
import assert from "node:assert/strict";
import test from "node:test";
import { recognizeNames, stillLooksLikeName } from "../src/names.ts";

test("角色词后紧跟“权限”“权责”等以“权”起头的常用词不认成姓名；同样位置的真名照常认出", () => {
  for (const s of ["经办人权限", "审查签署人权限", "被告代理人权限不明", "签署人权责不清", "经办人权力有限", "代理人权利义务", "签署人权益受损"]) {
    assert.deepEqual([...recognizeNames(s)], [], s);
  }
  assert.deepEqual([...recognizeNames("经办人：权立新，男")], ["权立新"], "有冒号边界的真名照常认出");
  assert.deepEqual([...recognizeNames("被告代理人权志明律师")], ["权志明"]);
  // 此前误登记进事项代号表的“权限”不再当作已知姓名去替换新文字
  assert.equal(stillLooksLikeName("权限"), false);
});
