// 统一的线性图标集。全部 16x16、currentColor、1.5 描边，跟正文同色系。
import type { ReactNode } from 'react';

export type IconProps = {
  size?: number;
  className?: string;
  strokeWidth?: number;
};

function Svg({
  size = 16,
  className,
  strokeWidth = 1.5,
  children,
}: IconProps & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export const Chevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.1 3.4 10.7 8l-4.6 4.6" />
  </Svg>
);

export const Minus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.6 8h8.8" />
  </Svg>
);

export const Book = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.2 3.1h4a2 2 0 0 1 2 2v9.4a1.6 1.6 0 0 0-1.6-1.4H3.2V3.1Z" />
    <path d="M12.8 3.1h-4a2 2 0 0 0-2 2v9.4a1.6 1.6 0 0 1 1.6-1.4h4.4V3.1Z" />
  </Svg>
);

/** 摊开的书 —— 书架里标「正在读」那本 */
export const BookOpen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 4.2C6.5 3.1 4.6 2.6 2.6 2.6v9.6c2 0 3.9.5 5.4 1.6 1.5-1.1 3.4-1.6 5.4-1.6V2.6c-2 0-3.9.5-5.4 1.6Z" />
    <path d="M8 4.2v9.6" />
  </Svg>
);

export const FileText = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.1 1.9H5.3a1.5 1.5 0 0 0-1.5 1.5v9.2a1.5 1.5 0 0 0 1.5 1.5h5.4a1.5 1.5 0 0 0 1.5-1.5V4.9L9.1 1.9Z" />
    <path d="M9 1.9v3.1h3.2" />
    <path d="M5.9 8.7h4.2M5.9 11h2.7" />
  </Svg>
);

export const Folder = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.1 5.2a1.3 1.3 0 0 1 1.3-1.3h2.4l1.3 1.6h5.5a1.3 1.3 0 0 1 1.3 1.3v4.9a1.3 1.3 0 0 1-1.3 1.3H3.4a1.3 1.3 0 0 1-1.3-1.3V5.2Z" />
  </Svg>
);

export const Plus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3.4v9.2M3.4 8h9.2" />
  </Svg>
);

export const Refresh = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 8a5.5 5.5 0 0 1 9.4-3.9" />
    <path d="M13.5 8a5.5 5.5 0 0 1-9.4 3.9" />
    <path d="M12.3 1.9v3.2H9.1" />
    <path d="M3.7 14.1v-3.2h3.2" />
  </Svg>
);

export const ArrowUp = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 13V3.2" />
    <path d="M4.3 6.9 8 3.2l3.7 3.7" />
  </Svg>
);

export const ArrowDown = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 3v9.8" />
    <path d="M4.3 9.1 8 12.8l3.7-3.7" />
  </Svg>
);

export const Alert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.4 14.4 13.2H1.6L8 2.4Z" />
    <path d="M8 6.4v2.9" />
    <path d="M8 11.3h.01" />
  </Svg>
);

export const Key = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="5.4" cy="10.6" r="2.7" />
    <path d="M7.3 8.7 13.2 2.8" />
    <path d="M11 5l1.5 1.5" />
  </Svg>
);

export const Close = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.2 4.2 11.8 11.8M11.8 4.2 4.2 11.8" />
  </Svg>
);

export const Trash = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.9 4.4h10.2" />
    <path d="M6.3 4.4V3.3a1 1 0 0 1 1-1h1.4a1 1 0 0 1 1 1v1.1" />
    <path d="M4.3 4.4l.6 8.1a1.2 1.2 0 0 0 1.2 1.1h3.8a1.2 1.2 0 0 0 1.2-1.1l.6-8.1" />
  </Svg>
);

export const Check = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.3 8.4 6.5 11.6 12.7 4.8" />
  </Svg>
);

export const Cloud = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 12.2h7.1a2.6 2.6 0 0 0 .3-5.2 3.6 3.6 0 0 0-7-1 2.8 2.8 0 0 0-.4 6.2Z" />
  </Svg>
);

export const Eye = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.7 8c1.4-2.6 3.6-4.2 6.3-4.2S12.9 5.4 14.3 8c-1.4 2.6-3.6 4.2-6.3 4.2S3.1 10.6 1.7 8Z" />
    <circle cx="8" cy="8" r="2.1" />
  </Svg>
);

