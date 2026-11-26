/**
 * 重新登录（第 64 批）：已激活的电脑上退出登录、会话失效或账号停用之后，整窗显示这一页，不再在工作区顶部嵌一条带登录框的横幅。
 * - 工作区（侧栏与各页）在这期间整个不渲染：卸载比遮挡更能保证别人坐到这台电脑前看不到事项与成果；
 * - 第 68 批（V42，D-294）：任何合法账号都可以在这里登录——刚才那个账号回到原来的工作空间；别的账号打开它自己的工作空间
 *   （这台电脑上第一次登录的按云端设备策略登记），各账号的资料互不可见。这里没有“注册”；忘记密码（含重置码、设置码）照常可用；
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
      <AuthCard foot={<>也可以换一个账号登录：会打开那个账号自己的工作空间，各账号的事项、材料和成果互不可见。登录只把手机号或邮箱、验证码或密码发给 Kimi Work 服务核对，你的案卷不会上传。</>}>
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
