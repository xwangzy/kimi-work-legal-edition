/**
 * 品牌标识（第 48 批）：Kimi 官方素材包的 Logomark（圆角方块 + K + 蓝点，路径取自 Logomark_Light.svg，未改形）。
 * 颜色不写在路径上，由令牌 --brand-mark-bg / --brand-mark-fg / --brand-mark-dot 给出：浅色为官方 Light 版（黑底白 K），
 * 深色为官方 Dark 版（白底黑 K），蓝点两套相同。
 *
 * 组合（BrandLockup）：标识 + “Kimi Work” + 细竖线 + 版本名。版本名是从属层级（小一号、字重 500、标签灰、略加字距），
 * 与主名之间用细竖线分隔，而不是紧贴在主名后面的灰色小字——读起来是“Kimi Work 的法律版”，不是两段文字拼在一起。
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

/** 标识 + 名称 + 版本名。edition 缺省“法律版”；登录页用全称“法律行业发行版”。 */
export function BrandLockup({ edition = "法律版", compact = false }: { edition?: string; compact?: boolean }) {
  return (
    <span className={`brand-lockup${compact ? " compact" : ""}`} aria-label={`Kimi Work ${edition}`}>
      <KimiMark className="brand-logo" />
      {!compact && (
        <span className="brand-words" aria-hidden="true">
          <span className="brand-word">Kimi Work</span>
          <span className="brand-divider" />
          <span className="brand-edition">{edition}</span>
        </span>
      )}
    </span>
  );
}
