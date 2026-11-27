/**
 * 连不上云端（第 72 批第二轮，端到端验收 Q-8；第三轮问答页同口径）：首页与问答页输入框上沿同一行提示。
 * 判断：额度查询（quota.status，本机内核代理到云端）报 provider_unavailable 即连不上；窗口回到前台、系统报“已联网”时再查，
 * 连不上期间每 30 秒查一次，连上即收起。本机的事项、材料、问答记录照常可看。
 */
import { useCallback, useEffect, useState } from "react";
import { api, type QuotaStatus } from "../api.ts";
import { nav } from "../App.tsx";

export function useCloudDown(onQuota?: (q: QuotaStatus | null) => void): boolean {
  const [down, setDown] = useState(false);
  const check = useCallback(() => {
    void api
      .quotaStatus()
      .then((q) => {
        onQuota?.(q);
        setDown(false);
      })
      .catch((e) => {
        onQuota?.(null);
        setDown((e as { code?: string }).code === "provider_unavailable");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    check();
    window.addEventListener("focus", check);
    window.addEventListener("online", check);
    return () => {
      window.removeEventListener("focus", check);
      window.removeEventListener("online", check);
    };
  }, [check]);
  useEffect(() => {
    if (!down) return;
    const t = setInterval(check, 30_000);
    return () => clearInterval(t);
  }, [down, check]);
  return down;
}

export function CloudDownNotice({ what = "本机的事项和材料照常可看" }: { what?: string }) {
  return (
    <div className="notice-row notice-offline" role="status">
      <span className="notice-dot" aria-hidden="true" />
      <span className="notice-text">连不上云端：AI 暂时不可用，{what}</span>
      <button
        className="btn-link"
        onClick={() => {
          nav("/connections/backup");
          setTimeout(() => document.getElementById("sec-conn")?.scrollIntoView({ block: "center" }), 300);
        }}
      >
        检测连接
      </button>
    </div>
  );
}