export const EyeOff = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.7 4.1a7 7 0 0 1 1.3-.1c2.7 0 4.9 1.6 6.3 4.2a10.7 10.7 0 0 1-2.3 2.9" />
    <path d="M4.4 5A10.6 10.6 0 0 0 1.7 8c1.4 2.6 3.6 4.2 6.3 4.2 1 0 1.9-.2 2.8-.7" />
    <path d="M6.7 6.7a2 2 0 0 0 2.7 2.7" />
    <path d="M2.6 2.6l10.8 10.8" />
  </Svg>
);

export const Pen = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.1 12.9l.7-2.8 6.4-6.4a1.35 1.35 0 0 1 1.9 1.9L5.9 12.2l-2.8.7Z" />
    <path d="M9.4 4.5l2.1 2.1" />
  </Svg>
);

/** 窄屏顶栏的抽屉开关 */
export const Menu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.4 4.3h11.2M2.4 8h11.2M2.4 11.7h11.2" />
  </Svg>
);

/**
 * 「更多」：三个点。**横向**排（⋯），不是纵向（⋮）——
 * 工具条是横着排的一行，纵向三个点会像抓手/排序把手。
 * 点是实心小圆（`fill`），不用空心圈：13px 里空心圈只剩一个灰环，认不出是点。
 */
export const MoreDots = (p: IconProps) => (
  <Svg {...p} strokeWidth={0}>
    <circle cx="3.6" cy="8" r="1.15" fill="currentColor" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    <circle cx="12.4" cy="8" r="1.15" fill="currentColor" />
  </Svg>
);

/**
 * 设置：一枚齿轮（齿环 + 中孔）。
 *
 * ⚠️ 它不吃上面那个 16 网格的 `Svg` 包装，自己开一格 24 网格：
 * 齿轮的齿是一圈圆弧咬合，压到 16 格里齿会糊成一团太阳 ——
 * 第一版就是这么画的（中心圆点 + 八根放射短线），被用户当成亮度/加载图标吐槽了。
 * 24 格下描边 2，缩到 16px 显示时视觉粗细与别的 1.5 描边图标对齐。
 * 用的是 lucide `settings` 的公开画法（ISC 许可）。
 */
export const Gear = ({ size = 16, className, strokeWidth = 2 }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={strokeWidth}
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.08a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

/** 新建文件夹：一枚文件夹 + 加号 */
export const FolderPlus = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.9 4.3a1.2 1.2 0 0 1 1.2-1.2h2.5l1.2 1.5h5a1.2 1.2 0 0 1 1.2 1.2v6.4a1.2 1.2 0 0 1-1.2 1.2H3.1a1.2 1.2 0 0 1-1.2-1.2V4.3Z" />
    <path d="M8 7.4v3.4M6.3 9.1h3.4" />
  </Svg>
);

/** 顶栏那个分支名前面挂的小钩子 —— 让「分支」不需要再用文字解释一遍 */
export const Branch = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="4.6" cy="3.6" r="1.5" />
    <circle cx="4.6" cy="12.4" r="1.5" />
    <path d="M4.6 5.1v5.8" />
    <circle cx="11.4" cy="12.4" r="1.5" />
    <path d="M11.4 10.9V8.4a2.3 2.3 0 0 0-2.3-2.3H8.1" />
  </Svg>
);

/* ---------- 编辑器工具栏 ---------- */

export const Bold = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.6 2.7h3.7a2.55 2.55 0 0 1 0 5.1H4.6z" />
    <path d="M4.6 7.8h4.3a2.75 2.75 0 0 1 0 5.5H4.6z" />
  </Svg>
);

export const Italic = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.4 2.9h4.2M5.4 13.1h4.2M9.7 2.9 6.3 13.1" />
  </Svg>
);

export const Strike = (p: IconProps) => (
  <Svg {...p}>
    <path d="M11.5 4.4C10.8 3.4 9.7 2.9 8 2.9c-2 0-3.4.9-3.4 2.2 0 .7.4 1.2 1 1.6" />
    <path d="M4.4 11.6c.7 1 1.9 1.5 3.7 1.5 2.2 0 3.6-.9 3.6-2.3 0-.7-.3-1.2-.9-1.6" />
    <path d="M2.4 8h11.2" />
  </Svg>
);

