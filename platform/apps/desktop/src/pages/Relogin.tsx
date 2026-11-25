/**
 * 重新登录（第 64 批）：已激活的电脑上退出登录、会话失效或账号停用之后，整窗显示这一页，不再在工作区顶部嵌一条带登录框的横幅。
 * - 工作区（侧栏与各页）在这期间整个不渲染：卸载比遮挡更能保证别人坐到这台电脑前看不到事项与成果；
 * - 只能登录这台电脑登记的那位成员（内核与云端都会核对），这里没有“注册”；忘记密码（含管理员给的重置码、设置码）照常可用；
 * - 登录成功后回到退出前的那一页（地址栏的页面不变，各页重新挂载、重新取数据）；
 * - 本机的事项、材料、成果都不删；“要重新登录”记在本机（内核 keys/account-login-required.json），重启应用、断网时也停在这一页。
 * 可见文字保留“你已退出登录”（验收脚本据此判断退出成功）。
 */
import { AuthCard, AuthPage } from "../components/AuthShell.tsx";
import { LoginBox } from "../components/AccountPanel.tsx";
import { reloginView } from "../lib/account.ts";

export function ReloginPage(p: { reason: string | null; email: string; firm?: string | null; member?: string | null; notice?: string; onDone: () => void }) {
  const v = reloginView(p.reason);
  const who = (p.member ?? "").trim();
  return (
    <AuthPage kind="relogin">
      <AuthCard foot={<>只有这台电脑登记的成员可以在这里登录；要换别人使用这台电脑，请联系律所管理员。登录只把手机号或邮箱、验证码或密码发给 Kimi Work 服务核对，你的案卷不会上传。</>}>
        {p.notice && (
          <p className="activate-error" role="alert">
            {p.notice}
          </p>
        )}
        <h1 className="activate-title">{v.title}</h1>
        <p className="auth-greet-sub">{v.lead}</p>
        {(who || p.firm || p.email) && (
          <div className="auth-reloginwho">
            <span className="user-avatar" aria-hidden="true">
              {[...(who || p.email || "律")][0]}
            </span>
            <span className="auth-reloginwho-text">
              <b>{who || p.email}</b>
              <small>{[p.firm ? `「${p.firm}」` : "", who && p.email ? p.email : ""].filter(Boolean).join(" · ") || "这台电脑登记的成员"}</small>
            </span>
          </div>
        )}
        <LoginBox page email={p.email} onDone={p.onDone} />
      </AuthCard>
    </AuthPage>
  );
}
