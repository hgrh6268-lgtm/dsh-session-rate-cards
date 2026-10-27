# 会话费用（Session Cost）

在 Web GUI 的输入框下方新增一个实时费用读数：它按 **每条 assistant 消息实际回报的 token 用量**，用该条消息所用模型的单价和当时的峰谷时段计价，显示当前会话累计的人民币费用。鼠标悬停可看到输入、缓存命中、缓存写入、输出、最近模型和峰谷时段的明细。

同时在 **Settings → 会话费用** 提供一个模型定价面板：内置模型和自定义模型都会列出，可以改价、恢复默认、新增模型。

## 安装

```sh
dsh plugin --profile web add dsh-session-cost
```

装完刷新页面即可生效（client 端立即注入，不需要重启 `dsh web`）。要求 DSH `>=0.2.1-rc.3`（见 `package.json` 的 `engines.dsh`）。

## 计价方式

- 单价来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>，单位是 **元 / 百万 tokens**。
- 高峰期：北京时间周一至周五 09:00–12:00、14:00–18:00（即 UTC 01:00–04:00、06:00–10:00）；其余时间（含周末）为低谷期。中国法定节假日没有单独建模，节假日当天仍按周一至周五的时段判断。
- 输入（未命中缓存）、缓存命中、输出分别计价；缓存写入按未命中输入的单价计费（DeepSeek 未单独公布缓存写入价）。
- 每条 `assistant/message` 按它自己的 `source.model` 计价；同一条 step 的重试/重复结算会替换而不是重复累加；失败但仍回报了 usage 的 `assistant/attempt` 也会计入。
- 只统计模型 token，不包含 Search / Fetch 按次费用。

## 已内置的模型价格

| 模型 | 输入（缓存未命中） | 输入（缓存命中） | 输出 |
|---|---:|---:|---:|
| `deepseek-flash`（含 v4-flash / v4.1-flash 等别名） | 高峰 2 元 / 低谷 1 元 | 高峰 0.04 元 / 低谷 0.02 元 | 高峰 8 元 / 低谷 4 元 |
| `deepseek-v4-pro` | 高峰 9 元 / 低谷 4.5 元 | 高峰 0.30 元 / 低谷 0.15 元 | 高峰 27 元 / 低谷 13.5 元 |

上表均为每百万 tokens。

## 在设置面板里改价

打开 **Settings → 会话费用**：

- 每一行是一个模型，六项价格按“高峰期 / 低谷期 × 输入未命中 / 缓存命中 / 输出”排列。
- 内置模型的“恢复默认”会在你改过它之后出现；点击后删除该模型的自定义价格，回到代码里的内置价。
- 底部“新增模型”：填写模型 ID 和六项价格后点“添加”。新模型会立即出现在同一个列表里，后续该模型的请求按这张价格卡计价。
- 保存后价格表会重新注册 projection，`stateVersion` 随价格指纹变化，旧缓存失效；当前会话在下一次读取或下一条回复时按新价重算。

自定义价格保存在插件自己的数据文件里：

```text
$DSH_HOME/storages/session-cost/pricing.json
```

内置价来自 `pricing.js`；这个文件只存覆盖项，所以升级插件不会丢掉你改过的价格，也不会把内置价复制成一份死数据。删除这个文件即可回到全部内置价。

## 新模型怎么计费

计价表按 **模型 id** 查找，不是按会话或全局平均价。遇到价格表里没有的模型时：

1. 该模型的 token 会按 Flash 价格估算，读数前出现 `~`；
2. 悬停提示里会列出「未定价模型」的具体 id；
3. 设置页会把这些 id 收进「已出现但未定价」，点一下就把 id 填进新增表单，填价格后添加；
4. 添加后整个会话会按新价重算，`~` 随之消失。

没有做「自动抓官网价格」：DeepSeek 目前没有机器可读的价格 API，抓 HTML 很容易在页面改版时静默算错。现在的策略是「明确的模型价格表 + 未定价模型显式标记」，宁可显示 `~`，也不假装精确。

## 实现位置

- `index.js`：Host 端的 `sessionCost` projection，纯函数折叠 `assistant/message` / `assistant/attempt` / `llm/retry-started`；同时提供 `/plugins/session-cost/pricing` 读写接口。
- `pricing.js`：内置价格表、峰谷判断、模型匹配和价格指纹。
- `client.js`：输入框下方的费用读数（`conversation.composer.dock`，id `session-cost`，order 2）和 Settings → 会话费用 面板（`settings.section`，order 60）。

## English

A live CNY cost readout under the composer of the DSH Web GUI. Every assistant message is priced with the rate card of the model that produced it and the peak/off-peak window of its timestamp, then summed for the session; hovering shows input, cache-hit, cache-write, output, last model and the current window.

**Settings → Session Cost** is a rate-card panel: built-in and custom models are listed side by side, prices can be edited, reset to the built-in values, or added for a new model id. Rate cards live in `$DSH_HOME/storages/session-cost/pricing.json`, so upgrading the plugin never overwrites your prices. A model without a card is priced at Flash rates and marked with `~` instead of pretending to be exact.

```sh
dsh plugin --profile web add dsh-session-cost
```

Requires DSH `>=0.2.1-rc.3`.