export const InlineCode = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5.7 4.9 2.4 8l3.3 3.1" />
    <path d="M10.3 4.9 13.6 8l-3.3 3.1" />
  </Svg>
);

export const Link = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.7 9.3a2.6 2.6 0 0 0 3.7 0l2.3-2.3a2.62 2.62 0 0 0-3.7-3.7l-1 1" />
    <path d="M9.3 6.7a2.6 2.6 0 0 0-3.7 0l-2.3 2.3a2.62 2.62 0 0 0 3.7 3.7l1-1" />
  </Svg>
);

/** 标签：一个带孔的牌子。正文里的 `#tag` 和筛选条上都用它 */
export const Tag = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8.6 2.4H3.1a.7.7 0 0 0-.7.7v5.5c0 .18.07.36.2.49l5.2 5.2a.69.69 0 0 0 .98 0l4.8-4.8a.69.69 0 0 0 0-.98L8.6 2.4Z" />
    <circle cx="5.7" cy="5.7" r="1.1" />
  </Svg>
);

/** 反向链接：一支拐回来的箭头 —— 「有人从那边指过来」 */
export const Backlink = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 4.5 4.8 8.6 9 12.7" />
    <path d="M4.8 8.6h4.9a3.3 3.3 0 0 1 0 6.6H8" />
  </Svg>
);

export const ListBullet = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 4.2h7.2M6.2 8h7.2M6.2 11.8h7.2" />
    {/* 圆点靠 linecap 画，2.6 才够显眼 —— 1.5 的时候缩到 16px 就看不见了 */}
    <path d="M2.8 4.2h.01M2.8 8h.01M2.8 11.8h.01" strokeWidth={2.6} />
  </Svg>
);

export const ListOrdered = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.6 4.2h6.8M6.6 8h6.8M6.6 11.8h6.8" />
    <path d="M2.3 3.3l.9-.6v3" strokeWidth={1.3} />
    <path d="M2.2 7.6c.5-.5 1.4-.4 1.4.3 0 .6-1.4 1.1-1.4 2h1.6" strokeWidth={1.3} />
  </Svg>
);

export const Quote = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.9 3.2v9.6" />
    <path d="M6.4 5.4h6.8M6.4 8h6.8M6.4 10.6h4" />
  </Svg>
);

export const CodeBlock = (p: IconProps) => (
  <Svg {...p}>
    <rect x="1.7" y="3.1" width="12.6" height="9.8" rx="1.7" />
    <path d="M6.9 6.7 5.5 8.1l1.4 1.4" />
    <path d="M9.1 6.7l1.4 1.4-1.4 1.4" />
  </Svg>
);

export const Divider = (p: IconProps) => (
  <Svg {...p}>
    <path d="M1.9 8h3.4M10.7 8h3.4" />
    <path d="M8 8h.01" strokeWidth={2.2} />
  </Svg>
);

/*
 * 「高亮笔」。阅读器（BookPane）划词高亮用 —— 别当成富文本工具栏的遗留删掉。
 */
export const Highlighter = ({ swatch = 'currentColor', ...p }: IconProps & { swatch?: string }) => (
  <Svg {...p}>
    <path d="M9.5 2.6 13.4 6.5 7.3 12.6H3.4V8.7Z" />
    <path d="M8.4 3.7 12.3 7.6" />
    <path d="M3.4 14.2h9.2" strokeWidth={2.4} stroke={swatch} />
  </Svg>
);

/** 图片附件：方框 + 山头 + 太阳（和"文件"一眼分得开） */
export const Image = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.3" y="2.9" width="11.4" height="10.2" rx="1.6" />
    <circle cx="5.6" cy="6.1" r="1" />
    <path d="M2.9 11.4l3-3 2.4 2.4 2-1.8 2.8 2.4" />
  </Svg>
);

