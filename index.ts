/**
 * 火一五·辉火云企业套件插件（Odoo 19 Enterprise）
 *
 * 功能：
 * 1. 自然语言操作 Odoo（创建待办、提醒、活动、日历事件、搜索等）
 * 2. Odoo 通知同步到 OpenClaw（待办/活动/消息/邮件/日历）
 * 3. before_prompt_build 钩子注入系统上下文，LLM 自动理解 Odoo 意图
 *
 * 支持工具：
 * - odoo_connect          连接 Odoo 系统
 * - odoo_create_task       创建待办任务
 * - odoo_list_tasks        查看待办列表
 * - odoo_create_activity   创建活动提醒
 * - odoo_list_activities   查看活动列表
 * - odoo_create_event      创建日历事件/会议
 * - odoo_get_messages      查看消息/邮件
 * - odoo_send_message      发送 chatter 消息
 * - odoo_search            通用搜索
 * - odoo_status            连接状态诊断
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { OdooClient } from './src/modules/odoo-client.js';
import { NotificationPoller } from './src/modules/notification-poller.js';
import { ConfigManager } from './src/modules/config-manager.js';
import type { OdooPluginConfig, SyncUpdate } from './src/types/index.js';
import { today, tomorrow } from './src/utils/date-utils.js';

// ── 每个 Agent 独立的运行时状态 ──────────────────────────────────────────────
const odooClients = new Map<string, OdooClient>();
const pollers = new Map<string, NotificationPoller>();
const configManager = new ConfigManager();

// ── 插件入口 ─────────────────────────────────────────────────────────────────
export default definePluginEntry({
  id: 'odoo',
  name: '火一五·辉火云企业套件插件',
  description: '自然语言操作辉火云企业套件（Odoo 19）、通知同步、待办管理、活动提醒',

  register(api: OpenClawPluginApi) {
    const config = (api.pluginConfig ?? {}) as OdooPluginConfig;

    // 优先使用 configSchema 中填写的配置
    if (config.odoo) {
      initOdooClient(api, config.odoo).catch(err => {
        api.logger.error(`[odoo] 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
      });
    } else {
      // 尝试加载本地持久化配置（用户之前通过 odoo_connect 连接过）
      const saved = configManager.load();
      if (saved?.odoo) {
        api.logger.info('[odoo] 发现本地保存的 Odoo 配置，正在恢复连接...');
        initOdooClient(api, saved.odoo).catch(err => {
          api.logger.error(`[odoo] 恢复连接失败: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
    }

    registerTools(api);
    registerHooks(api);

    api.logger.info('[odoo] 插件已加载');
  },
});

// ── 初始化 Odoo 客户端 ────────────────────────────────────────────────────────
async function initOdooClient(
  api: OpenClawPluginApi,
  odooConfig: NonNullable<OdooPluginConfig['odoo']>,
  agentId: string = 'default',
): Promise<OdooClient> {
  const client = new OdooClient(odooConfig);
  await client.authenticate();
  odooClients.set(agentId, client);

  const pluginConfig = (api.pluginConfig ?? {}) as OdooPluginConfig;
  const syncConfig = pluginConfig.sync ?? {
    enabled: true,
    intervalSeconds: 30,
    channels: ['todo', 'activity', 'message'],
  };

  if (syncConfig.enabled !== false) {
    // 停掉旧的 poller（如果有）
    pollers.get(agentId)?.stop();

    const poller = new NotificationPoller(client);
    pollers.set(agentId, poller);

    poller.start(
      (updates: SyncUpdate[]) => handleOdooUpdates(api, updates, agentId),
      {
        intervalSeconds: syncConfig.intervalSeconds,
        channels: syncConfig.channels,
      },
    );
  }

  api.logger.info(`[odoo] 已连接 ${odooConfig.url}，uid=${client.getUid()}`);
  return client;
}

// ── 注册工具 ──────────────────────────────────────────────────────────────────
function registerTools(api: OpenClawPluginApi) {
  // ── 1. odoo_connect ────────────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_connect',
    description: '连接辉火云企业套件（Odoo 19）系统。首次使用时填写连接信息。',
    schema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Odoo 系统地址，如 https://www.huo15.com' },
        db:       { type: 'string', description: '数据库名称，如 huo15' },
        username: { type: 'string', description: '用户名（邮箱或登录名）' },
        password: { type: 'string', description: '密码' },
      },
      required: ['url', 'db', 'username', 'password'],
    },
    async handler(
      params: { url: string; db: string; username: string; password: string },
      ctx: Record<string, unknown>,
    ) {
      const agentId = (ctx['agentId'] as string | undefined) ?? 'default';
      const odooConfig = {
        url: params.url,
        db: params.db,
        username: params.username,
        password: params.password,
      };
      try {
        await initOdooClient(api, odooConfig, agentId);
        configManager.saveOdooConfig(odooConfig);
        return { success: true, message: `已成功连接到 ${params.url}，欢迎使用辉火云企业套件！` };
      } catch (error) {
        return { success: false, message: `连接失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 2. odoo_create_task ────────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_create_task',
    description: '在辉火云企业套件中创建待办任务。用于"帮我写个待办"、"创建任务"等指令。',
    schema: {
      type: 'object',
      properties: {
        name:          { type: 'string',  description: '待办名称/标题（必填）' },
        description:   { type: 'string',  description: '待办详细描述' },
        date_deadline: { type: 'string',  description: '截止日期，格式 YYYY-MM-DD' },
        priority:      { type: 'string',  enum: ['0', '1'], description: '优先级，0=普通，1=紧急' },
        project_id:    { type: 'number',  description: '所属项目ID（可选）' },
      },
      required: ['name'],
    },
    async handler(params: {
      name: string;
      description?: string;
      date_deadline?: string;
      priority?: '0' | '1';
      project_id?: number;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const taskId = await client.createTask({
          name: params.name,
          description: params.description,
          date_deadline: params.date_deadline,
          priority: params.priority ?? '0',
          project_id: params.project_id,
        });
        return { success: true, taskId, message: `待办「${params.name}」已创建，ID: ${taskId}` };
      } catch (error) {
        return { success: false, message: `创建失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 3. odoo_list_tasks ─────────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_list_tasks',
    description: '获取当前用户的待办任务列表。today_only=true 时只返回今日截止的任务。',
    schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number',  description: '返回数量上限，默认 50' },
        project_id: { type: 'number',  description: '筛选特定项目的待办' },
        today_only: { type: 'boolean', description: '只返回今日截止的任务' },
      },
    },
    async handler(params: {
      limit?: number;
      project_id?: number;
      today_only?: boolean;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const tasks = await client.getMyTasks({
          limit: params.limit ?? 50,
          project_id: params.project_id,
          today_only: params.today_only,
        });
        return {
          success: true,
          count: tasks.length,
          tasks: tasks.map(t => ({
            id: t['id'],
            name: t['name'],
            date_deadline: t['date_deadline'],
            priority: t['priority'],
            stage: t['stage_id'],
          })),
        };
      } catch (error) {
        return { success: false, message: `查询失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 4. odoo_create_activity ────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_create_activity',
    description: '在辉火云企业套件中创建活动提醒（mail.activity）。用于"提醒我明天开会"等指令。',
    schema: {
      type: 'object',
      properties: {
        res_model:        { type: 'string', description: '关联文档模型，如 project.task、crm.lead、res.partner' },
        res_id:           { type: 'number', description: '关联文档 ID' },
        activity_type_id: { type: 'number', description: '活动类型 ID（4 = 待办；可通过 odoo_search 查询 mail.activity.type 获取）' },
        summary:          { type: 'string', description: '活动摘要/标题' },
        note:             { type: 'string', description: '活动详细说明' },
        date_deadline:    { type: 'string', description: '截止日期，格式 YYYY-MM-DD' },
        user_id:          { type: 'number', description: '负责人 ID（不填默认为当前用户）' },
      },
      required: ['res_model', 'res_id', 'activity_type_id', 'date_deadline'],
    },
    async handler(params: {
      res_model: string;
      res_id: number;
      activity_type_id: number;
      summary?: string;
      note?: string;
      date_deadline: string;
      user_id?: number;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const activityId = await client.createActivity({
          res_model: params.res_model,
          res_id: params.res_id,
          activity_type_id: params.activity_type_id,
          summary: params.summary,
          note: params.note,
          date_deadline: params.date_deadline,
          user_id: params.user_id,
        });
        return { success: true, activityId, message: `活动提醒「${params.summary ?? ''}」已创建，ID: ${activityId}` };
      } catch (error) {
        return { success: false, message: `创建失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 5. odoo_list_activities ────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_list_activities',
    description: '查看今日及逾期的活动提醒列表。用于"我今天有什么活动"、"查看到期提醒"等指令。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回数量上限，默认 30' },
      },
    },
    async handler(params: { limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const activities = await client.getTodayActivities({ limit: params.limit ?? 30 });
        return {
          success: true,
          count: activities.length,
          activities: activities.map(a => ({
            id: a['id'],
            summary: a['summary'],
            date_deadline: a['date_deadline'],
            activity_type: a['activity_type_id'],
            res_model: a['res_model'],
            state: a['state'],
          })),
        };
      } catch (error) {
        return { success: false, message: `查询失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 6. odoo_create_event ───────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_create_event',
    description: '在辉火云企业套件中创建日历事件/会议。用于"安排一个会议"、"明天上午10点开产品评审"等指令。',
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string',                         description: '事件名称（必填）' },
        start:       { type: 'string',                         description: '开始时间，格式 YYYY-MM-DD HH:MM:SS（必填）' },
        stop:        { type: 'string',                         description: '结束时间，格式 YYYY-MM-DD HH:MM:SS（必填）' },
        description: { type: 'string',                         description: '事件描述' },
        partner_ids: { type: 'array', items: { type: 'number' }, description: '参与人 partner ID 列表' },
      },
      required: ['name', 'start', 'stop'],
    },
    async handler(params: {
      name: string;
      start: string;
      stop: string;
      description?: string;
      partner_ids?: number[];
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const eventId = await client.createCalendarEvent({
          name: params.name,
          start: params.start,
          stop: params.stop,
          description: params.description,
          partner_ids: params.partner_ids,
        });
        return { success: true, eventId, message: `日历事件「${params.name}」已创建，ID: ${eventId}` };
      } catch (error) {
        return { success: false, message: `创建失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 7. odoo_get_messages ───────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_get_messages',
    description: '查看辉火云企业套件的消息和邮件通知。用于"查看我的消息"、"看看邮件"等指令。',
    schema: {
      type: 'object',
      properties: {
        type:        { type: 'string', enum: ['message', 'email'], description: 'message=chatter消息，email=邮件通知，不填则两种都查' },
        limit:       { type: 'number', description: '返回数量上限，默认 20' },
        unread_only: { type: 'boolean', description: '只返回未读消息，默认 true' },
      },
    },
    async handler(params: {
      type?: 'message' | 'email';
      limit?: number;
      unread_only?: boolean;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const limit = params.limit ?? 20;
      const unreadOnly = params.unread_only !== false;

      try {
        if (params.type === 'email') {
          const notifications = await client.getInboxNotifications({ limit });
          return { success: true, type: 'email', count: notifications.length, messages: notifications };
        }

        const messages = unreadOnly
          ? await client.getUnreadMessages({ limit })
          : (await client.searchRead('mail.message', [['message_type', '!=', 'notification']], ['id', 'subject', 'body', 'author_id', 'date', 'model', 'res_id'], { limit })).records;

        return {
          success: true,
          type: 'message',
          count: messages.length,
          messages: messages.map(m => ({
            id: m['id'],
            subject: m['subject'],
            body: String(m['body'] ?? '').replace(/<[^>]+>/g, '').substring(0, 200),
            author: m['author_id'],
            date: m['date'],
            model: m['model'],
          })),
        };
      } catch (error) {
        return { success: false, message: `查询失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 8. odoo_send_message ───────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_send_message',
    description: '在辉火云企业套件中发送 chatter 消息到指定记录。',
    schema: {
      type: 'object',
      properties: {
        model:   { type: 'string', description: '目标模型，如 project.task、crm.lead、sale.order' },
        res_id:  { type: 'number', description: '目标记录 ID' },
        body:    { type: 'string', description: '消息内容（支持 HTML）' },
        subject: { type: 'string', description: '消息主题（可选）' },
      },
      required: ['model', 'res_id', 'body'],
    },
    async handler(params: {
      model: string;
      res_id: number;
      body: string;
      subject?: string;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const messageId = await client.call('mail.message', 'create', [{
          model: params.model,
          res_id: params.res_id,
          body: params.body,
          subject: params.subject ?? '',
          message_type: 'comment',
          subtype_xmlid: 'mail.mt_comment',
        }]);
        return { success: true, messageId, message: `消息已发送，ID: ${messageId}` };
      } catch (error) {
        return { success: false, message: `发送失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 9. odoo_search ─────────────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_search',
    description: '在辉火云企业套件中搜索任意模型的记录。用于"帮我查客户"、"看看销售订单"、"查库存"等指令。',
    schema: {
      type: 'object',
      properties: {
        model:  { type: 'string', description: '模型名称，如 res.partner、project.task、crm.lead、sale.order、purchase.order、stock.quant' },
        domain: { type: 'array',  description: '搜索域，格式 [[field, operator, value], ...]，不填返回所有记录' },
        fields: { type: 'array', items: { type: 'string' }, description: '返回字段列表，不填默认返回 id 和 name' },
        limit:  { type: 'number', description: '返回数量上限，默认 20' },
        order:  { type: 'string', description: '排序规则，如 "create_date desc"' },
      },
      required: ['model'],
    },
    async handler(params: {
      model: string;
      domain?: unknown[];
      fields?: string[];
      limit?: number;
      order?: string;
    }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const result = await client.searchRead(
          params.model,
          (params.domain as [string, string, unknown][]) ?? [],
          params.fields ?? ['id', 'name'],
          { limit: params.limit ?? 20, order: params.order },
        );
        return { success: true, count: result.length, records: result.records };
      } catch (error) {
        return { success: false, message: `查询失败: ${error instanceof Error ? error.message : String(error)}` };
      }
    },
  });

  // ── 10. odoo_status ────────────────────────────────────────────────────────
  api.registerTool({
    name: 'odoo_status',
    description: '检查辉火云企业套件连接状态。',
    schema: { type: 'object', properties: {} },
    async handler(_params: unknown, ctx: Record<string, unknown>) {
      const agentId = (ctx['agentId'] as string | undefined) ?? 'default';
      const client = odooClients.get(agentId);
      const poller = pollers.get(agentId);
      const info = client?.getSessionInfo();
      return {
        success: true,
        connected: client?.isAuthenticated() ?? false,
        uid: info?.uid ?? null,
        username: info?.username ?? null,
        url: info?.url ?? null,
        polling: poller?.getStatus() ?? null,
      };
    },
  });

  api.logger.info('[odoo] 10 个工具已注册');
}

// ── 注册钩子 ──────────────────────────────────────────────────────────────────
function registerHooks(api: OpenClawPluginApi) {
  /**
   * before_prompt_build：在每次对话前注入 Odoo 系统上下文。
   *
   * 连接后，LLM 通过这段系统上下文自动理解自然语言中的 Odoo 意图：
   * - "帮我写个待办" → 调用 odoo_create_task
   * - "提醒我明天开会" → 调用 odoo_create_activity 或 odoo_create_event
   * - "查看我的消息" → 调用 odoo_get_messages
   * 等等，无需手动指定工具名称。
   */
  api.on('before_prompt_build', (_event: unknown, ctx: unknown) => {
    const agentId = (ctx as { agentId?: string } | undefined)?.agentId?.trim() ?? 'default';
    const client = odooClients.get(agentId);
    const todayStr = today();
    const tomorrowStr = tomorrow();

    if (!client?.isAuthenticated()) {
      return {
        appendSystemContext: `
## 辉火云企业套件（Odoo 19）插件

插件已加载，但尚未连接到 Odoo 系统。

如果用户提到以下内容，请引导用户使用 **odoo_connect** 工具提供连接信息：
- 待办、任务、提醒、活动、日历、会议
- 消息、邮件、通知
- 客户、联系人、商机、线索、销售订单、采购订单、库存

连接需要：Odoo 系统地址（URL）、数据库名、用户名（邮箱）、密码。
`.trim(),
      };
    }

    const info = client.getSessionInfo();

    return {
      appendSystemContext: `
## 辉火云企业套件（Odoo 19）已连接

**连接信息：** ${info.url} | 用户：${info.username}（uid: ${info.uid}）
**今日：** ${todayStr} | **明日：** ${tomorrowStr}

### 可用工具

| 工具名 | 用途 |
|--------|------|
| odoo_create_task | 创建待办/任务 |
| odoo_list_tasks | 查看待办列表（today_only 参数=今日截止） |
| odoo_create_activity | 创建活动提醒（关联到某条记录） |
| odoo_list_activities | 查看今日及逾期活动 |
| odoo_create_event | 创建日历事件/会议 |
| odoo_get_messages | 查看 chatter 消息和邮件通知 |
| odoo_send_message | 向某条记录发 chatter 消息 |
| odoo_search | 通用搜索（任意模型） |
| odoo_status | 检查连接状态 |

### 自然语言意图映射

当用户说…时，请**直接**调用对应工具，无需二次询问是否使用：

- **"帮我写个待办"** / **"创建任务"** → **odoo_create_task**（追问标题即可，日期可选）
- **"提醒我XXX"** / **"设个提醒"** → **odoo_create_activity**（需要关联到某条记录；若没有具体记录，可先用 odoo_search 找到，或改为 odoo_create_event）
- **"安排一个会议"** / **"预约XXX"** → **odoo_create_event**（追问时间、主题）
- **"查看我的消息/邮件/通知"** → **odoo_get_messages**
- **"我今天有什么"** / **"今日任务"** → **odoo_list_tasks(today_only=true)** + **odoo_list_activities**
- **"看看我的待办"** → **odoo_list_tasks**
- **"帮我查客户"** → **odoo_search(model="res.partner")**
- **"查商机"** → **odoo_search(model="crm.lead", domain=[["type","=","opportunity"]])**
- **"查销售订单"** → **odoo_search(model="sale.order")**
- **"查采购订单"** → **odoo_search(model="purchase.order")**
- **"查库存"** → **odoo_search(model="stock.quant")**
- **"查项目"** → **odoo_search(model="project.project")**
- **"Odoo 状态"** / **"连接状态"** → **odoo_status**

### 日期格式规范（Odoo）

- Date 字段（如 date_deadline）：**YYYY-MM-DD**，今天 = ${todayStr}，明天 = ${tomorrowStr}
- Datetime 字段（如 start/stop）：**YYYY-MM-DD HH:MM:SS**，默认上午 = 09:00:00，下午 = 14:00:00，全天 = 09:00:00 ~ 18:00:00

### 常用 Odoo 模型

| 模型 | 说明 |
|------|------|
| project.task | 任务/待办 |
| mail.activity | 活动提醒 |
| calendar.event | 日历事件 |
| mail.message | Chatter 消息 |
| res.partner | 客户/联系人 |
| crm.lead | 商机/线索 |
| sale.order | 销售订单 |
| purchase.order | 采购订单 |
| stock.quant | 库存 |
| project.project | 项目 |
| account.analytic.line | 工时记录 |
`.trim(),
    };
  });

  api.logger.info('[odoo] before_prompt_build 钩子已注册');
}

