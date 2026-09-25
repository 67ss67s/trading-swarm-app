# TS 侧发现的 schema 问题与生成器怪癖

A0 工作包(TS 半边)实施期间发现,按 AGENTS.md/任务边界要求记录于此,不在 `packages/contracts/schema` 里
自己改。`packages/contracts/scripts/generate.ts` 与 `packages/contracts/src/validators.ts` 里对应位置
都有更详细的行内注释。

## 1. `common.json` `$defs.ClientOrderId.pattern` 有一处多余转义(需要主线修)

```json
"pattern": "^[\\.A-Z\\:/a-z0-9_-]{1,36}$"
```

`\:` 在 ECMAScript **Unicode 模式**正则(`u` flag)下是非法转义(冒号不是需要转义的字符,不在
`\.` 那种"转义元字符"的合法集合里)。ajv 的 `Ajv2020`/`Ajv2019` dialect 默认用 `u` flag 编译
`pattern` 关键字,所以 `ajv.compile()` 对**任何**传递引用到 `ClientOrderId` 的 schema(`attempt`、
`exchange_order`、`fill`、`account_snapshot`、`plan` 的 `CancelEconomics`……基本是大多数)都会直接
抛 `SyntaxError: Invalid regular expression: ... Invalid escape`,而不是"这条数据不合法"那种正常的
校验失败。

**建议修法**:把 `\:` 里的反斜杠去掉——`:` 在字符类 `[...]` 里从来不需要转义,任何正则方言都一样:

```json
"pattern": "^[\\.A-Z:/a-z0-9_-]{1,36}$"
```

**当前 TS 侧的临时规避**:`src/validators.ts` 给 ajv 传了 `unicodeRegExp: false`(连同下面第 2 条
一起,两处都有详细行内注释)。这 8 处 `pattern` 全是纯 ASCII 字符类,没有任何 astral-plane / Unicode
属性匹配的诉求,所以关掉 `u` flag 对其余 7 处的实际匹配语义没有任何影响,只是让这一处"意图上的字面量
冒号"能编译通过——本质是绕过而不是修复,schema 修好之后这个 override 可以去掉(留着也无害,因为那时
主路径本来就会成功,fallback 永远不触发)。

## 2. `strictRequired` 在 `authorization.json` 的 `if/then` 与 `plan.json` 的 `anyOf` 上误报

- `authorization.json`:顶层 `if: {by: "user"}` / `then: {required: ["confirm_echo","principal","surface"]}`。
- `plan.json` 的 `CancelEconomics`:`anyOf: [{required:["exchange_order_id"]}, {required:["client_order_id"]}]`。

两处都是完全合法、符合 2020-12 语义的写法(`required` 引用的字段声明在**父级** `properties` 里,
不需要在 `if`/`then`/`anyOf` 分支自己的 `properties` 里重复声明)。但 ajv 的 `strictRequired`
(`strict: true` 时默认打开)会把"这个 `required` 提到的字段没有出现在**这一层节点自己的**
`properties` 里"当成疑似笔误,直接在 `ajv.compile()` 阶段抛错——这是 ajv 自己文档过的针对这种模式的
已知误报,不是这两份 schema 的缺陷。

**当前 TS 侧处理**:`src/validators.ts` 显式设 `strictRequired: false`(其余 strict 检查照常开着)。
不建议为了消掉这个误报去改 schema 结构(比如把 `authorization.json` 拆成按 `by` 判别的
`oneOf`)——那是一次不小的契约形状变动,而且 `strictRequired: false` 已经完整、精确地解决了这个问题,
没有削弱任何其他校验。

**连带的 TS 类型后果**(仅供了解,不是 bug):因为 json-schema-to-typescript 不处理 `if/then`,
生成的 `Authorization` 类型里 `confirm_echo`/`principal`/`surface` 都是 `?:`(可选),即使
`by === "user"` 时运行时其实必填。ajv 校验器(`validate('authorization', ...)`)会正确按
`if/then` 强制这条规则,只是静态类型没法表达"这三个字段的必填性取决于 `by`"——如果哪天想要类型也
体现出来,得把 `IntentParams` 那种判别联合模式搬过来(按 `by` 拆成两个变体、`oneOf` 之),但那同样是
契约形状变动,建议单独评估,不在这次一起做。

## 3. `plan.json` `CancelEconomics` 的 `anyOf` 让生成的 TS 类型带了一个可穿透的索引签名

`CancelEconomics` 的 `anyOf`(每个分支只有 `required`,没有自己的 `properties`/`type`)让
json-schema-to-typescript 把它拆成两个类型相交:

```ts
export type CancelEconomics = CancelEconomics1 & CancelEconomics2;
export type CancelEconomics1 = {
  [k: string]: unknown;
};
export interface CancelEconomics2 {
  kind: "cancel";
  product: Product;
  symbol: Symbol;
  exchange_order_id?: string;
  client_order_id?: ClientOrderId;
}
```

`{[k:string]: unknown}` 那部分让整个交叉类型在 TS 层面允许任意额外字段(削弱了
`additionalProperties:false` 本该有的"多字段编译期报错"效果),外加两个不太好看的
`CancelEconomics1`/`CancelEconomics2` 辅助名字混进导出列表。**运行时不受影响**——`validate()`
用的是原始 schema JSON,`additionalProperties:false` 与 `anyOf`(至少一个字段)照常严格执行,这
纯粹是静态类型精度问题,与第 2 条同根(`anyOf` 分支只有裸 `required`)。没有在 `generate.ts` 里
针对性再加一层 AST 手术去修——投入产出比不划算,而且下一次 schema 改动形状变了就可能又要重写一遍。
如果主线想要更干净的类型,可选项是把"至少一个 of exchange_order_id/client_order_id"的约束换一种
表达方式(例如 `oneOf` 两个各自完整声明 `properties` 的分支),但这也是形状变动,不建议顺手做。

## 4. `common.json` `$defs.Symbol` 生成的 TS 类型名与全局 `Symbol` 撞名(纯观感,不是 bug)

`export type Symbol = string;` 会遮蔽 TS 内置的全局 `Symbol`(ES2015 `symbol` 原始类型的接口/构造器
命名空间)。当前代码库里没有任何地方需要在同一作用域同时用到"契约里的 Symbol(交易对符号如
BTCUSDT)"和"JS 内置 Symbol",所以目前完全无害;只是如果以后哪个文件 `import { Symbol } from
'@trading-swarm/contracts'` 又想用 `Symbol.iterator` 之类的内置能力,会被这个重名类型挡住。是否值得为
这个而重命名 `$defs.Symbol`(比如叫 `SymbolCode`)是个纯粹的命名品味决定,不构成阻塞项,列在这里
仅供参考。
