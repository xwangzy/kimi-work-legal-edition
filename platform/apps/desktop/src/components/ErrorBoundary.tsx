/**
 * 页面级错误边界（UIUX 评审 P0-7）：任一页面渲染出错只影响该页面，侧栏仍可用；兜底页说明“事项和文件没有受影响”，
 * 诊断信息只含错误类型、消息首行与路由，不含事项内容。
 */
import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  routeLabel: string;
}

interface State {
  error: Error | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  private diagnostics(): string {
    const e = this.state.error;
    // 只给页面与错误类型（复核 S5A-15：错误消息可能夹带材料或当事人文字，不进剪贴板）；详细排查用设备页的脱敏诊断包
    const name = /^[A-Za-z]{1,40}$/.test(e?.name ?? "") ? e!.name : "Error";
    return [`页面：${this.props.routeLabel}`, `错误类型：${name}`, `时间：${new Date().toISOString()}`].join("\n");
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="main">
        <div className="main-narrow error-page">
          <h1 className="page-title">这个页面出了点问题</h1>
          <p>你的事项和文件没有受影响。可以返回首页继续工作，或重新载入这个页面。</p>
          <div className="error-actions">
            <button className="btn-primary" onClick={() => (window.location.hash = "/")}>返回首页</button>
            <button className="btn-ghost" onClick={() => this.setState({ error: null, copied: false })}>重新载入</button>
            <button
              className="btn-ghost"
              onClick={() => {
                void navigator.clipboard?.writeText(this.diagnostics()).then(() => this.setState({ copied: true }));
              }}
            >
              {this.state.copied ? "已复制" : "复制诊断信息给管理员"}
            </button>
          </div>
        </div>
      </main>
    );
  }
}
