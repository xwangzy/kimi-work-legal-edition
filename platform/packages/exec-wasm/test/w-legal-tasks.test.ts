/**
 * P2 验收（第 06 篇 P2；第 04 篇 §4.1 性能目标）：20 类律师典型数据任务在 W-core（标准库 + 内置命令）中通过。
 *
 * 随包纯 Python 包（openpyxl、XlsxWriter、pypdf、python-dateutil、jieba 等）尚未随包（下载须另行授权）：
 * 本文件只用标准库与 just-bash 内置命令；XLSX 生成以标准库 zipfile 写出最小工作簿并读回校验。
 */
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { FileBroker } from "@zr-legal/file-broker";
import { WCoreDomain, type WProcess } from "../src/domain.ts";

/** 最小 ZIP 写出（stored，无压缩）：用于生成测试 DOCX。 */
function zipStore(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data) >>> 0;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    lh.writeUInt16LE(0, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

function docx(paragraphs: string[]): Buffer {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</w:t></w:r></w:p>`).join("");
  return zipStore({
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  });
}

let base: string;
let work: string;
let materials: string;
let broker: FileBroker;
let domain: WCoreDomain;
const timings: Record<string, number> = {};

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "kwl-wtasks-")));
  work = join(base, "work");
  materials = join(base, "materials");
  mkdirSync(work, { recursive: true });
  mkdirSync(join(materials, "合同"), { recursive: true });
  broker = new FileBroker([
    { name: "materials", root: materials, access: "ro" },
    { name: "work", root: work, access: "rw" },
  ]);
  // 材料：三份合同文本 + 40 份 DOCX
  const parties = [
    ["北京甲科技有限公司", "上海乙贸易有限公司", "1,250,000.00", "2025年3月18日"],
    ["深圳丙实业有限公司", "广州丁物流有限公司", "386,500.50", "2025年11月2日"],
    ["杭州戊网络有限公司", "南京己建设集团有限公司", "12,000,000.00", "2026年1月9日"],
  ];
  parties.forEach(([a, b, amt, d], i) =>
    writeFileSync(join(materials, "合同", `00${i + 1}-合同.txt`), `甲方：${a}\n乙方：${b}\n第三条 合同价款为人民币${amt}元。\n本合同于${d}签订。\n`),
  );
  mkdirSync(join(materials, "文书"), { recursive: true });
  for (let i = 1; i <= 40; i++) {
    const paras = [`民事起诉状（第${i}号）`, `原告：测试原告${i}有限公司`, `被告：测试被告${i}股份有限公司`, `诉讼请求：判令被告支付货款人民币${(i * 12345.67).toFixed(2)}元及逾期利息。`];
    for (let k = 0; k < 60; k++) paras.push(`事实与理由第${k + 1}段：双方于2025年签订买卖合同，被告未按约付款。`);
    writeFileSync(join(materials, "文书", `起诉状-${String(i).padStart(2, "0")}.docx`), docx(paras));
  }
  domain = await WCoreDomain.start({ broker, work: { zone: "work", root: work }, readOnlyRoots: [materials], pathClass: "posix", tmpDir: join(base, "w-tmp") });
});

after(async () => {
  await domain.close();
  console.log(`[W 数据任务耗时 ms] ${JSON.stringify(timings)}`);
});

async function run(name: string, script: string): Promise<{ code: number; out: string; err: string }> {
  const t0 = Date.now();
  const p: WProcess = await domain.run(`cd '${work}' && ${script}`, { cwd: work });
  let out = "";
  let err = "";
  p.stdout.setEncoding("utf8");
  p.stderr.setEncoding("utf8");
  p.stdout.on("data", (c: string) => (out += c));
  p.stderr.on("data", (c: string) => (err += c));
  const ended = Promise.all([new Promise((r) => p.stdout.on("end", r)), new Promise((r) => p.stderr.on("end", r))]);
  const code = await p.wait();
  await ended;
  timings[name] = Date.now() - t0;
  return { code, out, err };
}

const py = (src: string) => `python3 - <<'PY'\n${src}\nPY`;
const M = () => materials;

describe("20 类律师典型数据任务（W-core，标准库）", () => {
  test("01 银行流水按月汇总（300 行，< 10 秒）", async () => {
    const rows = ["日期,摘要,收入,支出"];
    for (let i = 0; i < 300; i++) rows.push(`2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")},往来${i % 9},${i % 4 === 0 ? (1000 + i).toFixed(2) : "0"},${i % 4 === 0 ? "0" : (88.8 + i).toFixed(2)}`);
    writeFileSync(join(work, "流水.csv"), `${rows.join("\n")}\n`);
    const r = await run(
      "01",
      py(`import csv
from collections import defaultdict
from decimal import Decimal
s = defaultdict(lambda: [Decimal(0), Decimal(0)])
for r in csv.DictReader(open('流水.csv', encoding='utf-8')):
    m = r['日期'][:7]; s[m][0] += Decimal(r['收入']); s[m][1] += Decimal(r['支出'])
with open('月度汇总.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f); w.writerow(['月份', '收入', '支出', '净额'])
    for m in sorted(s): w.writerow([m, s[m][0], s[m][1], s[m][0] - s[m][1]])
print(len(s))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "12");
    assert.ok(timings["01"]! < 10_000);
    assert.equal(readFileSync(join(work, "月度汇总.csv"), "utf8").split(/\r?\n/)[0], "月份,收入,支出,净额"); // csv 模块默认 \r\n
  });

  test("02 台账 1 万行分组聚合（< 30 秒）", async () => {
    const rows = ["客户,类别,金额"];
    for (let i = 0; i < 10_000; i++) rows.push(`客户${i % 40},类别${i % 7},${((i * 7919) % 100000) / 100}`);
    writeFileSync(join(work, "台账.csv"), `${rows.join("\n")}\n`);
    const r = await run(
      "02",
      py(`import csv
from collections import Counter
from decimal import Decimal
t = Counter(); n = Counter()
for r in csv.DictReader(open('台账.csv', encoding='utf-8')):
    k = (r['客户'], r['类别']); t[k] += Decimal(r['金额']); n[k] += 1
top = sorted(t.items(), key=lambda kv: -kv[1])[:3]
print(len(t), sum(n.values()))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "280 10000");
    assert.ok(timings["02"]! < 30_000);
  });

  test("03 违约金三情景（日万分之五 / LPR 四倍 / 合同总价 20% 上限）", async () => {
    const r = await run(
      "03",
      py(`from decimal import Decimal as D, ROUND_HALF_UP
from datetime import date
p = D('1250000'); days = (date(2026, 10, 11) - date(2025, 12, 31)).days
a = p * D('0.0005') * days; b = p * D('0.031') * 4 * days / 365; cap = p * D('0.2')
for x in (a, b, min(a, cap)): print(x.quantize(D('0.01'), ROUND_HALF_UP))`),
    );
    assert.equal(r.code, 0, r.err);
    // 284 天：125 万 × 0.05% × 284 = 177,500.00；125 万 × 3.1% × 4 × 284 / 365 = 120,602.74；上限 25 万不触发
    assert.deepEqual(r.out.trim().split("\n"), ["177500.00", "120602.74", "177500.00"]);
  });

  test("04 分段计息（LPR 调整前后分段、按日计息）", async () => {
    const r = await run(
      "04",
      py(`from decimal import Decimal as D, ROUND_HALF_UP
from datetime import date
segs = [(date(2025, 1, 1), date(2025, 5, 20), D('0.031')), (date(2025, 5, 20), date(2026, 1, 1), D('0.030'))]
p = D('1000000'); total = sum(p * r * (e - s).days / 365 for s, e, r in segs)
print(total.quantize(D('0.01'), ROUND_HALF_UP))`),
    );
    assert.equal(r.code, 0, r.err);
    // 139 天 × 3.1% + 226 天 × 3.0%（本金 100 万，按 365 天）= 11,805.48 + 18,575.34
    assert.equal(r.out.trim(), "30380.82");
  });

  test("05 诉讼时效与期间（三年时效、闰日起算、届满判断）", async () => {
    const r = await run(
      "05",
      py(`from datetime import date, timedelta
def add_years(d, n):
    try: return d.replace(year=d.year + n)
    except ValueError: return d.replace(year=d.year + n, day=28)
start = date(2024, 2, 29); end = add_years(start, 3) - timedelta(days=0)
print(end.isoformat(), (date(2026, 10, 11) > end))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "2027-02-28 False");
  });

  test("06 要素抽取成表（材料区合同文本 → 当事人、金额、签订日期 CSV）", async () => {
    const r = await run(
      "06",
      py(`import re, csv, glob
rows = []
for f in sorted(glob.glob('${M()}/合同/*.txt')):
    t = open(f, encoding='utf-8').read()
    rows.append([re.search(r'甲方：(.+)', t).group(1), re.search(r'乙方：(.+)', t).group(1),
                 re.search(r'人民币([\\d,\\.]+)元', t).group(1).replace(',', ''), re.search(r'于(\\d{4}年\\d{1,2}月\\d{1,2}日)', t).group(1)])
with open('要素表.csv', 'w', encoding='utf-8', newline='') as fo:
    w = csv.writer(fo); w.writerow(['甲方', '乙方', '金额', '签订日期']); w.writerows(rows)
print(len(rows))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "3");
    assert.match(readFileSync(join(work, "要素表.csv"), "utf8"), /杭州戊网络有限公司,南京己建设集团有限公司,12000000\.00,2026年1月9日/);
  });

  test("07 DOCX 文本抽取（zipfile + xml.etree，读 w:t）", async () => {
    const r = await run(
      "07",
      py(`import zipfile, xml.etree.ElementTree as ET
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
z = zipfile.ZipFile('${M()}/文书/起诉状-07.docx')
root = ET.fromstring(z.read('word/document.xml'))
paras = [''.join(t.text or '' for t in p.iter(W + 't')) for p in root.iter(W + 'p')]
print(paras[0]); print(paras[3])`),
    );
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^民事起诉状（第7号）\n诉讼请求：判令被告支付货款人民币86419\.69元/);
  });

  test("08 40 份 DOCX 要素抽取成表（< 2 分钟）", async () => {
    const r = await run(
      "08",
      py(`import zipfile, re, csv, glob, xml.etree.ElementTree as ET
W = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
out = []
for f in sorted(glob.glob('${M()}/文书/*.docx')):
    root = ET.fromstring(zipfile.ZipFile(f).read('word/document.xml'))
    text = '\\n'.join(''.join(t.text or '' for t in p.iter(W + 't')) for p in root.iter(W + 'p'))
    out.append([re.search(r'原告：(.+)', text).group(1), re.search(r'被告：(.+)', text).group(1), re.search(r'人民币([\\d\\.]+)元', text).group(1)])
with open('起诉状要素.csv', 'w', encoding='utf-8', newline='') as fo:
    csv.writer(fo).writerows(out)
print(len(out))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "40");
    assert.ok(timings["08"]! < 120_000);
  });

  test("09 人民币金额大写", async () => {
    const r = await run(
      "09",
      py(`from decimal import Decimal
D = '零壹贰叁肆伍陆柒捌玖'; U = ['', '拾', '佰', '仟']; G = ['', '万', '亿', '万亿']
def cn(n):
    n = Decimal(n).quantize(Decimal('0.01')); y, f = divmod(int(n * 100), 100)
    s = ''; digits = str(y); L = len(digits); zero = False
    for i, ch in enumerate(digits):
        d = int(ch); pos = L - 1 - i
        if d:
            s += ('零' if zero and s else '') + D[d] + U[pos % 4]; zero = False
        else:
            zero = True
        if pos % 4 == 0 and pos > 0 and int(digits[max(0, i - 3): i + 1]): s += G[pos // 4]
    s = (s or '零') + '元'
    j, fe = divmod(f, 10)
    s += (D[j] + '角' if j else ('零' if fe else '')) + (D[fe] + '分' if fe else '')
    return s if f else s + '整'
print(cn('1250000')); print(cn('386500.50')); print(cn('10005.07'))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.out.trim().split("\n"), ["壹佰贰拾伍万元整", "叁拾捌万陆仟伍佰元伍角", "壹万零伍元零柒分"]);
  });

  test("10 诉讼费计算（财产案件分段累进）", async () => {
    const r = await run(
      "10",
      py(`from decimal import Decimal as D
B = [(D(10000), None, D(50)), (D(100000), D('0.025'), None), (D(200000), D('0.02'), None), (D(500000), D('0.015'), None), (D(1000000), D('0.01'), None), (D(2000000), D('0.009'), None), (D(5000000), D('0.008'), None), (D(10000000), D('0.007'), None), (D(20000000), D('0.006'), None), (None, D('0.005'), None)]
def fee(x):
    x = D(x); total = D(50); low = D(10000)
    for up, rate, fixed in B[1:]:
        if x <= low: break
        hi = x if up is None else min(x, up); total += (hi - low) * rate; low = up if up is not None else x
    return total
print(fee(1250000))`),
    );
    assert.equal(r.code, 0, r.err);
    // 50 + 9 万 × 2.5% + 10 万 × 2% + 30 万 × 1.5% + 50 万 × 1% + 25 万 × 0.9% = 16,050
    assert.equal(r.out.trim(), "16050.000");
  });

  test("11 证据目录编号（awk 生成序号、页码区间）", async () => {
    writeFileSync(join(work, "证据.txt"), "借款合同|3\n银行转账凭证|5\n催款函|2\n");
    // just-bash 的 awk 把单字符 -F'|' 当正则处理（实测报错），写成 -F'[|]'（已写入模型可见的环境说明）
    const r = await run("11", `awk -F'[|]' 'BEGIN{p=1; print "序号,证据名称,页码"} {printf "%d,%s,%d-%d\\n", NR, $1, p, p+$2-1; p+=$2}' 证据.txt > 证据目录.csv && cat 证据目录.csv`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "序号,证据名称,页码\n1,借款合同,1-3\n2,银行转账凭证,4-8\n3,催款函,9-10\n");
  });

  test("12 案件清单去重排序（sort / uniq）", async () => {
    writeFileSync(join(work, "案件.txt"), "(2026)京0105民初123号\n(2025)沪0101民初9号\n(2026)京0105民初123号\n(2024)粤0304民初77号\n");
    const r = await run("12", "sort -u 案件.txt | wc -l && sort 案件.txt | uniq -d");
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "3\n(2026)京0105民初123号\n");
  });

  test("13 CSV → JSON 与 jq 查询", async () => {
    const r = await run(
      "13",
      `python3 -c "import csv, json; json.dump(list(csv.DictReader(open('要素表.csv', encoding='utf-8'))), open('要素表.json', 'w', encoding='utf-8'), ensure_ascii=False)" && jq -r '.[] | select((.["金额"] | tonumber) > 1000000) | .["甲方"]' 要素表.json`,
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "北京甲科技有限公司\n杭州戊网络有限公司\n");
  });

  test("14 合同版本比对（diff -u）", async () => {
    writeFileSync(join(work, "v1.txt"), "第一条 标的\n第二条 价款为100万元\n第三条 违约责任\n");
    writeFileSync(join(work, "v2.txt"), "第一条 标的\n第二条 价款为120万元\n第三条 违约责任\n第四条 争议解决\n");
    const r = await run("14", "diff -u v1.txt v2.txt > 比对.diff; echo $?; grep -c '^[+-]第' 比对.diff");
    assert.equal(r.out.trim().split("\n")[0], "1");
    assert.equal(r.out.trim().split("\n")[1], "3");
  });

  test("15 关键词频次统计（grep -o | sort | uniq -c）", async () => {
    const r = await run("15", `cat '${M()}/合同/'*.txt | grep -o '有限公司' | wc -l`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "6");
  });

  test("16 当事人名称批量统一（sed 就地替换，经提交写回）", async () => {
    writeFileSync(join(work, "代理词.txt"), "被告北京甲科技公司应当……北京甲科技公司辩称……\n");
    const r = await run("16", "sed -i 's/北京甲科技公司/北京甲科技有限公司/g' 代理词.txt && grep -c '北京甲科技有限公司' 代理词.txt");
    assert.equal(r.code, 0, r.err);
    assert.equal(readFileSync(join(work, "代理词.txt"), "utf8"), "被告北京甲科技有限公司应当……北京甲科技有限公司辩称……\n");
  });

  test("17 表格合并（按案号关联两表）", async () => {
    writeFileSync(join(work, "立案.csv"), "案号,原告\nA1,张三\nA2,李四\nA3,王五\n");
    writeFileSync(join(work, "判决.csv"), "案号,结果\nA2,支持\nA1,驳回\n");
    const r = await run(
      "17",
      py(`import csv
res = {r['案号']: r['结果'] for r in csv.DictReader(open('判决.csv', encoding='utf-8'))}
for r in csv.DictReader(open('立案.csv', encoding='utf-8')): print(r['案号'], r['原告'], res.get(r['案号'], '未结'))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "A1 张三 驳回\nA2 李四 支持\nA3 王五 未结\n");
  });

  test("18 XLSX 生成（标准库 zipfile 写最小工作簿并读回；openpyxl/XlsxWriter 随包后改用之）", async () => {
    const r = await run(
      "18",
      py(`import zipfile, csv
from xml.sax.saxutils import escape
rows = list(csv.reader(open('月度汇总.csv', encoding='utf-8')))
def cell(v, r, c):
    ref = chr(65 + c) + str(r + 1)
    try: float(v); return f'<c r="{ref}"><v>{v}</v></c>'
    except ValueError: return f'<c r="{ref}" t="inlineStr"><is><t>{escape(v)}</t></is></c>'
sheet = ''.join(f'<row r="{i+1}">' + ''.join(cell(v, i, j) for j, v in enumerate(r)) + '</row>' for i, r in enumerate(rows))
files = {
 '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
 '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
 'xl/workbook.xml': '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="月度汇总" sheetId="1" r:id="rId1"/></sheets></workbook>',
 'xl/_rels/workbook.xml.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
 'xl/worksheets/sheet1.xml': '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + sheet + '</sheetData></worksheet>',
}
with zipfile.ZipFile('月度汇总.xlsx', 'w', zipfile.ZIP_DEFLATED) as z:
    for k, v in files.items(): z.writestr(k, v)
z = zipfile.ZipFile('月度汇总.xlsx'); print(sorted(z.namelist())[-1], z.read('xl/worksheets/sheet1.xml').decode().count('<row'))`),
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "xl/worksheets/sheet1.xml 13");
    const buf = readFileSync(join(work, "月度汇总.xlsx"));
    assert.equal(buf.readUInt32LE(0), 0x04034b50, "提交到盘上的是合法 ZIP（二进制内容经提交不失真）");
  });

  test("19 YAML 清单处理（yq）", async () => {
    writeFileSync(join(work, "期限.yaml"), "期限:\n  - 名称: 举证期限\n    截止: 2026-10-20\n  - 名称: 上诉期\n    截止: 2026-10-26\n");
    const r = await run("19", `yq '.["期限"][] | select(.["截止"] < "2026-10-25") | .["名称"]' 期限.yaml`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "举证期限");
  });

  test("20 工作日计算（排除周末与法定节假日清单）", async () => {
    const r = await run(
      "20",
      py(`from datetime import date, timedelta
holidays = {date(2026, 10, d) for d in range(1, 9)}
def add_workdays(d, n):
    while n:
        d += timedelta(days=1)
        if d.weekday() < 5 and d not in holidays: n -= 1
    return d
print(add_workdays(date(2026, 9, 28), 5))`),
    );
    assert.equal(r.code, 0, r.err);
    // 9/29、9/30 两个工作日；10/1–10/8 假日；10/9（周五）、10/12、10/13（未计调休）
    assert.equal(r.out.trim(), "2026-10-13");
  });

  test("22 可信命令 kwl-docx：读取起诉状段落、由文本生成意见书 DOCX、两版段落比对（无修订痕迹的改动被标出）", async () => {
    const r = await run(
      "22",
      `kwl-docx text '${M()}/文书/起诉状-03.docx' | head -2
printf '## 一、案件事实\\n双方于 2025 年签订买卖合同。\\n## 二、法律意见\\n建议先行发送律师函。\\n' | kwl-docx create 意见书.docx 法律意见书
kwl-docx text 意见书.docx
printf '## 一、案件事实\\n双方于 2025 年签订买卖合同。\\n## 二、法律意见\\n建议直接提起诉讼。\\n' | kwl-docx create 意见书-v2.docx 法律意见书
kwl-docx compare 意见书.docx 意见书-v2.docx`,
    );
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trim().split("\n");
    assert.deepEqual(lines.slice(0, 2), ["民事起诉状（第3号）", "原告：测试原告3有限公司"]);
    assert.deepEqual(lines.slice(2, 7), ["法律意见书", "一、案件事实", "双方于 2025 年签订买卖合同。", "二、法律意见", "建议先行发送律师函。"]);
    // 文书引擎的段落比对：改写的段落记为“删除原段 + 新增新段”；两处都没有修订痕迹（直接改写而非修订模式）
    assert.match(r.out, /新增 1，删除 1，修改 0，其中未留修订痕迹 2/);
    assert.match(r.out, /-（无修订痕迹） 建议先行发送律师函。\n\+（无修订痕迹） 建议直接提起诉讼。/);
    assert.equal(readFileSync(join(work, "意见书.docx")).readUInt32LE(0), 0x04034b50);
  });

  test("23 可信命令 kwl-xlsx：CSV → XLSX（数值列为数字），标准库读回校验", async () => {
    const r = await run(
      "23",
      `kwl-xlsx from-csv 月度汇总.csv 月度汇总-正式.xlsx 月度汇总 && ${py(`import zipfile
z = zipfile.ZipFile('月度汇总-正式.xlsx')
x = z.read('xl/worksheets/sheet1.xml').decode()
print(x.count('<row'), x.count('t="inlineStr"'), 'name="月度汇总"' in z.read('xl/workbook.xml').decode())`)}`,
    );
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "13 16 True"); // 文本单元格：表头 4 个 + 月份列 12 个（2026-01 等不是数值）；金额列为数字
  });

  test("21 SQL 汇总（shell sqlite3；Python 的 sqlite3 模块在此 CPython 构建中不可用）", async () => {
    const r = await run("21", `sqlite3 :memory: "create table t(k text, v real); insert into t values ('甲', 1.5), ('乙', 2), ('甲', 3); select k, sum(v) from t group by k order by k;"`);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), "乙|2\n甲|4.5"); // sql.js 的数值输出：2 而不是 2.0
  });
});
