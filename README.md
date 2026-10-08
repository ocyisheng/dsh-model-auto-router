# dsh-model-auto-router

> [English](README.en.md) | 中文

面向 DeepSeek Harness 的**模型池路由**与**自动故障转移**插件。

- **主 Agent** 与每个**子 Agent** 从你配置的池中取模型,而不是固定绑定某一个模型。
- 当当前模型**不可用**(限流、过载、超时、5xx、DNS 故障、模型下线)时,插件在**下一次尝试**就切换到健康的备用路由——回合继续,用户看不到报错。
- 一个**设置页**(设置 → 模型自主路由)编辑模型池、角色分配与故障转移策略,并显示正在运行的 router 实际在做什么。它写入的正是手改编辑的同一份配置文件。

---

## 工作原理

插件安装 DSH 的两个 agent 瀑布。它们对主 Agent 和每个子 Agent 都生效,因为两者走的是同一个 agent 循环:

| 瀑布 | 职责 |
| --- | --- |
| `agent/request` | 替换下一步的冻结 `LlmCallConfig`。模型池在这里选路由。 |
| `agent/request-error` | 请求失败。当失败意味着「不可用」时降级该路由并返回 `{ kind: 'retry' }`,重新进入 `agent/request` 落到下一个候选。 |

因为选择发生在**每次请求**而非每个会话,故障转移立即生效——不需要重启,也不需要新会话。

### 故障转移的精确语义

1. 请求失败,插件对失败分类。
2. **不可用**(429、5xx、502/503/504/529、`model_overloaded`、`ECONNREFUSED`、`ENOTFOUND`、像 `SERVER` 这样的服务端码、**消息里引用的状态码**、provider 声称已下线的模型等)→ 该路由的失败计数增加。达到 `failureThreshold` 后该路由被**降级** `cooldownMs`。
3. 若存在健康的替代路由,插件返回 `{ kind: 'retry' }`,重新进入 `agent/request`。未达阈值时该路由仍算健康,所以这次重试会**落回同一条路由**——一次免费重试,这正是阈值存在的意义。达到阈值后该路由被跳过,重试才会换路。
4. **不可用以外的失败**(400、401/403、`context_length_exceeded` 等)→ 不做任何变化。换模型只会把一个错误答案换成另一个,由内建重试策略和正常错误路径处理。
5. 若**所有**路由都已降级且无备用,插件不会认领重试——真实错误会被呈现,而不是被掩盖。

关于这个分类的三点说明:

- **失败的含义可能只在消息里。** `LlmFailure` 的 `code` 是必填、`status` 是可选,而流内错误封装在分类时**根本没有 status 可传**——所以到达插件的是 `{ code: 'SERVER', message: 'Streaming response failed: [503] Upstream error from Nvidia: Service temporarily overloaded' }`,那个 503 **只在文本里**。只读 `status` 的分类器会看到一个未知失败,于是把一条明显过载的上游留在原地——一轮对话就这样无谓地结束了。因此插件会从消息里读出 `[503]`、`HTTP 503`、`status 503` 这类引用的状态码,并把 *temporarily overloaded* / *service unavailable* / *try again later* 这类措辞也当作不可用。
- **服务端码就是不可用。** `dsh-our-free-model` 在自己的源码里把词表一分为二:`CLIENT_ERROR` 对应 4xx,`SERVER` 则是可重试的那一桶,并明确说它不该是请求错误的兜底。它 `CODE` 表里的其余项(`TRANSPORT` 表示 fetch 失败、`RATE_LIMIT`、`TIMEOUT`、`EMPTY_RESPONSE`)指的是同一侧的故障,同样照此读取。所以一个不带其他细节的裸 `SERVER` 就是可用性信号。
- **模型下线被当作「不可用」,而不是「永久消失」。** provider 通常用自然语言而非错误码表达下线——`dsh-our-free-model` 会把 `Model X has been deprecated. Use Y instead.` 当作通用的客户端错误抛出——所以消息是唯一信号,本插件读取它。但「deprecated」是 provider 对自己目录的说法,同一条路由之后可能又能用(灰度发布、措辞夸大、上游轮换)。因此「下线」只决定**能否**发生故障转移,绝不决定需要失败几次:`failureThreshold` 始终是唯一的杠杆,把它设为 `1` 就能让下线在第一次错误时立刻切换。

消息里引用的 **4xx 仍然是请求错误**——`[400] bad request` 不会因为适配器把封装标成 `SERVER` 就触发切换——而一个有明确名字的请求错误(`invalid_request`)优先于消息里引用的 5xx。两个方向里只有一个是可恢复的,所以这个不对称是刻意的。

压缩(compact)和会话标题的调用**从不**改路由。这是**结构性**的,不是一个过滤器:这些调用直接通过 `ctx.llm` 流式生成——标题插件自己的封装有意不带 agent loop 的请求身份——所以它们压根不会到达 `agent/request` 监听器。

