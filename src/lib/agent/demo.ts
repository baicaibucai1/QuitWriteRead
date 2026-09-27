/*
 * 演示模式：**不连模型**也能把整条链路跑一遍。
 *
 * ## 为什么要有它
 *
 * 接入一个内核，最先要回答的不是"它能不能说出漂亮话"，而是
 * **"事件流、工具调用、权限、预算这几层是不是真的接上了"**。
 * 拿真模型去验这件事，得先有 Key、得联网、还得碰运气（模型今天想不想调工具是不一定的）。
 * 内核自带 `MockProvider`：回合可以写死，**第几步调哪个工具是确定的**，
 * 于是"工具真的被调了、结果真的回到模型眼前"这两件事第一次就能看见。
 *
 * ## 它演的是哪几步
 *
 *   ① 先 `list_notes` —— 逼它去看真实仓库里到底有哪些笔记（不许瞎编路径）；
 *   ② 拿回清单后 `read_note` 读第一篇 —— 证明工具结果真的回到了下一轮请求里；
 *   ③ 最后开口 —— 而且**只能照着工具回的东西说**。
 *
 * ⛔ 它不代替真模型：写死的两步只是为了验链路，不是"助手的思考"。
 */
import { MockProvider } from './core/provider/mock';
import type { MockTurn } from './core/provider/mock';

/** 从这一轮请求里把最后一条工具结果捞出来（模型看到的就是这个） */
function lastToolText(messages: { role: string; content?: unknown }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'tool') return typeof m.content === 'string' ? m.content : '';
  }
  return '';
}

export function createDemoProvider(): MockProvider {
  const turns: MockTurn[] = [
    // ① 先列一遍 —— 工具名和参数都是真的，跑的是真 Repo
    { toolCalls: [{ name: 'list_notes', args: {} }] },
    // ② 读清单里的第一篇（清单是**上一步真跑出来的**，不是写死的）
    //
    // ⚠️ 只认 `.md` 结尾的行：仓库空的时候 `list_notes` 回的是一句人话
    // （「（没有匹配的笔记）」），拿它当路径去读，读出来的会是"读不出来…"，
    // 于是演示第一眼看到的就是一次失败 —— 那是脚本的错，不是仓库的错。
    (req) => {
      const first = lastToolText(req.messages)
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.endsWith('.md'));
      if (!first) return { text: '（演示）工具说仓库里一篇笔记都没有 —— 先去左栏建一篇吧。' };
      return { toolCalls: [{ name: 'read_note', args: { path: first } }] };
    },
    // ③ 只照着读到的东西说话
    (req) => {
      const body = lastToolText(req.messages).trim();
      const head = body.split('\n').filter(Boolean).slice(0, 3).join(' / ');
      return {
        text:
          `（演示模式，没有连真模型）\n\n` +
          `我走了两步真工具：先 list_notes 列出仓库，再 read_note 读了第一篇。\n` +
          (head ? `读到的开头是：${head.slice(0, 160)}\n\n` : '') +
          `接上真模型之后，同样的两步、同样的工具结果，最后这句话换成模型来说。`,
      };
    },
  ];
  return new MockProvider(turns);
}

/** 演示模式在设置页里要跟人说清的三行 */
export const DEMO_NOTES = [
  '不连网络、不用 Key。',
  '工具是真的：走的还是你仓库里那堆 md。',
  '最后那句话是写死的 —— 它证明的是链路通，不是模型聪明。',
];
