/**
 * 品牌标识（第 48 批）：Kimi 官方素材包的 Logomark（圆角方块 + K + 蓝点，路径取自 Logomark_Light.svg，未改形）。
 * 颜色不写在路径上，由令牌 --brand-mark-bg / --brand-mark-fg / --brand-mark-dot 给出：浅色为官方 Light 版（黑底白 K），
 * 深色为官方 Dark 版（白底黑 K），蓝点两套相同。
 *
 * 组合见下方 BrandLockup。
 */
export function KimiMark({ className = "" }: { className?: string }) {
  return (
    <svg className={`logo-mark ${className}`.trim()} viewBox="0 0 180 180" aria-hidden="true" focusable="false">
      <rect className="logo-mark-bg" width="180" height="180" rx="45" />
      <path
        className="logo-mark-dot"
        d="M139.13 36.5137C144.237 36.5137 148.377 40.6535 148.377 45.7602C148.377 50.867 144.237 55.0068 139.13 55.0068L130.972 55.0068C130.371 55.0068 129.884 54.5198 129.884 53.919L129.884 45.7602C129.884 40.6535 134.024 36.5137 139.13 36.5137Z"
      />
      <path
        className="logo-mark-k"
        d="M87.2905 90.3594L122.186 55.739C122.842 55.0865 122.473 53.7744 121.625 53.7744H102.848C102.644 53.7744 102.447 53.8577 102.288 54.0174L64.6898 91.3104C64.1035 91.8866 63.2366 91.3729 63.2366 90.4496V54.8782C63.2366 54.2673 62.8351 53.7744 62.3443 53.7744H49.406C48.9152 53.7744 48.5137 54.2673 48.5137 54.8782V131.575C48.5137 132.186 48.9152 132.679 49.406 132.679H62.3443C62.8351 132.679 63.2366 132.186 63.2366 131.575V115.948C63.2366 115.615 63.3577 115.295 63.5681 115.087L75.2254 103.522C75.5058 103.244 75.8946 103.202 76.2069 103.411L107.386 126.354C112.492 129.791 118.196 131.901 123.99 132.526C124.506 132.581 124.952 132.068 124.952 131.422V116.705C124.952 116.142 124.614 115.684 124.162 115.615C120.752 115.08 117.425 113.761 114.417 111.734L87.4244 92.1921C86.8635 91.8172 86.7934 90.8523 87.2905 90.3594Z"
      />
    </svg>
  );
}

/**
 * 版本标签（第 55 批）：黑底小标“法律版”，与首页中央字标右上角的小标同一个图形（Kimi 自己的写法是“KIMI”+ 小标“WORK”）。
 * 画成图形而不是文字：10.5px 的字不在 7 级正文字号里。中文字都是全角方块，宽度不随字体变，第 72 批起不再用 textLength 挤压字距；
 * 字重走令牌（.brand-tag-text）：Windows 落到随包 Noto Sans SC 600，macOS 落到苹方中粗，两端同重。
 */
export function EditionTag({ text = "法律版", className = "" }: { text?: string; className?: string }) {
  const chars = [...text].length;
  const w = Math.round(chars * 11.5 + 9);
  return (
    <svg className={`brand-tag ${className}`.trim()} viewBox={`0 0 ${w} 17`} width={w} height={17} aria-hidden="true" focusable="false">
      <rect className="brand-tag-bg" width={w} height={17} rx={4.5} />
      <text className="brand-tag-text" x={w / 2} y={12.4} textAnchor="middle" fontSize="10.5">
        {text}
      </text>
    </svg>
  );
}

/**
 * 标识 + 名称 + 版本小标（第 55 批重做）：一行组合“[K] Kimi Work〔法律版〕”，与首页中央字标是同一套写法的小号版本。
 * 历史：第 48 批是“Kimi Work │ 法律版”（细竖线 + 灰字，版本名像一段说明文字）；第 51 批改成两行签名（第二行灰色小字“法律行业发行版”），
 * 但首页中央是“粗体字标 + 黑色小标”，侧栏却是“细字 + 灰字”，同一个产品两种写法。现在统一：
 *  - “Kimi Work”是粗体字标（图形：内联 SVG 文字），与首页中央字标同一种画法。第 72 批（D-300 第 3 条）起用随包字体“KWL Brand”
 *    （Inter 800 拉丁子集，assets/fonts），两端逐像素一致；不再用 textLength 把系统字体挤成定宽（Windows 落到 Segoe UI Black 后字距被挤没）。
 *    viewBox 宽度按这款字体实测的字宽定（15.6px、字距 -0.02em 时约 77.2）；
 *  - 版本名是黑底小标（EditionTag），垂直居中略上提 1px，读作“Kimi Work 的法律版”；
 *  - 标识（官方 Logomark）26px，与字标的大写字高、小标高度成一组（26 / 17 ≈ 1.5）。
 * size="lg" 用在启动页与登录页（标识 36px、字标 20px），比例相同。收起的侧栏只留标识（compact）。
 */
export function BrandLockup({ edition = "法律版", compact = false, size = "sm" }: { edition?: string; compact?: boolean; size?: "sm" | "lg" }) {
  return (
    <span className={`brand-lockup${compact ? " compact" : ""}${size === "lg" ? " brand-lg" : ""}`} aria-label={`Kimi Work ${edition}`}>
      <KimiMark className="brand-logo" />
      {!compact && (
        <span className="brand-words" aria-hidden="true">
          <svg className="brand-word" viewBox="0 0 78 20" role="presentation">
            <text className="brand-wordmark-text" x="0" y="15.4" fill="currentColor" fontSize="15.6">
              Kimi Work
            </text>
          </svg>
          <EditionTag text={edition} />
        </span>
      )}
    </span>
  );
}