// ── 处理 Odoo 更新通知 ────────────────────────────────────────────────────────
function handleOdooUpdates(api: OpenClawPluginApi, updates: SyncUpdate[], agentId: string) {
  for (const update of updates) {
    let title = '';
    let body = '';

    switch (update.type) {
      case 'todo':
        title = update.action === 'create' ? '📋 新待办' : '📋 待办更新';
        body = String((update.data as Record<string, unknown>)['name'] ?? '');
        break;
      case 'activity':
        title = '⏰ 活动到期提醒';
        body = String((update.data as Record<string, unknown>)['summary'] ?? '新活动');
        break;
      case 'message':
        title = '💬 新消息';
        body = String((update.data as Record<string, unknown>)['subject'] ?? '无主题');
        break;
      case 'email':
        title = '📧 新邮件通知';
        body = `通知 ID: ${update.id}`;
        break;
      case 'calendar':
        title = update.action === 'create' ? '📅 新日历事件' : '📅 日历事件更新';
        body = String((update.data as Record<string, unknown>)['name'] ?? '');
        break;
    }

    if (title && body) {
      (api as unknown as Record<string, unknown>)['sendNotification']?.({
        agentId,
        title: `辉火云企业套件 — ${title}`,
        body,
        data: update,
      });
    }
  }
}

// ── 工具辅助函数 ──────────────────────────────────────────────────────────────
function getClient(ctx: Record<string, unknown>): OdooClient | undefined {
  const agentId = (ctx['agentId'] as string | undefined) ?? 'default';
  const client = odooClients.get(agentId);
  return client?.isAuthenticated() ? client : undefined;
}

function notConnected() {
  return { success: false, message: '未连接到辉火云企业套件，请先使用 odoo_connect 工具提供连接信息' };
}
