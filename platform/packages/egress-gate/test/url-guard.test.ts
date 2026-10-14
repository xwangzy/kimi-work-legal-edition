/**
 * 闸门 /fetch 的 URL 检查与本机抓取（第 02 篇 §8.3 URL 行；第 04 篇 §5.1、§2 网页抓取行：DNS 重绑定、重定向、私网、元数据地址、超大文件全拒）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MatterTokenizer } from "@zr-legal/tokenizer";
import { checkUrlStatic, isPublicAddress } from "../src/url-guard.ts";
import { FetchDenied, gateFetch, htmlToText } from "../src/fetcher.ts";

test("地址分类：私网、回环、链路本地（含元数据）、CGNAT、组播、保留与 IPv6 嵌入的这些地址都不是公网", () => {
  for (const ip of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "240.0.0.1", "198.18.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "::ffff:10.0.0.1"]) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ["114.114.114.114", "223.5.5.5", "2400:3200::1", "8.8.8.8"]) assert.equal(isPublicAddress(ip), true, ip);
  assert.equal(isPublicAddress("not-an-ip"), false);
});

test("静态检查：只 http(s)、无口令、标准端口；本机与内网主机名、数字主机名、搜索引擎与回显站点拒绝", () => {
  const bad: [string, string][] = [
    ["file:///etc/passwd", "scheme_not_allowed"],
    ["ftp://example.com/a", "scheme_not_allowed"],
    ["https://user:pw@example.com/", "credentials_in_url"],
    ["https://example.com:22/", "port_not_allowed"],
    ["http://localhost/", "host_not_public"],
    ["http://gate.kwl/m/x/v1", "host_not_public"],
    ["http://printer.local/", "host_not_public"],
    ["http://127.0.0.1/", "address_not_public"],
    ["http://[::1]/", "address_not_public"],
    ["http://169.254.169.254/latest/meta-data/", "address_not_public"],
    // WHATWG URL 把数字主机名规范化为点分 IPv4（2130706433 → 127.0.0.1），随即按地址拒绝
    ["http://2130706433/", "address_not_public"],
    ["http://0x7f.1/", "address_not_public"],
    ["https://www.baidu.com/s?wd=合同纠纷", "search_or_echo_site"],
    ["https://cn.bing.com/search?q=x", "search_or_echo_site"],
    ["https://webhook.site/abc", "search_or_echo_site"],
  ];
  for (const [u, reason] of bad) {
    const v = checkUrlStatic(u);
    assert.equal(v.ok, false, u);
    assert.equal(!v.ok && v.reason, reason, u);
  }
  const ok = checkUrlStatic("https://www.court.gov.cn/zixun/xiangqing/12345.html#top");
  assert.equal(ok.ok, true);
  assert.equal(ok.ok && ok.url.hash, "");
});

test("URL 不得携带事项信息：标识符、当事人实体、已知自然人姓名、可疑长编码串一律拦截（含 URL 编码）", () => {
  const tz = new MatterTokenizer({ matterKey: Buffer.alloc(32, 3), parties: [{ name: "甲科技有限公司", kind: "org" }, { name: "孙悦", kind: "person" }] });
  const cases: [string, string][] = [
    ["https://example.com/q?phone=13800138000", "identifier_in_url"],
    [`https://example.com/q?id=${encodeURIComponent("110101198005010033")}`, "identifier_in_url"],
    [`https://example.com/news?kw=${encodeURIComponent("甲科技有限公司 诉讼")}`, "party_entity_in_url"],
    [`https://example.com/p/${encodeURIComponent("孙悦")}`, "person_name_in_url"],
    [`https://example.com/x?d=${"QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xt"}`, "encoded_payload_in_url"],
    [`https://example.com/x/${"0123456789abcdef0123456789abcdef01234567"}`, "encoded_payload_in_url"],
  ];
  for (const [u, reason] of cases) {
    const v = checkUrlStatic(u, tz);
    assert.equal(v.ok, false, u);
    assert.equal(!v.ok && v.reason, reason, u);
  }
  assert.equal(checkUrlStatic("https://flk.npc.gov.cn/detail2.html?ZmY4MDgx", tz).ok, true);
});

async function listen(handler: Parameters<typeof createServer>[1]): Promise<{ server: Server; port: number }> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { server, port: (server.address() as AddressInfo).port };
}

test("抓取：DNS 解析出私网/回环地址即拒绝（任何一个地址不是公网都拒绝，防混合应答与重绑定）", async () => {
  await assert.rejects(
    gateFetch("http://rebind.example/", { resolver: async () => [{ address: "127.0.0.1", family: 4 }] }),
    (e: unknown) => e instanceof FetchDenied && e.reason === "address_not_public",
  );
  await assert.rejects(
    gateFetch("http://mixed.example/", { resolver: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] }),
    (e: unknown) => e instanceof FetchDenied && e.reason === "address_not_public",
  );
});

test("抓取（测试用：地址准入放行回环、允许测试端口）：连接钉在已校验地址；每跳重定向重新校验——跳到元数据地址或内网主机名即拒绝；超大响应截断；非文本类型拒绝", async () => {
  const { server, port } = await listen((req, res) => {
    if (req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<html><head><style>x{}</style><script>evil()</script></head><body><h1>裁判文书</h1><p>第一段</p><p>第二段</p></body></html>");
    } else if (req.url === "/to-meta") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    } else if (req.url === "/to-local") {
      res.writeHead(301, { location: "http://intranet.local/secret" });
      res.end();
    } else if (req.url === "/big") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("x".repeat(300_000));
    } else if (req.url === "/bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.alloc(10));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    // 生产缺省：只允许公网地址、标准端口——测试服务器在回环随机端口上，缺省设置下必须被拒
    await assert.rejects(gateFetch(`http://public.example:${port}/page`), (e: unknown) => e instanceof FetchDenied && e.reason === "port_not_allowed");
    await assert.rejects(
      gateFetch(`http://public.example:${port}/page`, { allowedPorts: [port], resolver: async () => [{ address: "127.0.0.1", family: 4 }] }),
      (e: unknown) => e instanceof FetchDenied && e.reason === "address_not_public",
    );
    // 测试专用放行：public.example → 127.0.0.1
    const opts = {
      allowedPorts: [port, 80],
      resolver: async () => [{ address: "127.0.0.1", family: 4 as const }],
      addressPolicy: (ip: string) => ip === "127.0.0.1" || isPublicAddress(ip),
    };
    const page = await gateFetch(`http://public.example:${port}/page`, opts);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes("裁判文书") && page.text.includes("第二段") && !page.text.includes("evil"));
    await assert.rejects(gateFetch(`http://public.example:${port}/to-meta`, opts), (e: unknown) => e instanceof FetchDenied && e.reason === "address_not_public");
    await assert.rejects(gateFetch(`http://public.example:${port}/to-local`, opts), (e: unknown) => e instanceof FetchDenied && e.reason === "host_not_public");
    const big = await gateFetch(`http://public.example:${port}/big`, { ...opts, limits: { maxBytes: 100_000 } });
    assert.equal(big.truncated, true);
    assert.equal(big.bytes, 100_000);
    await assert.rejects(gateFetch(`http://public.example:${port}/bin`, opts), (e: unknown) => e instanceof FetchDenied && e.reason === "content_type_not_allowed");
  } finally {
    server.close();
  }
});

test("HTML 转文本：去脚本、样式、注释与标签，块级换行，实体还原", () => {
  assert.equal(htmlToText("<p>甲&amp;乙</p><script>x</script><!-- c --><div>丙&lt;丁&gt;</div>"), "甲&乙\n丙<丁>");
});
