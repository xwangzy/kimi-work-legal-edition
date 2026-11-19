/**
 * 两步验证（契约 §2.3）：绑定流程（受限会话与“账号与安全”共用）、复核框（401 reauth_required 时弹出）、恢复码一次性展示。
 *
 * 绑定：POST /v1/auth/mfa/totp/setup → {secret, otpauth_uri}：显示二维码（qr.js，本页编码，不经第三方）与可手动输入的密钥；
 *   输入身份验证器里的 6 位码 → POST /v1/auth/mfa/totp/enable {code} → {recovery_codes}：**只显示这一次**，
 *   必须勾选“我已保存”才能完成；可复制或存为文本文件。
 * 复核：POST /v1/auth/reauth {password, code}；成功后 api.js 自动重试原请求。复核框用单独的 <dialog id="reauth">，
 *   叠在确认框之上（确认框里的操作正在等它）。
 */
import * as api from "./api.js";
import { encodeQr, qrPath } from "./qr.js";
import { $, btn, clear, copyBtn, errText, h, icon, normCode, otpInput, qrElement, toast } from "./ui.js";

const groupSecret = (s) => String(s).replace(/\s+/g, "").replace(/(.{4})/g, "$1 ").trim();

/**
 * 在容器里走一遍绑定；完成时 onDone(recoveryCodes)。
 * @param {HTMLElement} box
 * @param {{onDone:(codes:string[])=>void, onCancel?:()=>void, cancelLabel?:string, intro?:string}} o
 */
export async function enrollFlow(box, o) {
  clear(box, h("div", { class: "state state-loading", role: "status" }, h("span", { class: "spinner", "aria-hidden": "true" }), "正在生成密钥…"));
  let setup;
  try {
    setup = await api.auth.totpSetup();
  } catch (e) {
    clear(box, h("div", { class: "state state-error", role: "alert" }, h("b", {}, e.code === "not_ready" ? "接口未就绪" : "生成失败"), h("p", {}, errText(e)), btn("重试", () => enrollFlow(box, o), { size: "sm" })), o.onCancel ? btn(o.cancelLabel ?? "返回", o.onCancel, { class: "link-btn" }) : null);
    return;
  }
  let qrBox;
  try {
    const qr = encodeQr(setup.otpauth_uri);
    qrBox = h("div", { class: "qr-frame" }, qrElement(qr, { label: "用身份验证器扫描此二维码" }, qrPath));
  } catch (e) {
    qrBox = h("div", { class: "qr-frame qr-missing" }, h("p", { class: "muted small" }, `二维码生成不了（${e.message}）：请用下面的密钥手动添加。`));
  }
  const err = h("p", { class: "form-error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary" }, "验证并启用");
  const code = otpInput({ onFull: () => form.requestSubmit() });
  const form = h(
    "form",
    { class: "enroll-verify", novalidate: true },
    h("label", { class: "step-label" }, h("span", { class: "step-no" }, "2"), "输入身份验证器显示的 6 位码"),
    code,
    err,
    h("div", { class: "btn-row" }, submit, o.onCancel ? btn(o.cancelLabel ?? "取消", o.onCancel) : null),
  );
  form.addEventListener("submit", async (ev) => {
    ev.preventDefault();
    err.textContent = "";
    const c = normCode(code.value);
    if (c.length !== 6) return void ((err.textContent = "请输入 6 位数字"), code.focus());
    submit.disabled = true;
    try {
      const r = await api.auth.totpEnable(c);
      showRecovery(box, r.recovery_codes ?? [], o.onDone);
    } catch (e) {
      err.textContent = errText(e);
      code.select();
    } finally {
      submit.disabled = false;
    }
  });
  clear(
    box,
    h(
      "div",
      { class: "enroll" },
      o.intro ? h("p", { class: "enroll-intro" }, o.intro) : null,
      h(
        "div",
        { class: "enroll-scan" },
        qrBox,
        h(
          "div",
          { class: "enroll-steps" },
          h("label", { class: "step-label" }, h("span", { class: "step-no" }, "1"), "用身份验证器扫码"),
          h("p", { class: "muted small" }, "在手机上打开 Microsoft Authenticator、Google 身份验证器或其他支持 TOTP 的应用，添加账户并扫描左侧二维码。"),
          h("details", { class: "manual-key" }, h("summary", {}, "扫不了？手动输入密钥"), h("div", { class: "secret-box" }, h("code", { class: "secret", "aria-label": "密钥" }, groupSecret(setup.secret)), copyBtn(setup.secret)), h("p", { class: "muted small" }, "类型：基于时间；位数：6；间隔：30 秒。")),
        ),
      ),
      form,
    ),
  );
  code.focus();
}

