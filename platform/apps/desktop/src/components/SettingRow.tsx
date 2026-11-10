/**
 * 设置页的一行（V16 V-7 / C）：左边标签、右边说明与控件。通用页的“字号、外观”与“文书与写作”页的“文书版式、写作偏好”
 * 共用这一套：标签列同宽、同字重，说明一律写在控件上方一行（短说明；长说明收进“了解更多”）。
 */
import type { ReactNode } from "react";

export function SettingRow({ label, hint, badge, id, children }: { label: ReactNode; hint?: ReactNode; badge?: ReactNode; id?: string; children?: ReactNode }) {
  return (
    <div className="device-row setting-row" id={id}>
      <div className="device-k">
        {label}
        {badge}
      </div>
      <div className="setting-v">
        {hint && <div className="setting-hint">{hint}</div>}
        {children}
      </div>
    </div>
  );
}
