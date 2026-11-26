/**
 * 密码输入（第 44 批）：显示 / 隐藏切换；rules = 新密码时逐条显示规则（至少 10 位、字母 + 数字），满足的打勾。
 * 密码只在这台电脑的内存里经内核发给中软，不写进浏览器存储、不进日志。
 */
import { useId, useState } from "react";
import { passwordHints } from "../lib/account.ts";

export function PasswordField(p: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** 新密码：显示规则提示，浏览器按“新密码”处理自动填充。 */
  rules?: boolean;
  /** 规则里“不能和邮箱 @ 前面相同”要用到。 */
  email?: string;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const [focus, setFocus] = useState(false);
  const id = useId();
  const hints = p.rules ? passwordHints(p.value, p.email) : [];
  // 第 69 批（V43）：规则只在输入时出现（聚焦或已有内容且还没全部满足）；全部满足后收起——不再常驻一行“· 至少 10 位 · 包含字母 · 包含数字”
  const rulesShown = !!p.rules && (focus || p.value !== "") && hints.some((h) => !h.ok);
  return (
    <div className="field">
      <label htmlFor={id}>
        <span>{p.label}</span>
      </label>
      <div className="pw-wrap">
        <input
          id={id}
          className="auth-input"
          type={show ? "text" : "password"}
          value={p.value}
          onChange={(e) => p.onChange(e.target.value)}
          autoComplete={p.rules ? "new-password" : "current-password"}
          autoFocus={p.autoFocus}
          spellCheck={false}
          placeholder={p.placeholder}
          aria-describedby={p.rules ? `${id}-rules` : undefined}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
        />
        <button type="button" className="pw-toggle btn-link" aria-pressed={show} aria-label={show ? "隐藏密码" : "显示密码"} onClick={() => setShow((s) => !s)}>
          {show ? "隐藏" : "显示"}
        </button>
      </div>
      {p.rules && (
        <ul className={`pw-rules${rulesShown ? "" : " idle"}`} id={`${id}-rules`} aria-live="polite" aria-hidden={!rulesShown || undefined}>
          {hints.map((h) => (
            <li key={h.text} className={h.ok ? "ok" : p.value ? "bad" : ""}>
              {h.ok ? "✓ " : "· "}
              {h.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
