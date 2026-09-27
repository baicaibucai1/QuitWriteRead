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
 * ## 两档脚本
 *
 *   · `read`  —— 列出笔记 → 读第一篇 → 开口。**不碰你的东西**。
 *   · `write` —— 追加一篇 → 开口。**会真的写一篇**（`agent/演示-<日期>.md`），
 *                而且中途**必然弹一次权限卡** —— 这一档存在的全部理由就是让人
 *                亲眼确认「问一句 → 点了允许 → 文件真的变了」这条链路走得通。
 *                ⚠️ 所以它不是摆设：点它之前就知道它会落一篇。
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

/** 演示写要落的那篇。日期进了文件名，一天点几次也不会互相盖掉 */
export function demoNotePath(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `agent/演示-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.md`;
}

function readTurns(): MockTurn[] {
  return [
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
}

function writeTurns(): MockTurn[] {
  return [
    /*
     * 直接调 `append_note` —— 它没标 readOnly，内核在 default 模式下走到最后一句
     * "No rule allows …"，于是**必定**弹卡。这一档演示的就是那张卡。
     */
    (req) => {
      const round = req.messages.filter((m) => m.role === 'user').length;
      return {
        toolCalls: [
          {
            name: 'append_note',
            args: {
              /*
               * 路径固定成 `agent/演示-<日期>.md`，**不从用户那句话里抠**。
               * 抠出来的东西有可能是任何地方 —— 演示不该有把用户的某篇真笔记
               * 改掉的机会，哪怕概率很小。它要写在哪儿必须是可预见的。
               */
              path: demoNotePath(),
              content: `这是助手在演示里追加的第 ${round} 段 —— 时间是 ${new Date().toLocaleTimeString('zh-CN')}。`,
            },
          },
        ],
      };
    },
    // 收尾：把工具回的那句话原样说出来（被拒时会不一样 —— 这就对了）
    (req) => {
      const res = lastToolText(req.messages).trim();
      return {
        text:
          `（演示：写）\n\n${res}\n\n` +
          `上面这一步是 append_note —— 它不是只读工具，所以内核先问了你要不要。\n` +
          `点了「就这一次」它才真的写；点那几个拒绝的，它就没动 —— 那种时候它不该说"写好了"。`,
      };
    },
  ];
}

/**
 * 演示用的 provider。
 *
 * 基类 `MockProvider` 的回合游标是**实例级**的（`turn++` 不随 run 回到 0），
 * 于是脚本只有三步时，问第二句就开始答"没有编排了" —— 表现为第一次能调工具、
 * 第二次直接开口，看着像随机失灵。
 * 演示要的恰恰相反：**每一句提问都把这套脚本重走一遍**，所以这里认「新一轮」，
 * 从头再演。判据是这一帧请求的最后一条是不是刚发出来的 user 消息 ——
 * 一个 run 内部还会来好几帧（工具结果回灌），那些不能算新一轮。
 */
class DemoProvider extends MockProvider {
  constructor(script: () => MockTurn[]) {
    super(script());
  }

  stream(req: Parameters<MockProvider['stream']>[0], opts: Parameters<MockProvider['stream']>[1]) {
    const last = req.messages[req.messages.length - 1];
    // ⛔ 别去碰基类的 turns 数组（它是 private，而且本来也没被消耗 —— 游标归零就够了）
    if (last?.role === 'user') this.reset();
    return super.stream(req, opts);
  }
}

export function createDemoProvider(kind: 'read' | 'write' = 'read'): MockProvider {
  return new DemoProvider(kind === 'write' ? writeTurns : readTurns);
}
