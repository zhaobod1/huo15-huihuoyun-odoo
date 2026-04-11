# 火一五·辉火云Odoo助手

---

<div align="center">

<img src="https://tools.huo15.com/uploads/images/system/logo-colours.png" alt="火一五Logo" style="width: 120px; height: auto; display: inline; margin: 0;" />

</div>

<div align="center">

<h3>打破信息孤岛，用一套系统驱动企业增长</h3>
<h3>加速企业用户向全场景人工智能机器人转变</h3>

</div>
<div align="center">

| 🏫 教学机构 | 👨‍🏫 讲师 | 📧 联系方式         | 💬 QQ群      | 📺 配套视频                         |
|:-----------:|:--------:|:------------------:|:-----------:|:-----------------------------------:|
| 逸寻智库 | Job | support@huo15.com | 1093992108  | [📺 B站视频](https://space.bilibili.com/400418085) |

</div>
---

## 简介

**火一五·辉火云Odoo助手** 是 [OpenClaw](https://github.com/nicepkg/openclaw) 的 Odoo 19 Enterprise 插件，让你用自然语言全面操作辉火云企业套件。尤其适合**实施经理、项目经理、销售经理**的日常工作场景。

连接后，龙虾 AI Agent 即可帮你管理待办、跟进商机、查看工单、核对账款、记录工时——一句话搞定。

### 核心特性

- **实施经理每日概况** — 一句"今天有什么工作？"汇总任务、活动、工单、逾期账款、商机、未读消息
- **待办 & 任务** — 创建、列表、更新状态/优先级/截止日期
- **CRM 商机管道** — 查看/创建/推进/赢单/输单
- **项目 & 里程碑** — 项目进度总览、里程碑完成率、工时记录
- **客服工单** — 查看/创建 Helpdesk 工单
- **销售 & 采购** — 查看销售订单、采购订单
- **财务发票** — 发票查询、逾期应收账款筛选
- **活动提醒** — 创建活动、查看今日到期/逾期活动
- **日历会议** — 创建日历事件
- **消息 & 邮件** — 未读消息查看、Chatter 消息发送
- **通用搜索** — 搜索任意 Odoo 模型（客户、产品、员工、库存...）
- **后台通知同步** — 自动轮询推送新任务/活动/消息/邮件/日历变更

---

## 一键安装

```bash
openclaw plugins install @huo15/huo15-huihuoyun-odoo
```

或从 ClawHub 安装：

```bash
clawhub install huo15-huihuoyun-odoo
```

重启 OpenClaw 生效：

```bash
openclaw restart
```

---

## 首次配置

### 方式一：通过对话连接（推荐）

> 帮我连接 Odoo，地址 https://www.huo15.com，数据库 huo15，账号 admin@huo15.com，密码 xxxxxx

龙虾会自动调用 `odoo_connect` 工具，连接信息保存本地，下次启动自动恢复。

### 方式二：通过 openclaw.plugin.json 预配置

```json
{
  "odoo": {
    "url": "https://www.huo15.com",
    "db": "huo15",
    "username": "admin@huo15.com",
    "password": "your-password"
  },
  "sync": {
    "enabled": true,
    "intervalSeconds": 30,
    "channels": ["todo", "activity", "message", "email", "calendar"]
  }
}
```

---

## 工具列表（25 个）

### 基础
| 工具 | 说明 |
|------|------|
| `odoo_connect` | 连接 Odoo 系统 |
| `odoo_status` | 检查连接状态和轮询状态 |

### 任务 & 活动
| 工具 | 说明 |
|------|------|
| `odoo_create_task` | 创建待办任务 |
| `odoo_list_tasks` | 查看待办列表（支持 today_only/state 筛选） |
| `odoo_update_task` | 更新任务（状态/阶段/截止日期/优先级） |
| `odoo_create_activity` | 创建活动提醒（关联到记录） |
| `odoo_list_activities` | 查看今日及逾期活动 |
| `odoo_activity_types` | 查询活动类型列表 |
| `odoo_create_event` | 创建日历事件/会议 |

### 消息
| 工具 | 说明 |
|------|------|
| `odoo_get_messages` | 查看未读消息/邮件通知 |
| `odoo_send_message` | 向记录发送 Chatter 消息 |

### CRM
| 工具 | 说明 |
|------|------|
| `odoo_crm_pipeline` | 查看商机管道 |
| `odoo_crm_create` | 创建商机/线索 |
| `odoo_crm_update` | 更新商机信息 |
| `odoo_crm_won` | 标记赢单 |
| `odoo_crm_lost` | 标记输单 |

### 项目 & 工时
| 工具 | 说明 |
|------|------|
| `odoo_project_overview` | 项目列表 + 里程碑进度 |
| `odoo_timesheet_log` | 记录工时 |

### 销售 & 采购 & 财务
| 工具 | 说明 |
|------|------|
| `odoo_sale_orders` | 查看销售订单 |
| `odoo_purchase_orders` | 查看采购订单 |
| `odoo_invoices` | 查看发票/账单（支持逾期筛选） |

### 客服
| 工具 | 说明 |
|------|------|
| `odoo_tickets` | 查看客服工单 |
| `odoo_ticket_create` | 创建客服工单 |

### 搜索 & 助手
| 工具 | 说明 |
|------|------|
| `odoo_search` | 通用搜索（任意模型任意条件） |
| `odoo_daily_briefing` | 实施经理每日工作概况 |

---

## 使用示例

```
👤 今天有什么工作？
🦞 汇总：3个待办任务、2个到期活动、1个紧急工单、华为商机需跟进...

👤 帮我创建任务：明天发报价单给华为
🦞 已创建任务 #456，截止日期 2026-04-12

👤 查看我的商机
🦞 你有 5 个活跃商机：华为ERP项目（报价阶段，50万）...

👤 商机 #88 赢了
🦞 已标记商机 #88 为赢单！

👤 有哪些客户还没付款
🦞 3张未付发票：华为 ¥12,000（逾期15天）...
```

---

## 通知同步

插件启动后自动轮询（默认 30 秒），推送以下变更：

| 通道 | 触发条件 |
|------|---------|
| todo | 我的任务有新增或更新 |
| activity | 今日到期活动 |
| message | 新 Chatter 消息 |
| email（可选）| 新邮件通知 |
| calendar（可选）| 今明两天内的新日历事件 |

---

## 技术架构

- **Odoo JSON-RPC** — 通过 `/web/session/authenticate` 和 `/web/dataset/call_kw` 与 Odoo 19 通信
- **Session 自动重连** — `ensureAuthenticated()` 在轮询前自动检查并恢复 session
- **高水位线去重** — 消息/邮件用 `id > highWaterMark` 去重，避免时钟偏差问题
- **基线初始化** — 首次启动静默建立水位线，不推送历史数据
- **OpenClaw 插件规范** — `definePluginEntry` + `api.registerTool()` + `api.on("before_prompt_build")`

---

## 常见问题

**Q: 连接失败怎么办？**
A: 检查 URL（末尾不带斜杠）、数据库名（区分大小写）、账号密码。用 `odoo_status` 查看当前状态。

**Q: 每日概况失败提示没有 helpdesk 模块？**
A: 系统中未安装 Helpdesk 模块时，工单部分会自动跳过，其他项正常返回。

**Q: 商机阶段 ID 怎么获取？**
A: 通过 `odoo_search(model="crm.stage")` 查询所有 CRM 阶段及其 ID。

---

## Changelog

- **v1.1.0** — CRM 商机管道、项目里程碑、工时记录、销售/采购订单、Helpdesk 工单、发票/逾期账款查询、任务状态更新、活动类型查询、实施经理每日概况
- **v1.0.0** — 基础版：待办/任务、活动提醒、日历事件、消息/邮件、通用搜索、后台轮询

---

## License

MIT

---

<div align="center">

**公司名称：** 青岛火一五信息科技有限公司

**联系邮箱：** postmaster@huo15.com | **QQ群：** 1093992108

---

**关注逸寻智库公众号，获取更多资讯**

<img src="https://tools.huo15.com/uploads/images/system/qrcode_yxzk.jpg" alt="逸寻智库公众号二维码" style="width: 200px; height: auto; margin: 10px 0;" />

</div>

---
