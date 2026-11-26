/**
 * 重新登录（第 64 批）：已激活的电脑上退出登录、会话失效或账号停用之后，整窗显示这一页，不再在工作区顶部嵌一条带登录框的横幅。
 * - 工作区（侧栏与各页）在这期间整个不渲染：卸载比遮挡更能保证别人坐到这台电脑前看不到事项与成果；
 * - 第 68 批（V42，D-294）：任何合法账号都可以在这里登录——刚才那个账号回到原来的工作空间；别的账号打开它自己的工作空间
 *   （这台电脑上第一次登录的按云端设备策略登记），各账号的资料互不可见。这里没有“注册”；忘记密码（含重置码、设置码）照常可用；
 * - 第 69 批（V43）：与开通页同一张卡、同一套节奏。缺省是“回到刚才的账号”（显示头像、姓名与邮箱，邮箱已填好）；
 *   标题行右侧“换个账号”进入另一个账号的登录（清空预填，页脚此时才说明“各账号分开保存、互不可见”——说明出现在用到它的时候）。
 *   原来的两行说明（“请重新登录，或换一个账号登录。这台电脑上的事项、材料和成果都还在；登录后 AI 恢复可用。”）与三行页脚删去；
 * - 登录成功后回到退出前的那一页（地址栏的页面不变，各页重新挂载、重新取数据）；
 * - 本机的事项、材料、成果都不删；“要重新登录”记在本机（内核 keys/account-login-required.json），重启应用、断网时也停在这一页。
 * 可见文字保留“你已退出登录”（验收脚本据此判断退出成功）。
 */
import { useState } from "react";
import { AuthCard, AuthPage, AuthPrivacy } from "../components/AuthShell.tsx";
import { LoginBox } from "../components/AccountPanel.tsx";
import { reloginView } from "../lib/account.ts";

export function ReloginPage(p: { reason: string | null; email: string; firm?: string | null; member?: string | null; notice?: string; onDone: () => void }) {
  const v = reloginView(p.reason);
  const who = (p.member ?? "").trim();
  const known = !!(who || p.email);
  // 这台电脑已从账号移除：原账号不能再在这里登录——直接给“登录其他账号”，标题与说明仍讲清原因
  const revoked = p.reason === "device_revoked";
  // 这台电脑已从账号移除：原账号不能再在这里登录——直接给“登录其他账号”，标题与说明仍讲清原因
  const [other, setOther] = useState(false);
  return (
    <AuthPage kind="relogin">
      <AuthCard foot={<AuthPrivacy>{(other || revoked) && "各账号的事项、材料和成果分开保存，互不可见。"}</AuthPrivacy>}>
        {p.notice && (
          <p className="activate-error" role="alert">
            {p.notice}
          </p>
        )}
        <div className="auth-title-row">
          <h1 className="auth-title">{other ? "登录其他账号" : v.title}</h1>
          {known && !revoked && (
            <button type="button" className="btn-link" onClick={() => setOther((x) => !x)}>
              {other ? "返回" : "换个账号"}
            </button>
          )}
        </div>
        {!other && v.lead && <p className="auth-lead">{v.lead}</p>}
        {!other && known && !revoked && (
          <div className="auth-reloginwho">
            <span className="user-avatar" aria-hidden="true">
              {[...(who || p.email || "律")][0]}
            </span>
            <span className="auth-reloginwho-text">
              <b>{who || p.email}</b>
              <small>{[p.firm ? p.firm : "", who && p.email ? p.email : ""].filter(Boolean).join(" · ") || "这台电脑登记的成员"}</small>
            </span>
          </div>
        )}
        <LoginBox key={other || revoked ? "other" : "me"} page subtle email={other || revoked ? "" : p.email} onDone={p.onDone} />
        {/* 第三轮（独立评审 R2-3）：“不是本人移除的？”在标题下的说明里（reloginView），不放在登录按钮下面——那里像登录报错 */}
      </AuthCard>
    </AuthPage>
  );
}
