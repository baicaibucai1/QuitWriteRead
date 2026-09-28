/*
 * 助手能用的全部工具，**一份名字表**。
 *
 * 为什么要单独一个文件、而且**不能 import 任何东西**：
 * 设置页要列这张表给人看，但它不该为此拉起整个内核（104 kB）——
 * 一个只是想改改同步凭据的人没理由下载agent 那一坨。
 * `lib/agent/index.ts` 会 import 这里；设置页也 import 这里；两边都不是对方。
 *
 * ⚠️ 加/删工具要同时改 `note-tools.ts` / `book-tools.ts` 和这张表 ——
 *    界面上写着"它能干什么"，那句话必须是真的。
 */
export type AgentToolRow = {
  name: string;
  what: string;
  /** 写工具 —— 主人关掉写权限时它就不装了 */
  write?: boolean;
};

export const AGENT_TOOLS: AgentToolRow[] = [
  { name: 'list_notes', what: '列出仓库里的笔记' },
  { name: 'read_note', what: '读一篇笔记' },
  { name: 'search_notes', what: '在全部笔记里搜一段' },
  { name: 'create_note', what: '新建一篇（那篇已存在就拒绝，不覆盖）', write: true },
  { name: 'write_note', what: '整篇改写（会先问一句）', write: true },
  { name: 'append_note', what: '往末尾追加一段（会先问一句）', write: true },
  { name: 'list_books', what: '列出书架上的书' },
  { name: 'read_book', what: '读一本书的某一章' },
  { name: 'search_book', what: '在一本书里搜一段' },
  { name: 'list_book_notes', what: '列出一本书的批注（划的那句 + 想法）' },
];

/**
 * 这套配置下**准不准它写**。
 *
 * ⚠️ **装配处（`ChatPane`）和设置页必须都用这一个函数**：
 * 设置页写着"7 个工具"而实际装了 9 个，那句话就成了谎话 ——
 * 而这张清单存在的全部理由就是让人知道它真能干什么。
 *
 * 口径只有一条：演示「写」那一档必然给（整场演示围着那张审批卡转），
 * 其余时候看 `allowWrite`。
 */
export function canWriteFiles(cfg: { demo: string; allowWrite: boolean }): boolean {
  return cfg.demo === 'write' || (cfg.demo === 'off' && cfg.allowWrite);
}

/** 这套配置下**真有**几个工具 */
export function countUsableTools(cfg: { demo: string; allowWrite: boolean }): number {
  const writing = canWriteFiles(cfg);
  return AGENT_TOOLS.filter((t) => !t.write || writing).length;
}