/** 恢复码：只显示一次；勾选“我已保存”后才能完成 */
export function showRecovery(box, codes, onDone) {
  const ok = h("input", { type: "checkbox", id: "rc-saved" });
  const done = h("button", { type: "button", class: "btn primary", disabled: true, onclick: () => onDone(codes) }, "完成");
  ok.addEventListener("change", () => (done.disabled = !ok.checked));
  const text = `Kimi Work 法律版 · 两步验证恢复码\n每个只能用一次；手机丢失时用来登录。\n\n${codes.join("\n")}\n`;
  clear(
    box,
    h(
      "div",
      { class: "recovery" },
      h("div", { class: "recovery-head" }, h("span", { class: "ok-mark", "aria-hidden": "true" }, icon("check")), h("div", {}, h("b", {}, "两步验证已启用"), h("p", { class: "muted small" }, "下面是 8 个恢复码。手机丢失或换机时，用其中一个代替 6 位码登录；每个只能用一次。"))),
      h("ol", { class: "recovery-codes" }, codes.map((c) => h("li", {}, h("code", {}, c)))),
      h("p", { class: "modal-note warn" }, "只显示这一次：离开后无法再查看。请存进密码管理器，或打印后放在安全的地方。"),
      h(
        "div",
        { class: "btn-row" },
        copyBtn(codes.join("\n"), "复制全部"),
        btn("存为文本文件", () => api.saveBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), "kimi-work-recovery-codes.txt"), { size: "sm", icon: icon("download") }),
      ),
      h("label", { class: "field-check", for: "rc-saved" }, ok, h("span", {}, "我已把恢复码保存在安全的地方")),
      h("div", { class: "btn-row end" }, done),
    ),
  );
}

/**
 * 复核框：密码 + 6 位码（未启用两步验证的账号只要密码）。返回 Promise<boolean>。
 * @param {{mfa?:boolean, reason?:string}} o
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
    let recovery = false;
    const codeWrap = h("div", { class: "field" });
    let code = null;
    const drawCode = () => {
      code = otpInput({ recovery, onFull: () => f.requestSubmit() });
      clear(codeWrap, h("label", {}, recovery ? "恢复码" : "身份验证器 6 位码"), code, h("button", { type: "button", class: "link small", onclick: () => ((recovery = !recovery), drawCode(), code.focus()) }, recovery ? "改用 6 位码" : "手机不在身边？用恢复码"));
    };
    if (o.mfa !== false) drawCode();
    const ok = h("button", { type: "submit", class: "btn primary" }, "复核并继续");
    const cancel = h("button", { type: "button", class: "btn", onclick: () => finish(false) }, "取消");
    const f = h(
      "form",
      { class: "modal-form", novalidate: true },
      h("h2", { class: "modal-title" }, icon("shield"), "复核身份"),
      h("p", { class: "modal-lead" }, o.reason ?? "这是一项危险操作：请再输一次密码与验证码。复核后 10 分钟内同类操作不再询问。"),
      h("input", { type: "text", name: "username", autocomplete: "username", value: o.email ?? "", hidden: true }),
      h("div", { class: "field" }, h("label", { for: "ra-pw" }, "密码"), pw),
      o.mfa !== false ? codeWrap : null,
      err,
      h("div", { class: "modal-actions" }, cancel, ok),
    );
    f.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      err.textContent = "";
      if (!pw.value) return void ((err.textContent = "请输入密码"), pw.focus());
      const c = code ? normCode(code.value, recovery) : "";
      if (code && !recovery && c.length !== 6) return void ((err.textContent = "请输入 6 位验证码"), code.focus());
      if (code && recovery && c.length < 8) return void ((err.textContent = "请输入完整的恢复码"), code.focus());
      ok.disabled = cancel.disabled = true;
      try {
        await api.auth.reauth(pw.value, c || undefined);
        pw.value = "";
        toast("已复核");
        finish(true);
      } catch (e) {
        err.textContent = errText(e);
        ok.disabled = cancel.disabled = false;
        if (code) code.select();
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