### 路由稳定性

一个 agent 除非其路由被降级,否则在其生命周期内固定在选定的路由上。这是刻意的:provider 的提示词缓存按模型索引,每步都重排会在每次调用上支付全额输入成本。因此 `round-robin` 与 `least-used` 策略是在 **agent 之间**分摊,而不是在单个 agent 内部。

### 思考强度属于模型,不属于请求

模型池会改变一个请求用哪个模型,而 `reasoningEffort` 是**模型**的属性,不是请求的。DSH 会解析它,并在**派发前校验这个组合**:

```
provider "our-free-model-vision" model "mimo-v2.5-free" does not support reasoning effort "high"
```

所以把 DSH 的 effort 原样带过一次模型切换,会把一次可恢复的故障转移变成硬失败——一次死在出口的转移。因此插件会做协调:通过 `llm.resolveModelInfo`(DSH 自己用的同一个调用)读取所选模型的能力,然后

- **模型接受时保留** effort,让显式设置得到尊重;
- **不接受时丢弃**它——读不到能力时也一样——让 DSH 回落到该模型自己的默认值。effort 缺省永远是合法的,所以「丢弃」是安全的方向。

能力按路由缓存五分钟:这段代码在请求路径上,而模型的思考支持不会在一秒之间变化。`llm.resolveModelInfo` 是公开的服务方法;若某个组合没有它,插件会丢弃 effort 而不是去猜。

---

## 安装

插件通过 profile 的 bundle 列表注册自身:

```
dsh install git+https://github.com/ocyisheng/dsh-model-auto-router.git
```

若要在本地开发,改为克隆仓库并把 `dsh install` 指向检出目录——profile 会将其记录为 `link:` 依赖,因此改动只需重新加载即生效,不必重装:

```
git clone https://github.com/ocyisheng/dsh-model-auto-router.git
dsh install .\dsh-model-auto-router
```

> 首次安装后请重启 DSH。宿主把插件模块缓存在其 ESM 注册表中,因此后续的文件编辑需要重启(或切换插件开关)才能生效。

## 配置

有两种编辑同一份文件的方式,且可互换:

- **设置页** —— Web 界面里的 设置 → **模型自主路由**;或
- **配置文件本身**,位于 `~/.dsh/model-auto-router.json`。

文件会被轮询并自动重载,因此手改无需重启即可生效。从页面保存会立即生效**并**写入文件,两者不会各说各话。

### 设置页

一页,从上往下读:

| 区块 | 作用 |
| --- | --- |
| 模型 | 本机能派发的 provider 与模型,按 provider 分组。点一下加入「加入」按钮选定的列表;筛选框可缩小范围。清单只展示系统提供的内容。 |
| 主 Agent | 主 Agent 故障时从上到下依次尝试的有序列表。其策略下拉决定**新** agent 如何分摊。 |
| 子 Agent | 子 Agent 取模型的列表。**留空时它不是一个设置——子 Agent 跟随主 Agent**,因为这正是子 Agent 没有专属池时 router 的行为。只有子 Agent 需要用别的模型时才填。 |
| 备用 | 可选。仅当上面的模型全部不可用时使用。 |
| 失败切换 | 连续失败多少次后降级一条路由,以及降级后冷却多久。 |

这里刻意没有「跟随主 Agent」开关。子 Agent 列表为空时就已经表达了那件事:`writeRoleList` 不会为空列表写入 `subagentPool`,router 于是回落到主池。这个列表是为**不是**默认的那种情况准备的——子 Agent 用自己的模型——而它的「没有」就是默认,不是一个待设置的偏好。

**一个池就是一条有序的故障转移链,所以页面呈现的正是这件事。** 配置的单位是角色指向的具名池——这对文件是对的,对人是错的,因为人在想「agent 该按什么顺序用哪些模型」。所以三个列表**就是**池:每个编辑其角色已指向的那个池,只在列表第一次被填时才创建。策略保留为每个列表一个控件,因为 `round-robin` 等是在 **agent 之间**分摊,有序列表展示不了这件事;池能表达的其余内容都在文件里。

清空列表会清空池但**不删除**池,因为你可能还在文件里指向它,或正准备重新填。底部的**诊断**折叠区承载配置路径和状态报告开关——与设置页呈现的路由状态一致——而不与主流程争夺注意力。

模型清单来自三个来源,按可信度降序:

1. **实际派发过** —— 本插件观察到宿主真正派发的 `provider/model` 对,由路由通道本身记录。构造上即为真实:有一次请求以该精确配对发出。
2. **Agent 的默认选择** —— 宿主配置使用的路由,在任何请求发生前即可用。
3. **`llm` 目录** —— 每个已注册 provider 及其适配器自报的模型。最全,也是唯一能展示本机尚未用过的模型的来源。