/** PDF 附件：一个文件 + 右下折角，角里那条横线是"文档"的意思 */
export const FilePdf = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.1 1.9H5.3a1.5 1.5 0 0 0-1.5 1.5v9.2a1.5 1.5 0 0 0 1.5 1.5h5.4a1.5 1.5 0 0 0 1.5-1.5V4.9L9.1 1.9Z" />
    <path d="M9 1.9v3.1h3.2" />
    <path d="M5.7 10.4h1.6a.9.9 0 0 0 0-1.8H5.7v3.6" />
    <path d="M10.3 10.4V8.6h.9a.9.9 0 0 1 0 1.8h-.9" />
  </Svg>
);

/** 上传附件：一个托盘 + 向上的箭头 */
export const Upload = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 10.2v1.6a1.3 1.3 0 0 0 1.3 1.3h8.2a1.3 1.3 0 0 0 1.3-1.3v-1.6" />
    <path d="M8 10.6V2.9M5.3 5.6 8 2.9l2.7 2.7" />
  </Svg>
);

/** 下载 / 另存 */
export const Download = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 10.2v1.6a1.3 1.3 0 0 0 1.3 1.3h8.2a1.3 1.3 0 0 0 1.3-1.3v-1.6" />
    <path d="M8 2.9v7.7M5.3 7.9 8 10.6l2.7-2.7" />
  </Svg>
);

/** 放大镜：放大 / 缩小 / 适应窗口三档，靠加减号和框区分 */
export const ZoomIn = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4 13.6 13.6M5.2 7h3.6M7 5.2v3.6" />
  </Svg>
);

export const ZoomOut = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7" cy="7" r="4.4" />
    <path d="M10.4 10.4 13.6 13.6M5.2 7h3.6" />
  </Svg>
);

/** 适应窗口：四角往里收 */
export const Fit = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.6 5.6V3.2a.6.6 0 0 1 .6-.6h2.4" />
    <path d="M13.4 5.6V3.2a.6.6 0 0 0-.6-.6h-2.4" />
    <path d="M2.6 10.4v2.4a.6.6 0 0 0 .6.6h2.4" />
    <path d="M13.4 10.4v2.4a.6.6 0 0 1-.6.6h-2.4" />
  </Svg>
);

/** 上一页 / 下一页（PDF 翻页） */
export const PagePrev = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9.8 3.6 5.4 8l4.4 4.4" />
  </Svg>
);

export const PageNext = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.2 3.6 10.6 8l-4.4 4.4" />
  </Svg>
);

/** 放大镜（文件树的搜索框） */
export const Search = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.2" cy="7.2" r="4.1" />
    <path d="m10.4 10.4 3.1 3.1" />
  </Svg>
);

/** 右栏开关：一块板子，右半边亮着 */
export const PanelRight = (p: IconProps) => (
  <Svg {...p}>
    <rect x="2.2" y="3.1" width="11.6" height="9.8" rx="1.4" />
    <path d="M9.4 3.1v9.8" />
    <path d="M11 5.6h1.4M11 7.8h1.4" />
  </Svg>
);

/** 改名（右键菜单）。一支斜放的笔 —— 和 Plus 那种"加东西"区分开 */
export const Pencil = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.4 2.6a1.5 1.5 0 0 1 2.1 2.1l-7 7-2.7.6.6-2.7 7-7Z" />
    <path d="m9.3 3.7 2.1 2.1" />
  </Svg>
);

/** 复制（复制路径 / 复制双链） */
export const Copy = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5.6" y="5.6" width="8" height="8.2" rx="1.4" />
    <path d="M10.6 3.4a1.4 1.4 0 0 0-1.4-1.2H3.8a1.4 1.4 0 0 0-1.4 1.4v5.5c0 .7.5 1.2 1.2 1.4" />
  </Svg>
);

/** 属性（右键菜单最后那一项）。圆圈里一个 i */
/** 四角星 —— 助手的标记。**别拿它当"更多"用**：它只表示"这是 AI 干的" */
export const Sparkle = (p: IconProps) => (
  <Svg {...p}>
    <path d="M8 2.4l1.15 3.05L12.2 6.6 9.15 7.75 8 10.8 6.85 7.75 3.8 6.6l3.05-1.15L8 2.4Z" />
    <path d="M12.6 10.4l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3Z" />
  </Svg>
);

export const Info = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="8" r="6" />
    <path d="M8 7.2v4.1" />
    <path d="M8 4.9h.01" />
  </Svg>
);
