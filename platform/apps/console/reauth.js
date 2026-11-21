/**
 * 复核框（契约 §2.3；D-218 起只要密码）：危险操作遇 401 reauth_required 时弹出，再输一次密码。
 *
 * 复核：POST /v1/auth/reauth {password}；成功后 api.js 自动重试原请求，10 分钟内同类操作不再询问。
 *   复核框用单独的 <dialog id="reauth">，叠在确认框之上（确认框里的操作正在等它）。
 */
import * as api from "./api.js";
import { $, clear, errText, h, icon, toast } from "./ui.js";

/**
 * 复核框：只要密码。返回 Promise<boolean>。
 * @param {{reason?:string, email?:string}} o
 */
export function reauthDialog(o = {}) {
  const d = $("#reauth");
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
      if (d.open) d.close();
    };
    const err = h("p", { class: "form-error", role: "alert" });
    const pw = h("input", { type: "password", name: "password", autocomplete: "current-password", id: "ra-pw" });
    const ok = h("button", { type: "submit", class: "btn primary" }, "复核并继续");
    const cancel = h("button", { type: "button", class: "btn", onclick: () => finish(false) }, "取消");
    const f = h(
      "form",
      { class: "modal-form", novalidate: true },
      h("h2", { class: "modal-title" }, icon("shield"), "复核身份"),
      h("p", { class: "modal-lead" }, o.reason ?? "这是一项危险操作：请再输一次密码。复核后 10 分钟内同类操作不再询问。"),
      h("input", { type: "text", name: "username", autocomplete: "username", value: o.email ?? "", hidden: true }),
      h("div", { class: "field" }, h("label", { for: "ra-pw" }, "密码"), pw),
      err,
      h("div", { class: "modal-actions" }, cancel, ok),
    );
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.textContent = "";
      if (!pw.value) return void ((err.textContent = "请输入密码"), pw.focus());
      ok.disabled = cancel.disabled = true;
      try {
        await api.auth.reauth(pw.value);
        pw.value = "";
        toast("已复核");
        finish(true);
      } catch (e) {
        err.textContent = errText(e);
        ok.disabled = cancel.disabled = false;
        pw.select();
      }
    });
    d.className = "modal";
    clear(d, f);
    d.onclose = () => finish(false);
    d.oncancel = (ev) => {
      if (cancel.disabled) ev.preventDefault();
    };
    d.showModal();
    pw.focus();
  });
}
