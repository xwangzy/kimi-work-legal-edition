// ZP-17：google-auth-library 会直接调用 node:child_process（gcloud 凭据），发行版不使用 Google 提供方。
// 打包时以本桩替换；任何调用都失败关闭。
function disabled() {
  throw new Error("google-auth-library is not available in Kimi Work Legal (ZP-17)");
}
export class GoogleAuth {
  constructor() {
    disabled();
  }
}
export class OAuth2Client {
  constructor() {
    disabled();
  }
}
export class JWT {
  constructor() {
    disabled();
  }
}
export default { GoogleAuth, OAuth2Client, JWT };
