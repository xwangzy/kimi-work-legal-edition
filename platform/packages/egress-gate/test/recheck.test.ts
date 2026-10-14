/**
 * 阶段 4 复核新问题的回归：
 * - S4-18 写法变体：任意个数的不可见字符与空白插在名称中间、ICU 全量繁简单字表（含 13 个常见姓氏）；
 * - S4-19 请求体：结构键只在协议层位置生效——工具参数、参数 schema、`stop`、`user` 中的每一个字符串都令牌化；
 * - S4-20 别名：不把“本人/张某/X氏/明天”等常用词学成或派生为别名；中文简称须与全称共用汉字；P6 误替换语料含别名来源。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { deriveOrgAliases, extractDefinedAliases, foldText, MatterTokenizer, restoreTokens, VariantMatcher } from "@zr-legal/tokenizer";
import { processChatPayload } from "../src/chat-payload.ts";
import { screenSearchQuery, type SearchContext } from "../src/search-guard.ts";
import { checkUrlStatic } from "../src/url-guard.ts";

const tz = (parties: { name: string; kind: "person" | "org"; aliases?: string[] }[], fullPseudonym = false) =>
  new MatterTokenizer({ matterKey: randomBytes(32), parties, fullPseudonym });
const ctx = (t: MatterTokenizer): SearchContext => ({ dataLevel: "L2", basisComplete: true, preauthorizedGeneralize: false, tokenizer: t });

test("S4-18 插入字符不设上限：双向隔离、变体选择符、表意文字变体序列、蒙古文分隔符、组合连接符、标签字符、半角中点、韩文填充、≥4 个空格与换行，一律命中", () => {
  const t = tz([{ name: "张三", kind: "person" }, { name: "华为技术有限公司", kind: "org" }]);
  const seps = ["⁦", "⁩", "️", "\u{E0101}", "᠎", "͏", "\u{E0020}", "･", "ㅤ", "    ", " ".repeat(40), "\n", "　　", "⁦​ ️\u{E0020}"];
  for (const sep of seps) {
    const person = `张${sep}三`;
    assert.equal(screenSearchQuery(`${person} 民间借贷`, ctx(t)).decision, "deny", `检索：${JSON.stringify(sep)}`);
    const url = checkUrlStatic(`https://www.court.gov.cn/s?q=${encodeURIComponent(person)}`, t);
    assert.equal(url.ok, false, `URL：${JSON.stringify(sep)}`);
    const r = t.tokenize(`出借人${person}签字。`);
    if (/\t/.test(sep)) {
      // 终核 S4-23：材料令牌化时制表与空行是硬边界（单个折行是软边界，终核核验 S4-27）；检索与 URL 筛查照常命中（上两行）
      assert.ok(r.text.includes(person), `令牌化不跨制表：${JSON.stringify(sep)} → ${r.text}`);
    } else {
      assert.ok(!r.text.includes("张") && !r.text.includes("三签"), `令牌化：${JSON.stringify(sep)} → ${r.text}`);
    }
    const org = `华为${sep}技术有限公司`;
    assert.equal(screenSearchQuery(`${org} 股权`, ctx(t)).decision, "deny", `机构：${JSON.stringify(sep)}`);
  }
  // 名称之外的空白不受影响：一般性查询照常放行
  assert.equal(screenSearchQuery("股东    未实缴出资   补足责任", ctx(t)).decision, "pass");
});

test("S4-18 繁简：ICU 全量单字表覆盖常见姓氏（复核列出的 13 个与百家姓常见繁体字），繁体写法的姓名一律命中", () => {
  const pairs = "呂吕喬乔聶聂婁娄竇窦閔闵欒栾叢丛鞏巩遲迟駱骆遊游塗涂趙赵錢钱孫孙鄭郑馮冯陳陈衛卫蔣蒋韓韩楊杨許许張张劉刘譚谭鄧邓蕭萧葉叶龐庞盧卢聞闻閻阎謝谢鄒邹饒饶顧顾龔龚賈贾嚴严韋韦鍾钟歐欧諸诸葛葛溫温湯汤羅罗黃黄魯鲁鳳凤華华蘇苏魏魏費费廉廉薛薛雷雷賀贺倪倪";
  const cps = [...pairs];
  for (let i = 0; i + 1 < cps.length; i += 2) assert.equal(foldText(cps[i]!), cps[i + 1], `${cps[i]} → ${cps[i + 1]}`);
  for (const [trad, simp] of [["呂明", "吕明"], ["喬峰", "乔峰"], ["聶小倩", "聂小倩"], ["駱賓王", "骆宾王"], ["塗山", "涂山"]] as const) {
    const t = tz([{ name: simp, kind: "person" }]);
    assert.equal(screenSearchQuery(`${trad} 民间借贷`, ctx(t)).decision, "deny", trad);
  }
  // 现行规范用字的人工覆盖
  assert.equal(foldText("諮詢"), "咨询");
  assert.equal(foldText("滙豐"), "汇丰");
});

test("S4-18 性能：300 个当事人 × 300 KB 文本的变体匹配在 2 秒内（无灾难性回溯）", () => {
  const names = Array.from({ length: 300 }, (_, i) => `同前缀科技有限公司${String(i).padStart(3, "0")}`);
  const m = new VariantMatcher(names);
  const text = "同前缀科技有限公司 ".repeat(30_000);
  const t0 = Date.now();
  m.find(text);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

test("S4-19 工具参数与 schema 内没有“结构键”豁免：键名为 id/n/type/role/user/model/stop 的值同样令牌化；顶层 stop、user 令牌化", () => {
  const t = tz([{ name: "张三", kind: "person" }]);
  const args = { query: "张三", type: "张三的借款", id: "13800138000", role: "原告张三", user: "张三", model: "张三", stop: "张三", name: "张三", n: "110101199003077777" };
  const body = {
    model: "legal/k3",
    stop: ["张三"],
    user: "张三",
    prompt_cache_key: "ses_01J9ZK",
    metadata: { user_id: "seat_1" },
    tools: [{ type: "function", function: { name: "LegalMcp", description: "为张三查询", parameters: { type: "object", properties: { id: { type: "string", description: "张三的编号" } }, required: ["id"] } } }],
    messages: [
      { role: "user", content: "请为张三起草" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "LegalMcp", arguments: JSON.stringify(args) } }] },
      { role: "tool", tool_call_id: "call_1", content: "张三 13800138000" },
    ],
  };
  const r = processChatPayload(body, t);
  const out = JSON.stringify(r.body);
  assert.ok(!out.includes("张三"), out);
  assert.ok(!out.includes("13800138000") && !out.includes("110101199003077777"), out);
  const b = r.body as any;
  // 结构值原样
  assert.equal(b.model, "legal/k3");
  assert.equal(b.prompt_cache_key, "ses_01J9ZK");
  assert.equal(b.metadata.user_id, "seat_1");
  assert.equal(b.tools[0].function.name, "LegalMcp");
  assert.deepEqual(b.tools[0].function.parameters.required, ["id"]);
  assert.equal(b.tools[0].function.parameters.type, "object");
  assert.equal(b.messages[1].tool_calls[0].id, "call_1");
  assert.equal(b.messages[1].tool_calls[0].function.name, "LegalMcp");
  assert.equal(b.messages[2].tool_call_id, "call_1");
  const parsed = JSON.parse(b.messages[1].tool_calls[0].function.arguments);
  for (const k of Object.keys(args)) assert.match(parsed[k], /〔/, `参数 ${k}`);
});

test("S4-19 Anthropic 形态：tool_use 的 id/name 原样、input 全部令牌化；tool_result 内容令牌化；redacted_thinking 的加密数据与签名原样", () => {
  const t = tz([{ name: "张三", kind: "person" }]);
  const body = {
    model: "legal/k3",
    system: [{ type: "text", text: "你代表张三", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "张三的借款", signature: "sig-张三-opaque" },
        { type: "redacted_thinking", data: "ZXhhbXBsZTEzODAwMTM4MDAw" },
        { type: "tool_use", id: "toolu_1", name: "Search", input: { id: "13800138000", type: "张三" } },
      ] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [{ type: "text", text: "张三 110101199003077777" }] }] },
    ],
  };
  const r = processChatPayload(body, t);
  const b = r.body as any;
  assert.equal(b.system[0].cache_control.type, "ephemeral");
  assert.match(b.system[0].text, /〔自然人/);
  assert.equal(b.messages[0].content[0].signature, "sig-张三-opaque");
  assert.match(b.messages[0].content[0].thinking, /〔自然人/);
  assert.equal(b.messages[0].content[1].data, "ZXhhbXBsZTEzODAwMTM4MDAw");
  assert.equal(b.messages[0].content[2].id, "toolu_1");
  assert.equal(b.messages[0].content[2].name, "Search");
  assert.match(b.messages[0].content[2].input.id, /〔电话/);
  assert.match(b.messages[0].content[2].input.type, /〔自然人/);
  assert.equal(b.messages[1].content[0].tool_use_id, "toolu_1");
  assert.ok(!JSON.stringify(b.messages[1]).includes("张三") && !JSON.stringify(b.messages[1]).includes("110101199003077777"));
  assert.deepEqual(r.media, []);
});

test("S4-19 图像载荷只记类别与摘要（不含图像数据）；未知内容块失败关闭", () => {
  const t = tz([]);
  const png = Buffer.from("fake-png-bytes").toString("base64");
  const r = processChatPayload({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${png}` } }, { type: "mystery", text: "x" }] }] }, t);
  assert.equal(r.media.length, 2);
  assert.equal(r.media[0]!.kind, "image_url");
  assert.match(r.media[0]!.digest ?? "", /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(r.media).includes(png));
  assert.equal(r.media[1]!.kind, "unknown:mystery");
});

test("S4-20 简称学习：人称代词、“X某”、“X氏”、角色词与常用词不学；中文简称须与全称共用汉字；拉丁字母简称可学", () => {
  const text = [
    "保证人张三（以下简称“本人”）。",
    "张三（以下简称“张某”）。",
    "张三（以下简称“张氏”）。",
    "张三（下称“借款方”）。",
    "北京明天科技有限公司（以下简称“明天”）。",
    "华为技术有限公司（以下简称“华为”）。",
    "华为技术有限公司（以下简称“Huawei”）。",
    "出借人张三（以下简称“张先生”）。",
  ].join("");
  const found = extractDefinedAliases(text, ["张三", "华为技术有限公司", "北京明天科技有限公司"]).map((x) => `${x.name}→${x.alias}`);
  assert.deepEqual(found, ["华为技术有限公司→华为", "华为技术有限公司→Huawei", "张三→张先生"]);
});

test("S4-20 字号派生：去任意位置的括注；“明天”等常用词不派生；“平安”“腾讯”“大成”可派生；银行类通名不派生", () => {
  assert.deepEqual(deriveOrgAliases("北京明天科技有限公司"), ["北京明天科技"]);
  assert.ok(deriveOrgAliases("中国平安保险（集团）股份有限公司").includes("平安"));
  assert.ok(!deriveOrgAliases("中国平安保险（集团）股份有限公司").some((a) => a.includes("（")));
  assert.ok(deriveOrgAliases("深圳市腾讯计算机系统有限公司").includes("腾讯"));
  assert.ok(deriveOrgAliases("北京大成律师事务所").includes("大成"));
  assert.ok(!deriveOrgAliases("上海银行股份有限公司").includes("上海"));
  assert.ok(!deriveOrgAliases("中国银行股份有限公司").includes("银行"));
});

test("S4-20 词典里已有的常用词别名（如此前学得的“本人”“张某”）一律不用：不替换、不拒检索", () => {
  const t = tz([{ name: "张三", kind: "person", aliases: ["本人", "张某", "张先生"] }]);
  const r = t.tokenize("证人证言：本人确认收到借款。另案判决书中张某系被告。张先生已签字。");
  assert.ok(r.text.includes("本人确认") && r.text.includes("张某系被告"), r.text);
  assert.ok(!r.text.includes("张先生"), r.text);
  assert.equal(screenSearchQuery("本人 签字 效力", ctx(t)).decision, "pass");
});

test("S4-20 P6 误替换语料（含别名来源：确认的、学得的、派生的字号；全部化名）：常用句 0 误替换", () => {
  const t = tz(
    [
      { name: "北京明天科技有限公司", kind: "org" },
      { name: "张三", kind: "person", aliases: ["张先生"] },
      { name: "深圳市腾讯计算机系统有限公司", kind: "org" },
      { name: "北京大成律师事务所", kind: "org" },
    ],
    true,
  );
  const sentences = [
    "明天开庭，请准时到场。",
    "本人确认收到借款。",
    "张某某的证言与事实不符。",
    "双方约定明天付款。",
    "原告的诉讼请求应予支持。",
    "被告某公司未按期交付。",
    "该公司于去年成立。",
    "本合同自双方签字之日起生效。",
    "今天下午三点在法院见面。",
    "请律师于明日前提交答辩状。",
  ];
  for (const s of sentences) assert.equal(t.tokenize(s).text, s, s);
  // 当事人本身照常替换（全部化名：机构名称与字号也替换）
  assert.ok(!t.tokenize("腾讯与张先生签订合同。").text.includes("腾讯"));
});

// ── 阶段 4 终核（S4-23、S4-24、S4-25）──

test("S4-25 现行规范字不折叠：乾/於/著/藉/俱/姊/跤/瞭/後 等折叠为自身；不同的词、不同的人不再互相命中，还原零错名", () => {
  assert.equal(foldText("乾於著藉俱姊跤瞭後夥覆徵"), "乾於著藉俱姊跤瞭後夥覆徵");
  const cases: [string, string][] = [
    ["张乾", "原告主张干预措施违法"],
    ["於明", "证人于明出庭作证"],
    ["於明", "合同将于明年到期"],
    ["李著", "李着急地说"],
  ];
  for (const [name, text] of cases) {
    const t = tz([{ name, kind: "person" }]);
    const r = t.tokenize(text);
    // 词典当事人的代号不出现（不同的词、不同的人不命中）；规则识别出的真实姓名（“证人于明”）可以有自己的代号，但还原逐字等于原文
    const dictToken = t.tokenFor("person", name).token;
    assert.ok(!r.text.includes(dictToken), `${name} × ${text} → ${r.text}`);
    assert.equal(restoreTokens(r.text, t.table()).text, text, `还原零错名：${text}`);
  }
  // 不是人名的高频写法完全不动
  for (const text of ["原告主张干预措施违法", "合同将于明年到期", "李着急地说"]) {
    assert.equal(tz([{ name: "张乾", kind: "person" }, { name: "於明", kind: "person" }, { name: "李著", kind: "person" }]).tokenize(text).text, text);
  }
  // 真正的繁简写法仍识别为同一当事人（检索与 URL 照常拦截）
  const t = tz([{ name: "张三", kind: "person" }]);
  assert.equal(screenSearchQuery("張三 民间借贷", ctx(t)).decision, "deny");
});

test("S4-25 还原逐字等于原文字形：同一段文字里繁体与简体写法各自还原为原写法（插空格、全角写法还原为词典写法）", async () => {
  const t = tz([{ name: "张三", kind: "person" }, { name: "ABC科技有限公司", kind: "org" }], true);
  const text = "張三与张三、ABC科技有限公司签约。";
  const r = t.tokenize(text);
  assert.ok(!r.text.includes("张三") && !r.text.includes("張三") && !r.text.includes("ABC"), r.text);
  assert.equal(restoreTokens(r.text, t.table()).text, text);
  // 全角与插空格只差排版：同一代号，还原为词典写法（字形相同）
  const w = t.tokenize("ＡＢＣ科技有限公司与张 三");
  assert.equal(restoreTokens(w.text, t.table()).text, "ABC科技有限公司与张三");
});

test("S4-23 材料令牌化：换行、段落与制表是硬边界——“主张⏎三、”“姓名⇥张⇥⇥⇥三号楼”不拼成姓名，换行与列表序号保留；检索与 URL 筛查仍不放过跨行写法", () => {
  const t = tz([{ name: "张三", kind: "person" }]);
  for (const text of ["原告主张\n三、被告应承担违约责任", "支持其主张\n\n\n三、关于违约金", "姓名\t张\t\t\t三号楼", "主张\r\n三、", "主张\u2028（三）关于", "主张\n3. 关于"]) {
    assert.equal(t.tokenize(text).text, text, JSON.stringify(text));
  }
  // 同一行内的插入字符仍不设上限
  assert.ok(!t.tokenize(`出借人张${" ".repeat(12)}三签字`).text.includes("三签"));
  // 对抗写法：检索式与 URL 里用换行、制表或 %0A 拆开名称，照常拦截
  assert.equal(screenSearchQuery("张\n三 民间借贷", ctx(t)).decision, "deny");
  assert.equal(screenSearchQuery("张\t三 民间借贷", ctx(t)).decision, "deny");
  assert.equal(checkUrlStatic(`https://www.court.gov.cn/s?q=${encodeURIComponent("张\n三")}`, t).ok, false);
});

test("S4-24 内容块的 citations 照常令牌化：cited_text、document_title 中的身份证号与姓名不以明文出站", () => {
  const t = tz([{ name: "张三", kind: "person" }]);
  const body = {
    model: "m",
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "见引用", citations: [{ type: "char_location", cited_text: "张三身份证号110101199003077777", document_title: "张三借款合同", start_char_index: 0, end_char_index: 10 }] }],
      },
    ],
  };
  const out = JSON.stringify(processChatPayload(body, t).body);
  assert.ok(!out.includes("张三") && !out.includes("110101199003077777"), out);
  assert.ok(out.includes('"start_char_index":0'));
});

// ── 阶段 4 终核核验（S4-26、S4-27）──

test("S4-27 被版面折行断开的词典姓名照常令牌化（单个换行、\\r\\n、带前后空格），还原逐字保留换行；空行、制表与编号前的换行仍是硬边界", () => {
  const t = tz([{ name: "张三", kind: "person" }]);
  for (const text of ["原告：张\n三，男，汉族，住址略。", "张\r\n三签字确认", "出借人张 \n 三于当日付款", "原告张\u2028三"]) {
    // 每例用新的令牌化器：同一规范值的代号还原为首次出现的写法（名称内部的空格可能统一，见 P6 口径）
    const t = tz([{ name: "张三", kind: "person" }]);
    const r = t.tokenize(text);
    assert.ok(!/张[\s\u2028]*三/u.test(r.text), `${JSON.stringify(text)} → ${r.text}`);
    assert.equal(restoreTokens(r.text, t.table()).text, text, "还原逐字保留换行");
  }
  for (const text of ["原告主张\n三、被告应承担违约责任", "主张\n（三）关于违约金", "主张\n\n三方面", "姓名\t张\t三号楼"]) {
    assert.equal(t.tokenize(text).text, text, JSON.stringify(text));
  }
  // 出站请求体同样处理（闸门第二道令牌化）
  const out = JSON.stringify(processChatPayload({ model: "m", messages: [{ role: "user", content: "原告：张\n三，男" }] }, t).body);
  assert.ok(!/张\\n三/.test(out), out);
});

test("S4-26 旧规则（FOLD_VERSION 2，含繁转简）存下的令牌条目不再被另一个字形命中：于明不会拿到於明的代号、张三不会拿到張三的代号，还原零错名", () => {
  const key = randomBytes(32);
  const probe = new MatterTokenizer({ matterKey: key });
  // v2 形态的条目：繁体值、以简体为规范值（代号即按简体规范值算出的那一个）
  const legacy = [
    { token: probe.tokenFor("person", "于明").token, category: "person" as const, value: "於明", normalized: "于明", source: "dictionary" as const },
    { token: probe.tokenFor("person", "张三").token, category: "person" as const, value: "張三", normalized: "张三", source: "dictionary" as const },
  ];
  const t = new MatterTokenizer({ matterKey: key, parties: [{ name: "张三", kind: "person" }], table: legacy });
  const text = "证人于明出庭作证。张三签字。";
  const r = t.tokenize(text);
  assert.equal(restoreTokens(r.text, t.table()).text, text);
  // 旧条目自身的值仍得到原来的代号（同一值跨版本不变）
  assert.equal(t.tokenFor("person", "於明").token, legacy[0]!.token);
  assert.equal(t.tokenFor("person", "張三").token, legacy[1]!.token);
});
