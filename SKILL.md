---
name: huo15-openclaw-odoo
displayName: 火一五·辉火云企业套件插件
description: 自然语言操作 Odoo 19 Enterprise（待办、日历、活动提醒、消息、CRM、搜索）
version: 1.0.0
---

# 辉火云企业套件插件使用指南

OpenClaw 龙虾的 Odoo 19 Enterprise 插件。连接后即可用自然语言操作辉火云系统：
创建待办、安排会议、设置活动提醒、查看消息/邮件，以及搜索客户、商机、订单等。

---

## 首次配置

### 方式一：通过对话连接（推荐）

直接说：

> 帮我连接 Odoo，地址 https://www.huo15.com，数据库 huo15，账号 admin@huo15.com，密码 123456

龙虾会自动调用 **odoo_connect** 工具完成连接，并将配置保存到本地，下次启动无需重新输入。

### 方式二：通过 openclaw.plugin.json 预配置

在插件配置中填写：

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
    "channels": ["todo", "activity", "message"]
  }
}
```

---

## 待办 / 任务

| 你说 | 龙虾做什么 |
|------|-----------|
| 帮我写个待办 | 追问标题后创建任务（project.task） |
| 帮我创建待办：明天发报价单给华为 | 直接创建，截止日期设为明天 |
| 紧急待办：处理生产故障 | 创建优先级=紧急（1）的任务 |
| 看看我的待办 | 列出我的全部待办 |
| 我今天有什么要做的 | 列出今日截止任务 + 今日活动 |
| 把「发报价单」待办标记完成 | 更新任务状态为已完成 |
| 删除「测试待办」 | 删除该任务 |

---

## 活动提醒

活动（mail.activity）关联到具体的 Odoo 记录（客户、订单、任务等）。

| 你说 | 龙虾做什么 |
|------|-----------|
| 提醒我明天开会 | 创建活动提醒，截止明天 |
| 帮我设一个后天下午2点的提醒 | 创建指定日期的活动 |
| 查看我今天有哪些活动 | 列出今日到期活动 |
| 查看我的到期提醒 | 列出今日及逾期活动 |

> **提示：** 活动必须关联到某条记录。如果不确定，可以先用 odoo_search 查到记录ID，
> 或者改用日历事件（无需关联记录）。

---

## 日历 / 会议

日历事件（calendar.event）不需要关联具体记录，适合安排独立会议。

| 你说 | 龙虾做什么 |
|------|-----------|
| 安排一个会议 | 追问主题和时间后创建日历事件 |
| 明天上午10点安排产品评审会，1小时 | 直接创建（10:00~11:00） |
| 后天下午2点和华为团队开个会 | 创建（14:00~15:00） |
| 查看我的日程安排 | 搜索近期日历事件 |

---

## 消息 / 邮件

| 你说 | 龙虾做什么 |
|------|-----------|
| 查看我的消息 | 列出未读 chatter 消息 |
| 看看我的邮件通知 | 列出未读收件箱通知 |
| 帮我给「项目A」的任务发一条消息：进度已更新 | 在对应任务上发 chatter 消息 |

---

## 搜索 / 查询

| 你说 | 龙虾做什么（模型） |
|------|-----------------|
| 帮我查「华为」客户 | res.partner |
| 查看我的商机 | crm.lead（type=opportunity） |
| 查销售订单 | sale.order |
| 查采购订单 | purchase.order |
| 查库存情况 | stock.quant |
| 查看我的项目 | project.project |
| 查工时记录 | account.analytic.line |

---

## 通知同步

启用后，龙虾每 30 秒（可配置）自动检查：

| 通道 | 内容 |
|------|------|
| todo | 新待办和任务更新 |
| activity | 今日到期活动提醒 |
| message | 新 chatter 消息 |
| email（可选） | 新邮件通知 |
| calendar（可选） | 今明两天内的新日历事件 |

配置示例（启用所有通道）：

```json
{
  "sync": {
    "enabled": true,
    "intervalSeconds": 30,
    "channels": ["todo", "activity", "message", "email", "calendar"]
  }
}
```

---

## 工具列表

| 工具名 | 说明 |
|--------|------|
| odoo_connect | 连接 Odoo 系统（首次使用） |
| odoo_create_task | 创建待办任务 |
| odoo_list_tasks | 查看待办列表 |
| odoo_create_activity | 创建活动提醒（关联记录） |
| odoo_list_activities | 查看今日及逾期活动 |
| odoo_create_event | 创建日历事件/会议 |
| odoo_get_messages | 查看消息和邮件通知 |
| odoo_send_message | 发送 chatter 消息 |
| odoo_search | 通用搜索（支持任意模型） |
| odoo_status | 检查连接状态 |

---

## 常见问题

**Q: 连接失败怎么办？**
A: 检查 URL（不带末尾斜杠）、数据库名（区分大小写）、账号密码是否正确。也可使用 odoo_status 查看当前状态。

**Q: 活动提醒需要哪些参数？**
A: 必须提供 `res_model`（模型名）和 `res_id`（记录ID）。
常用 `activity_type_id`：4=待办、1=邮件、2=电话。
可通过 `odoo_search(model="mail.activity.type")` 查看全部类型。

**Q: 通知同步用的是什么机制？**
A: 使用 id 高水位线（非时间戳），避免因服务器时区差异导致消息遗漏或重复推送。

---

## Changelog

- **v1.0.0** — 生产版发布：10 个工具，before_prompt_build 上下文注入，id 高水位线消息去重，ensureAuthenticated 自动重连