这个顺序正是重点。适配器的自述是**最弱**的证据——有些把模型清单放在自己的仓库里、通过 `listModels` 什么也不报——所以页面绝不单独依赖它。在所有适配器都拒绝自我介绍的宿主上,前两个来源仍能把页面填满可证明可用的路由。

关于清单,有三点是刻意的:

- **它只展示系统提供的内容,不自己加东西。** 清单只列出本机真正能派发的路由——已注册的 provider、观察到其派发过的路由,以及默认选择。没有自由文本入口:目录里没有的模型属于配置文件,那里可以直接写出完整的 `provider/model` 配对。
- **休眠路由会被列出并标注。** 某个适配器插件拥有但尚未激活的 provider 会标为 *未启用*,因为命名它正是它变得可用的方式。
- **读不到的清单会诚实降级。** 若 `llm` 注册表读不到,页面会说明并只列出实际派发过的路由,而不是暗示更短的清单就是全部。

还有两点值得了解:

- **角色只会默认指向存在的池。** 一个只有 `main` 池的文件加载时备用角色保持未设置,而不是指向一个从未声明的 `backup` 池——否则页面会打开一个它随后拒绝保存的配置。
- **`$comment` 键会被保留。** 保存会从文件中携带它们,包括 `health.$comment_threshold` 这类嵌套的,因此样例的自述文档在浏览器里编辑后仍能存活。保存**确实**整体替换名单:你在页面里删除的池会连同其注释一起消失。
- **页面不管理的键会被丢弃**,且页面会在你保存前列出它发现的顶层键。注释键是上面的例外;非注释键无法携带,因为你在页面里刚删掉的值会在下次保存时重新出现。

只要挂载了 web 服务器,页面就可用。在入口配置里设 `ui: false` 即可完全不带页面地运行路由。

### 配置文件

把 `model-auto-router.config.json` 复制到 `~/.dsh/model-auto-router.json`,或通过 profile 入口内联传入配置。

```jsonc
{
  "mainPool": "main",
  "subagentPool": "subagent",
  "fallbackPool": "backup",
  "health": { "failureThreshold": 2, "cooldownMs": 60000 },
  "pools": {
    "main": {
      "provider": "deepseek",
      "strategy": "primary-failover",
      "candidates": ["deepseek-chat", "deepseek-reasoner"]
    },
    "subagent": {
      "provider": "deepseek",
      "strategy": "round-robin",
      "candidates": ["deepseek-chat", "deepseek-reasoner"]
    },
    "backup": {
      "candidates": [
        { "provider": "deepseek", "model": "deepseek-chat" },
        { "provider": "openai",    "model": "gpt-5" }
      ]
    }
  }
}
```

### 候选写法

```jsonc
"candidates": [
  "deepseek-chat",                                  // 使用池的 provider
  { "model": "deepseek-reasoner" },                 // 同上
  { "provider": "openai", "model": "gpt-5" },       // 显式路由
  { "provider": "openai", "model": "gpt-5", "weight": 3 }
]
```

### 策略

| 策略 | 行为 |
| --- | --- |
| `primary-failover` | 池内顺序即优先级;agent 获得稳定路由。**默认。** |
| `round-robin` | 新 agent 按顺序轮流分配。 |
| `least-used` | 新 agent 分给使用最少的路由。 |
| `random` | 每个新 agent 等概率随机。 |
| `weighted-random` | 随机,按各候选的 `weight` 偏置。 |

### 健康设置

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `failureThreshold` | `2` | 一条路由被降级前的连续不可用失败次数。填 `1` 表示第一次错误就切换。 |
| `cooldownMs` | `60000` | 降级的路由被跳过多久后重试。 |

---

## 运行时查看与干预

路由状态通过**设置页**(见上方"设置页")实时呈现:池成员、各 agent 的指派、冷却中的路由与最近的切换一目了然。其背后是挂载在 `/api/model-auto-router` 的 HTTP 接口(见"设置页的 HTTP 接口"),`GET /report` 返回与设置页诊断区一致的纯文本报告,可直接复制粘贴或供外部脚本轮询。

---

## 入口配置

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `configPath` | `~/.dsh/model-auto-router.json` | JSON 配置的路径。 |
| `watch` | `true` | 轮询配置文件,变更时重载池。 |
| `router` | — | 内联配置,合并到文件内容**之下**。 |
| `enabled` | `true` | `false` 则完全不动 DSH 自己的模型选择。 |
| `ui` | `true` | 挂载设置页(在挂载了 web 服务器的组合上)。`false` 则无页面运行。 |
| `selfTest` | `false` | 启动时在进程内运行行为测试套件。 |
| `selfTestOut` | — | 把自测报告(JSON)写入该路径。 |

---

