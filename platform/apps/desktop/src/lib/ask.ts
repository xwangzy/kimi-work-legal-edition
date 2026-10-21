/**
 * 应用内的二选一询问（Z3 #13 / I2 遗留）：替代浏览器原生确认框——Electron 下它的按钮是英文 OK / Cancel，
 * 且“取消”在保存位置提示里表示“换一个位置”，容易误读。由 components/AskHost.tsx 渲染；没有挂载时按“不同意”处理。
 */
export interface AskRequest {
  title: string;
  body: string;
  /** 同意按钮（主按钮）。 */
  yes: string;
  /** 不同意按钮。 */
  no: string;
}

type Host = (req: AskRequest) => Promise<boolean>;
let host: Host | null = null;

export function setAskHost(h: Host | null): void {
  host = h;
}

export function ask(req: AskRequest): Promise<boolean> {
  return host ? host(req) : Promise.resolve(false);
}
