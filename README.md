# API Scenario Studio

把多个 HTTP 请求串成场景的本地工作台：前一步从响应头或 JSON 路径提取变量，后一步在 URL、请求头、请求体中引用。

运行 `npm install`，然后 `npm run dev`（后端 4174，前端 4173，`/api` 自动代理）。

- `npm test`：42 个测试（纯逻辑 + HTTP 集成）
- `npm run build`：tsc 类型检查 + 生产构建

## 场景文档

场景以结构化 JSON 保存在原有 `content` 字段中（旧的纯文本内容仍可加载、保存、分析，互不影响）：

```json
{
  "kind": "api-scenario",
  "version": 1,
  "initialVariables": {"baseUrl": "/mock"},
  "steps": [
    {
      "id": "step-1", "name": "登录", "enabled": true,
      "method": "POST", "url": "{{baseUrl}}/login",
      "headers": [{"name": "content-type", "value": "application/json"}],
      "body": "{\"user\":\"alice\"}",
      "condition": null,
      "onExtractFailure": "terminate",
      "extract": [
        {"name": "token", "source": "json", "path": "$.token"},
        {"name": "traceId", "source": "header", "path": "x-trace-id"}
      ]
    }
  ]
}
```

## 语义约定

- 引用语法：`{{ name }}`（URL / 请求头 / 请求体任意位置）。
- JSON 路径：`$`、`.foo.bar`、`["带空格的键"]`、`[0]`、`[*]`（扇出为数组值；对非数组使用 `[*]` 视为提取失败）。
- 值不假定是字符串：提取到的数字/布尔/数组/对象保留原生类型。请求体中独占一个 JSON 值位置的 `{{var}}` 以原生类型写入；嵌在 JSON 字符串里以及 URL/头中的引用按统一规则转字符串（对象/数组 → JSON 文本，`null`/未定义 → 空串）。
- 同名变量覆盖规则：跨步骤由编号靠后的步骤覆盖；同一步骤内多个提取器按声明顺序 last-wins。运行视图会标出每次覆盖及旧值。
- 提取失败：`terminate` 终止整个场景；`skip` 记录本步失败但继续。任一提取器失败时，该步所有提取结果整体丢弃，不留半更新变量。
- 条件跳过：变量支持 `empty / notEmpty / equals / notEquals`；条件变量未定义时按「空」处理（不报未定义引用）。
- 编辑期诊断：URL/头/体引用了当前步骤之前未定义的变量（含重排后生产者移到消费者之后）、非法变量名、非法 JSON 路径报错误；同步骤重复提取报警告；跨步骤覆盖报信息。

## 执行与取消

- 运行开始时固定场景 revision 并深拷贝快照，执行期间场景被保存修改不影响本次运行；用过期 revision 启动返回 409。
- 每步记录：实际请求（URL/头/体）、每个引用在**该步运行时**实际使用的值（raw 值与强制转换后的字符串，不是最新值）、响应（状态/头/体预览）、变量前后快照、提取覆盖明细。
- 运行记录保存在服务端，刷新页面后通过 `/api/runs/:id` 仍可查看全部已完成步骤。
- 取消：`POST /api/runs/:runId/cancel` 只设置取消标志并 abort 在途请求（幂等），终态只由 runner 写入。取消与最后一步完成竞争时，同步临界区保证只有一个终态（completed 或 cancelled），重复读取结果稳定。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/scenarios` / `/api/scenarios/:id` | 列表 / 详情（原有） |
| PUT | `/api/scenarios/:id` | 乐观锁保存（原有，revision 冲突 409） |
| POST | `/api/scenarios/:id/analyze` | 返回诊断（原有契约，新增场景诊断） |
| POST | `/api/scenarios/:id/runs` | 以当前（或指定）revision 启动运行，422/409 见上 |
| GET | `/api/scenarios/:id/runs` | 该场景的运行列表 |
| GET | `/api/runs/:runId` | 查询运行（轮询、刷新恢复） |
| POST | `/api/runs/:runId/cancel` | 请求取消 |

内置 mock：`POST /mock/login`、`GET /mock/orders`、`GET /mock/orders/:id`，种子场景可直接运行。
