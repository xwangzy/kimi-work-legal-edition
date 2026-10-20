/** 线性图标（内联 SVG，不加载外部资源）。 */
import type { ReactNode } from "react";

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const Icon = {
  plus: () => <Svg><path d="M12 5v14M5 12h14" /></Svg>,
  folder: () => <Svg><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></Svg>,
  inbox: () => <Svg><path d="M4 13h4l2 3h4l2-3h4" /><path d="M5 5h14l1 8v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5z" /></Svg>,
  file: () => <Svg><path d="M7 3h7l5 5v12a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" /><path d="M14 3v5h5" /></Svg>,
  book: () => <Svg><path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h10" /></Svg>,
  bell: () => <Svg><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></Svg>,
  board: () => <Svg><rect x="3" y="4" width="8" height="7" rx="1.5" /><rect x="13" y="4" width="8" height="4" rx="1.5" /><rect x="13" y="10" width="8" height="10" rx="1.5" /><rect x="3" y="13" width="8" height="7" rx="1.5" /></Svg>,
  clock: () => <Svg><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></Svg>,
  plug: () => <Svg><path d="M9 3v5M15 3v5" /><path d="M7 8h10v3a5 5 0 0 1-10 0z" /><path d="M12 16v5" /></Svg>,
  gear: () => <Svg><circle cx="12" cy="12" r="3" /><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6" /></Svg>,
  chat: () => <Svg><path d="M4 5h16v11H9l-5 4z" /></Svg>,
  send: () => <Svg><path d="M5 12h13M13 6l6 6-6 6" /></Svg>,
  shield: () => <Svg><path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6z" /></Svg>,
  cpu: () => <Svg><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4" /></Svg>,
  globe: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></Svg>,
  search: () => <Svg><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></Svg>,
  check: () => <Svg><path d="M5 12.5l4.5 4.5L19 7.5" /></Svg>,
  x: () => <Svg><path d="M6 6l12 12M18 6L6 18" /></Svg>,
  chevron: () => <Svg><path d="M9 6l6 6-6 6" /></Svg>,
  down: () => <Svg><path d="M6 9l6 6 6-6" /></Svg>,
  eye: () => <Svg><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></Svg>,
  lock: () => <Svg><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></Svg>,
  attach: () => <Svg><path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7L9.7 17.2a1.7 1.7 0 0 1-2.4-2.4L15 7" /></Svg>,
  slash: () => <Svg><path d="M15 4L9 20" /></Svg>,
  at: () => <Svg><circle cx="12" cy="12" r="3.5" /><path d="M15.5 12v1.5a2.5 2.5 0 0 0 5 0V12a8.5 8.5 0 1 0-3.3 6.7" /></Svg>,
  question: () => <Svg><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14" /><path d="M12 17h.01" /></Svg>,
  list: () => <Svg><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" /></Svg>,
  device: () => <Svg><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>,
};
