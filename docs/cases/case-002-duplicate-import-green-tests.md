# case-002 重复 import：43 个测试全绿，桥接一行都跑不起来

- **日期**：2026-10-28
- **影响**：桥接进程启动即退出（`SyntaxError`）；测试、审计、单测全绿，差点以为"已经上线"。
- **关联**：[PITFALLS P-001 / P-002](../../PITFALLS.md)

## 现场

```
SyntaxError: Identifier 'analyzeClosure' has already been declared
```

而 `npm run test:audit` 报 50/53 通过（3 个已知环境失败），
`node scripts/test-conversation-closure.mjs` 10/10。

## 为什么会绿

`scripts/audit-bridge-harness.mjs` 在跑真实 `bridge.js` 之前，会把它的**顶层 import 全部剥掉**，
改由 `vm.createContext({...})` 显式注入每个绑定。于是：

- 重复 import → 那两行都在测试开始前被删掉了，语法错不存在；
- 少注入一个绑定 → 只有执行到那段代码的用例才会炸，而很多用例根本走不到。

单测更不用说：它们只 import 纯函数模块，从不加载 `bridge.js`。

## 根因

同一行 import 被两次编辑各加了一次（一次"加模块"，一次"补测试导入"），中间没人真的启动过进程。

## 修复

- 删重复行；
- 先 `node -c` 等价手段（这里是直接起进程）+ `netstat` 确认听端口；
- `npm run guard:check` 增加"顶层 import 重复标识符"检查；
- AGENTS.md 硬约束：改完 `bridge.js` 必须真的重启一次。

## 教训

**审计夹具为了隔离而改写源码，代价是它对"源码本身能不能加载"是盲的。**
凡是"测试跑的是被改造过的代码"，就必须另有一条"原样加载"的验证。

## 遗留

- `guard:check` 只做静态检查；真正的保证仍然是"起一次进程"。