## 设置页的 HTTP 接口

浏览器半边是对宿主半边挂载在 `/api/model-auto-router` 的三个路由的薄渲染层:

| 路由 | 职责 |
| --- | --- |
| `GET /state` | 配置作为可编辑草稿,加上 router 的实时状态。 |
| `GET /catalog` | 本机能派发的 provider/model 路由,加上观察到其派发过的路由。 |
| `PUT /config` | 校验草稿,原子写入文件,并重载池。 |
| `GET /report` | 纯文本路由报告(池、指派、冷却路由、最近切换),与设置页诊断区一致。 |

`/catalog` 刻意与 `/state` 分开:state 每几秒轮询一次,而取清单意味着询问每个适配器——第三方 I/O 不该挂在定时器上。宿主缓存它一分钟,为每个 provider 的探测设了超时上限,并把失败或卡住的 provider 当作它自己的一行说明,而不是当作空答案。

这个前缀比内核自己的 `/api` 更长,而 webServer 派发是**最长前缀优先**——所以这些路由在应用自身的准入检查**之前**执行,需要自己的围栏。因此每个请求都由组合挂载的 `connection` 服务准入(若有),否则由该检查的一个结构化副本准入:仅回环地址主机、拒绝跨站 fetch、且 `Origin`/`Referer` 与 `Host` 权威匹配。其中一条路由会写配置,所以这道围栏不是摆设。

草稿在落盘前会先校验,且若 router 自身的规范化仍拒绝某次保存,路由会被禁用而不是中断宿主——与手改出的坏文件得到的降级相同。

---

## 测试

```bash
node --test                      # 或: node --test test/
```

| 文件 | 覆盖 |
| --- | --- |
| `test/router.test.js` | `src/selftest.js` 中的行为套件——选择、故障转移、健康、固定、结构化快照。 |
| `test/host.test.js` | `index.js` 对着一个替代宿主:两个瀑布、设置 API 挂载,以及 `ui: false` 路径。 |
| `test/config-io.test.js` | 配置层:投影、校验、注释保留、往返。 |
| `test/catalog.test.js` | provider/model 清单:缓存、适配器强制整形、卡住的 provider、失败的 provider、运行时路由观察器,以及来源层级。 |
| `test/api.test.js` | HTTP 接口:state、catalog、保存、拒绝,以及信任围栏。 |
| `test/effort.test.js` | 思考强度协调:模型接受的保留、不接受的丢弃、缓存、超时,以及绝不能被误读为「支持」的几种形态。 |
| `test/client.test.js` | 浏览器 bundle:注册、字典、整棵组件树的渲染冒烟测试,以及主题 token 不变量。 |

`test/client.test.js` 值得一提:它对着一个 stub 的 `window.__ModuleLoader__` 执行 `client.js`,并用一个小型 hook shim 渲染页面,因此一个坏掉的 bundle 会在这里失败,而不是变成浏览器里一个空白的设置页。

同一套行为测试也能在宿主内、无需测试运行器地执行:

```bash
dsh install F:\AI\dsh-model-auto-router
# 入口配置: { selfTest: true, selfTestOut: './selftest-report.json' }
# 或: DSH_MODEL_AUTO_ROUTER_SELFTEST=1
```

`test/browser-harness.html` 在浏览器里跑同一套断言,适用于没有 Node 的环境。

---

## 设计说明

- **无构建步骤。** 插件以纯 ESM JavaScript 和手写的 ModuleLoader bundle 发布,因此实际运行的文件就是被审查的文件。
- **配置只有一个写入者。** 页面通过插件自己的路由编辑文件,router 从该文件重载——它从不直接改动 router 内部。文件与实时路由不可能悄然分叉。
- **纯净核心。** `src/pool.js`、`src/health.js`、`src/config-io.js` 与 `src/router.js` 没有宿主导入、没有时钟、没有 I/O,这正是行为确定且可直接测试的原因。`src/config-io.js` 把文件访问作为注入的回调,因此整条配置路径都可在内存中测试。
- **安静地失败。** 一个坏配置、未知的池名或缺失的文件只会被记录一次,并让 DSH 自己的路由保持原位——它从不中断一次启动。
- **从不认领兑现不了的重试。** 若无处可去,真实错误会到达用户。
- **宿主的样式词汇表,而非自创的观感。** 面板使用 settings-card token,唯一的主操作使用 button-primary token,圆角来自 radius 刻度,且每种颜色都是宿主真正定义的 token——对着随附的 CSS 验证过,而不是对着 Theme provider 的 `listTokens`(它只列出一个子集)。若某个被用到的 token 在宿主中没有定义,测试会失败;测试还会点名已安装插件引用而宿主从未定义的两个 token(`label-on-accent`、`state-warning-primary`),本页面刻意避免使用它们。

## 许可

MIT
