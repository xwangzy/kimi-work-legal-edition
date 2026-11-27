// 由虚机交来的 client-inputs（与 make-release-config 同一份输入）生成律师端开发实例的环境变量（JSON；PEM 带真实换行）
import { readFileSync, writeFileSync } from "node:fs";
const here = new URL(".", import.meta.url).pathname;
const spec = JSON.parse(readFileSync(here + "client-inputs/client-release-spec.json", "utf8"));
const bak = readFileSync(here + "client-inputs/pins.txt", "utf8").split("\n")[0].trim().split(/\s+/)[3];
const pins = (n) => [...spec.pins[n], bak].join(",");
const env = {
  ZR_CONTROL_PLANE_BASE: spec.control_plane_base,
  ZR_CONTROL_PLANE_PINS: pins("control_plane"),
  ZR_CONTROL_PLANE_KEYS: JSON.stringify(JSON.parse(readFileSync(here + "cp-public-keys.json", "utf8"))),
  ZR_SEAT_KEYS: JSON.stringify(JSON.parse(readFileSync(here + "seat-public-keys.json", "utf8"))),
  ZR_GATEWAY_BASE: spec.gateway_base, ZR_GATEWAY_PINS: pins("gateway"),
  ZR_SEARCH_BASE: spec.search_base, ZR_SEARCH_PINS: pins("search"),
  ...(spec.relay_base ? { ZR_RELAY_BASE: spec.relay_base, ZR_RELAY_PINS: pins("relay") } : {}),
  ZR_CLOUD_CA_PEM: readFileSync(here + "client-inputs/demo-ca.crt", "utf8"),
  ZR_REQUIRE_CONTROL_PLANE: "1", ZR_ONBOARDING: "1", ZR_MODEL_PROVIDER: "upstream",
};
writeFileSync(here + (process.argv[2] ?? "client-env.json"), JSON.stringify(env, null, 1));
console.log(Object.keys(env).map((k) => `${k}=${k.endsWith("PEM") ? "(PEM)" : env[k].slice(0, 70)}`).join("\n"));
