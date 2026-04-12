/**
 * 火一五·辉火云·欧度插件（Odoo 19 Enterprise）v1.2
 *
 * v1.2 新增：
 * - 每个 WeCom 动态 agent 用户独立的 Odoo 凭据存储
 * - 首次使用自动引导输入系统地址、用户名、密码
 * - 数据库自动检测（单库自动连接，多库让用户选择）
 * - 联系人/客户管理（查询、创建）
 * - 库存查询（库存量、调拨单）
 * - HR 员工查询、考勤、请假
 * - 审批流查询
 *
 * 工具清单（共 32 个）：
 * 连接     odoo_connect, odoo_status, odoo_disconnect
 * 任务     odoo_create_task, odoo_list_tasks, odoo_update_task
 * 活动     odoo_create_activity, odoo_list_activities, odoo_activity_types
 * 日历     odoo_create_event
 * 消息     odoo_get_messages, odoo_send_message
 * 搜索     odoo_search
 * CRM      odoo_crm_pipeline, odoo_crm_create, odoo_crm_update, odoo_crm_won, odoo_crm_lost
 * 项目     odoo_project_overview, odoo_timesheet_log
 * 销售     odoo_sale_orders, odoo_purchase_orders
 * 客服     odoo_tickets, odoo_ticket_create
 * 财务     odoo_invoices
 * 联系人   odoo_contacts, odoo_contact_create
 * 库存     odoo_stock_levels, odoo_stock_pickings
 * HR       odoo_employees, odoo_leaves, odoo_attendances
 * 审批     odoo_approvals
 * 助手     odoo_daily_briefing
 */

import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk';
import { OdooClient } from './src/modules/odoo-client.js';
import { NotificationPoller } from './src/modules/notification-poller.js';
import { ConfigManager } from './src/modules/config-manager.js';
import type { OdooPluginConfig, SyncUpdate } from './src/types/index.js';
import { today, tomorrow } from './src/utils/date-utils.js';

const odooClients = new Map<string, OdooClient>();
const pollers = new Map<string, NotificationPoller>();
const configManager = new ConfigManager();

export default definePluginEntry({
  id: 'odoo',
  name: '火一五·辉火云·欧度插件',
  description: '自然语言操作辉火云·欧度（Odoo 19），实施经理助手，per-agent 凭据隔离',

  register(api: OpenClawPluginApi) {
    // 不在启动时全局连接。每个 agent 的连接在 before_prompt_build 或 odoo_connect 时按需恢复。
    registerTools(api);
    registerHooks(api);
    api.logger.info('[odoo] 插件 v1.2 已加载（per-agent 隔离模式）');
  },
});

// ── 初始化客户端（per-agent）─────────────────────────────────────────────────
async function initOdooClient(
  api: OpenClawPluginApi,
  odooConfig: NonNullable<OdooPluginConfig['odoo']>,
  agentId: string = 'default',
): Promise<OdooClient> {
  const client = new OdooClient(odooConfig);
  await client.authenticate();
  odooClients.set(agentId, client);

  const syncConfig = ((api.pluginConfig ?? {}) as OdooPluginConfig).sync ?? {
    enabled: true, intervalSeconds: 30, channels: ['todo', 'activity', 'message'],
  };

  if (syncConfig.enabled !== false) {
    pollers.get(agentId)?.stop();
    const poller = new NotificationPoller(client);
    pollers.set(agentId, poller);
    poller.start((updates: SyncUpdate[]) => handleOdooUpdates(api, updates, agentId),
      { intervalSeconds: syncConfig.intervalSeconds, channels: syncConfig.channels });
  }

  api.logger.info(`[odoo] agent=${agentId} 已连接 ${odooConfig.url}，uid=${client.getUid()}`);
  return client;
}

/** 尝试从持久化配置恢复 agent 连接（静默，不抛错） */
async function tryRestoreAgent(api: OpenClawPluginApi, agentId: string): Promise<OdooClient | undefined> {
  if (odooClients.get(agentId)?.isAuthenticated()) return odooClients.get(agentId);
  const saved = configManager.load(agentId);
  if (!saved?.odoo) return undefined;
  try {
    api.logger.info(`[odoo] 恢复 agent=${agentId} 的连接...`);
    return await initOdooClient(api, saved.odoo, agentId);
  } catch (err) {
    api.logger.error(`[odoo] agent=${agentId} 恢复失败: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

// ── 工具辅助 ──────────────────────────────────────────────────────────────────
function getClient(ctx: Record<string, unknown>): OdooClient | undefined {
  const aid = getAgentId(ctx);
  const client = odooClients.get(aid);
  return client?.isAuthenticated() ? client : undefined;
}
function notConnected() {
  return { success: false, message: '未连接到辉火云·欧度，请先提供系统地址、用户名和密码进行连接。' };
}
function getAgentId(ctx: Record<string, unknown>) {
  return (ctx['agentId'] as string | undefined)?.trim() || 'default';
}
function stripHtml(html: string) {
  return String(html ?? '').replace(/<[^>]+>/g, '').trim().substring(0, 300);
}

// ── 注册工具（共 32 个）──────────────────────────────────────────────────────
function registerTools(api: OpenClawPluginApi) {

  // ══════════════════════════════════════════════════════
  // 连接 & 状态
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_connect',
    description: '连接辉火云·欧度（Odoo 19）系统。db 为可选，若不传则自动检测数据库（仅一个时自动选择，多个时返回列表供用户选择）。',
    schema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'Odoo 系统地址，如 https://www.huo15.com' },
        db:       { type: 'string', description: '数据库名称（可选，只有一个数据库时可省略）' },
        username: { type: 'string', description: '用户名（邮箱或登录名）' },
        password: { type: 'string', description: '密码' },
      },
      required: ['url', 'username', 'password'],
    },
    async handler(params: { url: string; db?: string; username: string; password: string }, ctx: Record<string, unknown>) {
      const aid = getAgentId(ctx);
      let db = params.db;

      // 未指定 db 时自动检测
      if (!db) {
        try {
          const dbs = await OdooClient.listDatabases(params.url);
          if (dbs.length === 0) return { success: false, message: '该 Odoo 实例没有可用的数据库' };
          if (dbs.length === 1) {
            db = dbs[0];
          } else {
            return { success: false, needSelectDb: true, databases: dbs, message: `检测到 ${dbs.length} 个数据库，请告诉我要连接哪一个：${dbs.join('、')}` };
          }
        } catch {
          return { success: false, message: '无法自动检测数据库列表，请手动提供数据库名称（db 参数）' };
        }
      }

      const cfg = { url: params.url, db, username: params.username, password: params.password };
      try {
        await initOdooClient(api, cfg, aid);
        configManager.saveOdooConfig(cfg, aid);
        return { success: true, message: `已成功连接到 ${params.url}（数据库: ${db}），欢迎使用辉火云·欧度！` };
      } catch (e) { return { success: false, message: `连接失败: ${e instanceof Error ? e.message : String(e)}` }; }
    },
  });

  api.registerTool({
    name: 'odoo_status',
    description: '检查辉火云·欧度连接状态',
    schema: { type: 'object', properties: {} },
    async handler(_p: unknown, ctx: Record<string, unknown>) {
      const aid = getAgentId(ctx);
      const client = odooClients.get(aid);
      const info = client?.getSessionInfo();
      return { success: true, connected: client?.isAuthenticated() ?? false, agentId: aid, uid: info?.uid ?? null, username: info?.username ?? null, url: info?.url ?? null, polling: pollers.get(aid)?.getStatus() ?? null };
    },
  });

  api.registerTool({
    name: 'odoo_disconnect',
    description: '断开辉火云·欧度连接并清除已保存的凭据。',
    schema: { type: 'object', properties: {} },
    async handler(_p: unknown, ctx: Record<string, unknown>) {
      const aid = getAgentId(ctx);
      pollers.get(aid)?.stop();
      pollers.delete(aid);
      const client = odooClients.get(aid);
      if (client) {
        try { await client.destroy(); } catch { /* ignore */ }
        odooClients.delete(aid);
      }
      configManager.clear(aid);
      return { success: true, message: '已断开连接并清除凭据。如需重新连接，请提供系统地址、用户名和密码。' };
    },
  });

  // ══════════════════════════════════════════════════════
  // 任务 / 待办
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_create_task',
    description: '创建待办任务。用于"帮我写个待办"、"创建任务"等指令。',
    schema: {
      type: 'object',
      properties: {
        name:          { type: 'string', description: '任务名称（必填）' },
        description:   { type: 'string', description: '详细描述' },
        date_deadline: { type: 'string', description: '截止日期 YYYY-MM-DD' },
        priority:      { type: 'string', enum: ['0','1','2','3'], description: '优先级：0普通 1中 2高 3紧急' },
        project_id:    { type: 'number', description: '所属项目ID' },
        user_ids:      { type: 'array',  items: { type: 'number' }, description: '指派用户ID列表' },
      },
      required: ['name'],
    },
    async handler(p: { name: string; description?: string; date_deadline?: string; priority?: '0'|'1'|'2'|'3'; project_id?: number; user_ids?: number[] }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const taskId = await client.createTask({ name: p.name, description: p.description, date_deadline: p.date_deadline, priority: p.priority, project_id: p.project_id, user_ids: p.user_ids });
        return { success: true, taskId, message: `待办「${p.name}」已创建，ID: ${taskId}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_list_tasks',
    description: '查看待办任务列表。today_only=true 只看今日截止。',
    schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number',  description: '上限，默认50' },
        project_id: { type: 'number',  description: '按项目筛选' },
        today_only: { type: 'boolean', description: '只看今日截止' },
        state:      { type: 'string',  description: '状态：01_in_progress / 1_done / 1_canceled' },
      },
    },
    async handler(p: { limit?: number; project_id?: number; today_only?: boolean; state?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const tasks = await client.getMyTasks({ limit: p.limit, project_id: p.project_id, today_only: p.today_only, state: p.state });
        return { success: true, count: tasks.length, tasks: tasks.map(t => ({ id: t['id'], name: t['name'], project: t['project_id'], deadline: t['date_deadline'], priority: t['priority'], stage: t['stage_id'], state: t['state'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_update_task',
    description: '更新任务的状态、截止日期、优先级等字段。',
    schema: {
      type: 'object',
      properties: {
        task_id:       { type: 'number', description: '任务ID（必填）' },
        name:          { type: 'string', description: '新名称' },
        state:         { type: 'string', description: '新状态：01_in_progress / 1_done / 1_canceled / 03_approved' },
        stage_id:      { type: 'number', description: '新阶段ID' },
        date_deadline: { type: 'string', description: '新截止日期 YYYY-MM-DD' },
        priority:      { type: 'string', enum: ['0','1','2','3'], description: '新优先级' },
        description:   { type: 'string', description: '新描述' },
      },
      required: ['task_id'],
    },
    async handler(p: { task_id: number; name?: string; state?: string; stage_id?: number; date_deadline?: string; priority?: string; description?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const values: Record<string, unknown> = {};
      if (p.name) values['name'] = p.name;
      if (p.state) values['state'] = p.state;
      if (p.stage_id) values['stage_id'] = p.stage_id;
      if (p.date_deadline) values['date_deadline'] = p.date_deadline;
      if (p.priority) values['priority'] = p.priority;
      if (p.description) values['description'] = p.description;
      try {
        await client.write('project.task', [p.task_id], values);
        return { success: true, message: `任务 #${p.task_id} 已更新` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 活动 / 日历
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_create_activity',
    description: '创建活动提醒（关联到某条记录）。用于"提醒我明天开会"等。',
    schema: {
      type: 'object',
      properties: {
        res_model:        { type: 'string', description: '关联模型，如 project.task、crm.lead、res.partner' },
        res_id:           { type: 'number', description: '关联记录ID' },
        activity_type_id: { type: 'number', description: '活动类型ID（4=待办，1=邮件，2=电话，通过 odoo_activity_types 查询）' },
        summary:          { type: 'string', description: '活动摘要/标题' },
        note:             { type: 'string', description: '详细说明' },
        date_deadline:    { type: 'string', description: '截止日期 YYYY-MM-DD' },
        user_id:          { type: 'number', description: '负责人ID，默认当前用户' },
      },
      required: ['res_model', 'res_id', 'activity_type_id', 'date_deadline'],
    },
    async handler(p: { res_model: string; res_id: number; activity_type_id: number; summary?: string; note?: string; date_deadline: string; user_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.createActivity(p);
        return { success: true, activityId: id, message: `活动「${p.summary ?? ''}」已创建` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_list_activities',
    description: '查看今日及逾期活动提醒。用于"我今天有什么活动"等。',
    schema: { type: 'object', properties: { limit: { type: 'number', description: '上限，默认30' } } },
    async handler(p: { limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const acts = await client.getTodayActivities({ limit: p.limit ?? 30 });
        return { success: true, count: acts.length, activities: acts.map(a => ({ id: a['id'], summary: a['summary'], deadline: a['date_deadline'], type: a['activity_type_id'], model: a['res_model'], state: a['state'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_activity_types',
    description: '查询 Odoo 可用的活动类型列表（获取 activity_type_id）',
    schema: { type: 'object', properties: {} },
    async handler(_p: unknown, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const types = await client.getActivityTypes();
        return { success: true, types: types.map(t => ({ id: t['id'], name: t['name'], icon: t['icon'], category: t['category'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_create_event',
    description: '创建日历事件/会议。用于"安排一个会议"、"明天上午10点开产品评审"等。',
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string',                           description: '事件名称（必填）' },
        start:       { type: 'string',                           description: '开始时间 YYYY-MM-DD HH:MM:SS（必填）' },
        stop:        { type: 'string',                           description: '结束时间 YYYY-MM-DD HH:MM:SS（必填）' },
        description: { type: 'string',                           description: '描述/议程' },
        partner_ids: { type: 'array', items: { type: 'number' }, description: '参与人 partner ID 列表' },
      },
      required: ['name', 'start', 'stop'],
    },
    async handler(p: { name: string; start: string; stop: string; description?: string; partner_ids?: number[] }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.createCalendarEvent(p);
        return { success: true, eventId: id, message: `日历事件「${p.name}」已创建，ID: ${id}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 消息
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_get_messages',
    description: '查看未读消息和邮件通知。用于"查看我的消息"、"看看邮件"等。',
    schema: {
      type: 'object',
      properties: {
        type:        { type: 'string', enum: ['message','email'], description: 'message=chatter消息，email=邮件通知' },
        limit:       { type: 'number', description: '上限，默认20' },
        unread_only: { type: 'boolean', description: '只看未读，默认true' },
      },
    },
    async handler(p: { type?: 'message'|'email'; limit?: number; unread_only?: boolean }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const limit = p.limit ?? 20;
      try {
        if (p.type === 'email') {
          const n = await client.getInboxNotifications({ limit });
          return { success: true, type: 'email', count: n.length, messages: n };
        }
        const msgs = p.unread_only !== false
          ? await client.getUnreadMessages({ limit })
          : (await client.searchRead('mail.message', [['message_type','!=','notification']], ['id','subject','body','author_id','date','model','res_id'], { limit })).records;
        return { success: true, type: 'message', count: msgs.length, messages: msgs.map(m => ({ id: m['id'], subject: m['subject'], body: stripHtml(String(m['body'] ?? '')), author: m['author_id'], date: m['date'], model: m['model'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_send_message',
    description: '向某条 Odoo 记录发送 chatter 消息。',
    schema: {
      type: 'object',
      properties: {
        model:   { type: 'string', description: '目标模型，如 project.task、crm.lead、sale.order' },
        res_id:  { type: 'number', description: '目标记录ID' },
        body:    { type: 'string', description: '消息内容（支持HTML）' },
        subject: { type: 'string', description: '主题（可选）' },
      },
      required: ['model', 'res_id', 'body'],
    },
    async handler(p: { model: string; res_id: number; body: string; subject?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.call('mail.message', 'create', [{ model: p.model, res_id: p.res_id, body: p.body, subject: p.subject ?? '', message_type: 'comment', subtype_xmlid: 'mail.mt_comment' }]);
        return { success: true, messageId: id, message: `消息已发送，ID: ${id}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 通用搜索
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_search',
    description: '通用搜索 Odoo 任意模型。用于"查客户"、"查销售订单"、"查库存"等。',
    schema: {
      type: 'object',
      properties: {
        model:  { type: 'string', description: '模型名：res.partner / project.task / crm.lead / sale.order / purchase.order / stock.quant / hr.employee / account.move 等' },
        domain: { type: 'array',  description: '搜索域 [[field, op, value], ...]' },
        fields: { type: 'array',  items: { type: 'string' }, description: '返回字段' },
        limit:  { type: 'number', description: '上限，默认20' },
        order:  { type: 'string', description: '排序，如 "create_date desc"' },
      },
      required: ['model'],
    },
    async handler(p: { model: string; domain?: unknown[]; fields?: string[]; limit?: number; order?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const r = await client.searchRead(p.model, (p.domain as [string,string,unknown][]) ?? [], p.fields ?? ['id','name'], { limit: p.limit ?? 20, order: p.order });
        return { success: true, count: r.length, records: r.records };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // CRM 商机
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_crm_pipeline',
    description: '查看 CRM 商机管道。用于"查看我的商机"、"销售管道情况"等。',
    schema: {
      type: 'object',
      properties: {
        limit:     { type: 'number',  description: '上限，默认30' },
        stage_id:  { type: 'number',  description: '按阶段ID筛选' },
        user_id:   { type: 'number',  description: '按销售员筛选' },
        type:      { type: 'string',  enum: ['lead','opportunity'], description: '线索或商机' },
        all_users: { type: 'boolean', description: '查看全部用户商机（不只是自己）' },
      },
    },
    async handler(p: { limit?: number; stage_id?: number; user_id?: number; type?: 'lead'|'opportunity'; all_users?: boolean }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const uid = client.getUid() ?? 0;
      try {
        const leads = await client.getCrmPipeline({ limit: p.limit, stage_id: p.stage_id, user_id: p.all_users ? undefined : (p.user_id ?? uid), type: p.type });
        return { success: true, count: leads.length, pipeline: leads.map(l => ({ id: l['id'], name: l['name'], partner: l['partner_id'], stage: l['stage_id'], probability: l['probability'], revenue: l['expected_revenue'], deadline: l['date_deadline'], type: l['type'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_crm_create',
    description: '创建 CRM 商机或线索。用于"新建一个商机"等。',
    schema: {
      type: 'object',
      properties: {
        name:             { type: 'string', description: '商机名称（必填）' },
        type:             { type: 'string', enum: ['lead','opportunity'], description: '类型，默认 opportunity' },
        partner_id:       { type: 'number', description: '客户ID' },
        expected_revenue: { type: 'number', description: '预计收入' },
        probability:      { type: 'number', description: '赢单概率 0-100' },
        stage_id:         { type: 'number', description: '阶段ID' },
        date_deadline:    { type: 'string', description: '预计关单日期 YYYY-MM-DD' },
        description:      { type: 'string', description: '备注' },
      },
      required: ['name'],
    },
    async handler(p: { name: string; type?: 'lead'|'opportunity'; partner_id?: number; expected_revenue?: number; probability?: number; stage_id?: number; date_deadline?: string; description?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.createCrmLead(p);
        return { success: true, leadId: id, message: `${p.type === 'lead' ? '线索' : '商机'}「${p.name}」已创建，ID: ${id}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_crm_update',
    description: '更新商机信息（阶段、金额、概率、截止日期等）。',
    schema: {
      type: 'object',
      properties: {
        lead_id:          { type: 'number', description: '商机ID（必填）' },
        name:             { type: 'string', description: '新名称' },
        stage_id:         { type: 'number', description: '新阶段ID' },
        expected_revenue: { type: 'number', description: '新预计收入' },
        probability:      { type: 'number', description: '新赢单概率 0-100' },
        date_deadline:    { type: 'string', description: '新截止日期 YYYY-MM-DD' },
        user_id:          { type: 'number', description: '新负责销售员ID' },
      },
      required: ['lead_id'],
    },
    async handler(p: { lead_id: number; name?: string; stage_id?: number; expected_revenue?: number; probability?: number; date_deadline?: string; user_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const values: Record<string, unknown> = {};
      if (p.name !== undefined) values['name'] = p.name;
      if (p.stage_id !== undefined) values['stage_id'] = p.stage_id;
      if (p.expected_revenue !== undefined) values['expected_revenue'] = p.expected_revenue;
      if (p.probability !== undefined) values['probability'] = p.probability;
      if (p.date_deadline !== undefined) values['date_deadline'] = p.date_deadline;
      if (p.user_id !== undefined) values['user_id'] = p.user_id;
      try {
        await client.write('crm.lead', [p.lead_id], values);
        return { success: true, message: `商机 #${p.lead_id} 已更新` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_crm_won',
    description: '将商机标记为赢单。用于"这个商机赢了"等。',
    schema: { type: 'object', properties: { lead_id: { type: 'number', description: '商机ID（必填）' } }, required: ['lead_id'] },
    async handler(p: { lead_id: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        await client.setCrmWon([p.lead_id]);
        return { success: true, message: `商机 #${p.lead_id} 已标记为赢单` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_crm_lost',
    description: '将商机标记为输单/丢失。',
    schema: {
      type: 'object',
      properties: {
        lead_id:        { type: 'number', description: '商机ID（必填）' },
        lost_reason_id: { type: 'number', description: '丢单原因ID（可选）' },
      },
      required: ['lead_id'],
    },
    async handler(p: { lead_id: number; lost_reason_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        await client.setCrmLost([p.lead_id], p.lost_reason_id);
        return { success: true, message: `商机 #${p.lead_id} 已标记为丢单` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 项目概览 & 工时
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_project_overview',
    description: '查看项目列表和里程碑进度。用于"项目情况"、"里程碑进度"等。',
    schema: {
      type: 'object',
      properties: {
        project_id:      { type: 'number',  description: '指定某个项目ID，不填则查全部' },
        show_milestones: { type: 'boolean', description: '是否同时返回里程碑，默认true' },
      },
    },
    async handler(p: { project_id?: number; show_milestones?: boolean }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const [projects, milestones] = await Promise.all([
          client.getProjectOverview(p.project_id),
          p.show_milestones !== false ? client.getMilestones(p.project_id) : Promise.resolve([]),
        ]);
        return {
          success: true,
          projects: projects.map(pr => ({ id: pr['id'], name: pr['name'], partner: pr['partner_id'], manager: pr['user_id'], start: pr['date_start'], end: pr['date'], task_count: pr['task_count'], open_tasks: pr['open_task_count'], done_tasks: pr['closed_task_count'] })),
          milestones: milestones.map(m => ({ id: m['id'], name: m['name'], project: m['project_id'], deadline: m['deadline'], is_reached: m['is_reached'], tasks: m['task_count'], done_tasks: m['done_task_count'], overdue: m['is_deadline_exceeded'] })),
        };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_timesheet_log',
    description: '记录工时。用于"记录2小时工时"、"今天在项目A上工作了3小时"等。',
    schema: {
      type: 'object',
      properties: {
        name:       { type: 'string', description: '工作描述（必填）' },
        hours:      { type: 'number', description: '工时（小时）（必填）' },
        project_id: { type: 'number', description: '项目ID' },
        task_id:    { type: 'number', description: '任务ID' },
        date:       { type: 'string', description: '日期 YYYY-MM-DD，默认今天' },
      },
      required: ['name', 'hours'],
    },
    async handler(p: { name: string; hours: number; project_id?: number; task_id?: number; date?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.logTimesheet({ name: p.name, unit_amount: p.hours, project_id: p.project_id, task_id: p.task_id, date: p.date });
        return { success: true, timesheetId: id, message: `已记录 ${p.hours} 小时工时：「${p.name}」` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 销售 & 采购
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_sale_orders',
    description: '查看销售订单/报价单列表。用于"查看销售订单"、"报价单情况"等。',
    schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number', description: '上限，默认20' },
        state:      { type: 'string', enum: ['draft','sent','sale','cancel'], description: '状态：draft=报价 sent=已发送 sale=销售订单 cancel=已取消' },
        partner_id: { type: 'number', description: '按客户筛选' },
      },
    },
    async handler(p: { limit?: number; state?: string; partner_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const orders = await client.getSaleOrders({ limit: p.limit, state: p.state, partner_id: p.partner_id });
        return { success: true, count: orders.length, orders: orders.map(o => ({ id: o['id'], name: o['name'], partner: o['partner_id'], state: o['state'], date: o['date_order'], amount: o['amount_total'], invoice_status: o['invoice_status'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_purchase_orders',
    description: '查看采购订单/询价单列表。用于"查看采购订单"等。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '上限，默认20' },
        state: { type: 'string', enum: ['draft','sent','to approve','purchase','cancel'], description: '状态：draft=RFQ sent=已发送 to approve=待审批 purchase=采购订单 cancel=已取消' },
      },
    },
    async handler(p: { limit?: number; state?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const orders = await client.getPurchaseOrders({ limit: p.limit, state: p.state });
        return { success: true, count: orders.length, orders: orders.map(o => ({ id: o['id'], name: o['name'], vendor: o['partner_id'], state: o['state'], date: o['date_order'], planned_arrival: o['date_planned'], amount: o['amount_total'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 客服工单（Helpdesk）
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_tickets',
    description: '查看客服工单列表。用于"查看工单"、"有哪些待处理问题"等。',
    schema: {
      type: 'object',
      properties: {
        limit:      { type: 'number',  description: '上限，默认30' },
        my_tickets: { type: 'boolean', description: '只看指派给我的工单，默认true' },
        priority:   { type: 'string',  enum: ['0','1','2','3'], description: '优先级筛选' },
        partner_id: { type: 'number',  description: '按客户筛选' },
        team_id:    { type: 'number',  description: '按团队筛选' },
      },
    },
    async handler(p: { limit?: number; my_tickets?: boolean; priority?: string; partner_id?: number; team_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      const uid = client.getUid() ?? undefined;
      try {
        const tickets = await client.getHelpdeskTickets({ limit: p.limit, user_id: p.my_tickets !== false ? uid : undefined, priority: p.priority, partner_id: p.partner_id, team_id: p.team_id });
        return { success: true, count: tickets.length, tickets: tickets.map(t => ({ id: t['id'], ref: t['ticket_ref'], name: t['name'], team: t['team_id'], stage: t['stage_id'], priority: t['priority'], partner: t['partner_id'], sla_deadline: t['sla_deadline'], sla_fail: t['sla_fail'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_ticket_create',
    description: '创建客服工单。用于"帮我提交一个问题"、"新建工单"等。',
    schema: {
      type: 'object',
      properties: {
        name:        { type: 'string', description: '工单标题（必填）' },
        description: { type: 'string', description: '问题描述' },
        partner_id:  { type: 'number', description: '客户ID' },
        team_id:     { type: 'number', description: '处理团队ID' },
        priority:    { type: 'string', enum: ['0','1','2','3'], description: '优先级：0普通 1中 2高 3紧急' },
        user_id:     { type: 'number', description: '指派人员ID' },
      },
      required: ['name'],
    },
    async handler(p: { name: string; description?: string; partner_id?: number; team_id?: number; priority?: '0'|'1'|'2'|'3'; user_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.createHelpdeskTicket(p);
        return { success: true, ticketId: id, message: `工单「${p.name}」已创建，ID: ${id}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 财务 / 发票
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_invoices',
    description: '查看发票/账单列表，支持查逾期应收。用于"查看发票"、"逾期未付款的"等。',
    schema: {
      type: 'object',
      properties: {
        limit:         { type: 'number',  description: '上限，默认20' },
        move_type:     { type: 'string',  enum: ['out_invoice','in_invoice','out_refund','in_refund'], description: '类型：out_invoice=客户发票 in_invoice=供应商账单' },
        payment_state: { type: 'string',  enum: ['not_paid','partial','paid','in_payment'], description: '付款状态' },
        overdue_only:  { type: 'boolean', description: '只看逾期未付发票' },
        partner_id:    { type: 'number',  description: '按客户/供应商筛选' },
      },
    },
    async handler(p: { limit?: number; move_type?: string; payment_state?: string; overdue_only?: boolean; partner_id?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const invoices = p.overdue_only
          ? await client.getOverdueInvoices()
          : await client.getInvoices({ limit: p.limit, move_type: p.move_type, payment_state: p.payment_state, partner_id: p.partner_id });
        return { success: true, count: invoices.length, invoices: invoices.map(i => ({ id: i['id'], name: i['name'], type: i['move_type'], partner: i['partner_id'], date: i['invoice_date'], due_date: i['invoice_date_due'], amount: i['amount_total'], payment_state: i['payment_state'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 联系人 / 客户（v1.2 新增）
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_contacts',
    description: '查询联系人/客户/供应商。用于"查客户"、"找供应商"、"搜索联系人"等。',
    schema: {
      type: 'object',
      properties: {
        keyword:       { type: 'string',  description: '按名称模糊搜索' },
        is_company:    { type: 'boolean', description: 'true=只看公司 false=只看个人' },
        customer_only: { type: 'boolean', description: '只看客户' },
        supplier_only: { type: 'boolean', description: '只看供应商' },
        limit:         { type: 'number',  description: '上限，默认30' },
      },
    },
    async handler(p: { keyword?: string; is_company?: boolean; customer_only?: boolean; supplier_only?: boolean; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const contacts = await client.getPartners({ keyword: p.keyword, is_company: p.is_company, customer_rank: p.customer_only, supplier_rank: p.supplier_only, limit: p.limit });
        return { success: true, count: contacts.length, contacts: contacts.map(c => ({ id: c['id'], name: c['name'], email: c['email'], phone: c['phone'], mobile: c['mobile'], is_company: c['is_company'], city: c['city'], country: c['country_id'], parent: c['parent_id'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_contact_create',
    description: '创建联系人/客户/供应商。用于"添加新客户"、"创建联系人"等。',
    schema: {
      type: 'object',
      properties: {
        name:       { type: 'string',  description: '名称（必填）' },
        email:      { type: 'string',  description: '邮箱' },
        phone:      { type: 'string',  description: '电话' },
        mobile:     { type: 'string',  description: '手机' },
        is_company: { type: 'boolean', description: '是否公司，默认false' },
        city:       { type: 'string',  description: '城市' },
        street:     { type: 'string',  description: '街道/地址' },
        parent_id:  { type: 'number',  description: '所属公司ID（个人联系人时）' },
        is_customer:{ type: 'boolean', description: '标记为客户，默认true' },
        is_supplier:{ type: 'boolean', description: '标记为供应商，默认false' },
      },
      required: ['name'],
    },
    async handler(p: { name: string; email?: string; phone?: string; mobile?: string; is_company?: boolean; city?: string; street?: string; parent_id?: number; is_customer?: boolean; is_supplier?: boolean }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const id = await client.createPartner({
          name: p.name, email: p.email, phone: p.phone, mobile: p.mobile,
          is_company: p.is_company, city: p.city, street: p.street, parent_id: p.parent_id,
          customer_rank: (p.is_customer !== false) ? 1 : 0,
          supplier_rank: p.is_supplier ? 1 : 0,
        });
        return { success: true, contactId: id, message: `${p.is_company ? '公司' : '联系人'}「${p.name}」已创建，ID: ${id}` };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 库存（v1.2 新增）
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_stock_levels',
    description: '查看库存水平。用于"查库存"、"产品XX还有多少"等。',
    schema: {
      type: 'object',
      properties: {
        keyword:     { type: 'string', description: '按产品名称模糊搜索' },
        product_id:  { type: 'number', description: '按产品ID筛选' },
        location_id: { type: 'number', description: '按库位筛选' },
        limit:       { type: 'number', description: '上限，默认50' },
      },
    },
    async handler(p: { keyword?: string; product_id?: number; location_id?: number; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const stocks = await client.getStockLevels({ keyword: p.keyword, product_id: p.product_id, location_id: p.location_id, limit: p.limit });
        return { success: true, count: stocks.length, stock: stocks.map(s => ({ id: s['id'], product: s['product_id'], location: s['location_id'], lot: s['lot_id'], quantity: s['quantity'], reserved: s['reserved_quantity'], available: s['available_quantity'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_stock_pickings',
    description: '查看调拨单/出入库单。用于"查看待出库"、"调拨单情况"等。',
    schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '上限，默认20' },
        state: { type: 'string', enum: ['draft','waiting','confirmed','assigned','done','cancel'], description: '状态：assigned=就绪 waiting=等待 done=完成' },
        type:  { type: 'string', enum: ['incoming','outgoing','internal'], description: '类型：incoming=入库 outgoing=出库 internal=内部调拨' },
      },
    },
    async handler(p: { limit?: number; state?: string; type?: string }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const pickings = await client.getStockPickings({ limit: p.limit, state: p.state, picking_type: p.type });
        return { success: true, count: pickings.length, pickings: pickings.map(pk => ({ id: pk['id'], name: pk['name'], partner: pk['partner_id'], type: pk['picking_type_id'], state: pk['state'], scheduled: pk['scheduled_date'], done: pk['date_done'], origin: pk['origin'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // HR 员工 / 考勤 / 请假（v1.2 新增）
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_employees',
    description: '查询员工列表。用于"查员工"、"某部门有谁"等。',
    schema: {
      type: 'object',
      properties: {
        keyword:       { type: 'string', description: '按名称模糊搜索' },
        department_id: { type: 'number', description: '按部门ID筛选' },
        limit:         { type: 'number', description: '上限，默认50' },
      },
    },
    async handler(p: { keyword?: string; department_id?: number; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const emps = await client.getEmployees({ keyword: p.keyword, department_id: p.department_id, limit: p.limit });
        return { success: true, count: emps.length, employees: emps.map(e => ({ id: e['id'], name: e['name'], department: e['department_id'], job: e['job_id'], email: e['work_email'], phone: e['mobile_phone'], manager: e['parent_id'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_leaves',
    description: '查看请假记录。用于"我的请假记录"、"查看某人的请假"等。',
    schema: {
      type: 'object',
      properties: {
        employee_id: { type: 'number', description: '员工ID，不填则查当前用户' },
        state:       { type: 'string', enum: ['draft','confirm','validate1','validate','refuse'], description: '状态筛选' },
        limit:       { type: 'number', description: '上限，默认20' },
      },
    },
    async handler(p: { employee_id?: number; state?: string; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const leaves = await client.getLeaves({ employee_id: p.employee_id, state: p.state, limit: p.limit });
        return { success: true, count: leaves.length, leaves: leaves.map(l => ({ id: l['id'], name: l['name'], employee: l['employee_id'], type: l['holiday_status_id'], from: l['date_from'], to: l['date_to'], days: l['number_of_days'], state: l['state'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.registerTool({
    name: 'odoo_attendances',
    description: '查看考勤打卡记录。用于"我的考勤"、"打卡记录"等。',
    schema: {
      type: 'object',
      properties: {
        employee_id: { type: 'number', description: '员工ID，不填则查当前用户' },
        limit:       { type: 'number', description: '上限，默认20' },
      },
    },
    async handler(p: { employee_id?: number; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const records = await client.getAttendances({ employee_id: p.employee_id, limit: p.limit });
        return { success: true, count: records.length, attendances: records.map(a => ({ id: a['id'], employee: a['employee_id'], check_in: a['check_in'], check_out: a['check_out'], worked_hours: a['worked_hours'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 审批（v1.2 新增）
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_approvals',
    description: '查看审批请求列表。用于"我的审批"、"待审批的"等。',
    schema: {
      type: 'object',
      properties: {
        my_requests: { type: 'boolean', description: '只看我提交的请求' },
        state:       { type: 'string', enum: ['new','pending','approved','refused','cancel'], description: '状态筛选' },
        limit:       { type: 'number', description: '上限，默认20' },
      },
    },
    async handler(p: { my_requests?: boolean; state?: string; limit?: number }, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const approvals = await client.getApprovals({ my_requests: p.my_requests, state: p.state, limit: p.limit });
        return { success: true, count: approvals.length, approvals: approvals.map(a => ({ id: a['id'], name: a['name'], category: a['category_id'], owner: a['request_owner_id'], status: a['request_status'], date: a['date'], amount: a['amount'], reason: a['reason'] })) };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  // ══════════════════════════════════════════════════════
  // 实施经理每日概况
  // ══════════════════════════════════════════════════════

  api.registerTool({
    name: 'odoo_daily_briefing',
    description: '实施经理每日工作概况：今日截止任务、到期活动、待处理工单、逾期发票、商机跟进、未读消息。用于"今天有什么工作"、"给我今日概况"等。',
    schema: { type: 'object', properties: {} },
    async handler(_p: unknown, ctx: Record<string, unknown>) {
      const client = getClient(ctx);
      if (!client) return notConnected();
      try {
        const briefing = await client.getDailyBriefing();
        const todayStr = today();
        const total = briefing.todayTasks.length + briefing.overdueActivities.length + briefing.openTickets.length;
        return {
          success: true,
          message: `${todayStr} 概况：${total} 项核心待处理`,
          briefing: {
            date: todayStr,
            today_tasks: { count: briefing.todayTasks.length, items: briefing.todayTasks.map(t => ({ id: t['id'], name: t['name'], project: t['project_id'], deadline: t['date_deadline'], priority: t['priority'] })) },
            activities:  { count: briefing.overdueActivities.length, items: briefing.overdueActivities.map(a => ({ id: a['id'], summary: a['summary'], deadline: a['date_deadline'], type: a['activity_type_id'], model: a['res_model'], state: a['state'] })) },
            tickets:     { count: briefing.openTickets.length, items: briefing.openTickets.map(t => ({ id: t['id'], ref: t['ticket_ref'], name: t['name'], priority: t['priority'], sla_fail: t['sla_fail'] })) },
            overdue_invoices: { count: briefing.overdueInvoices.length, items: briefing.overdueInvoices.map(i => ({ id: i['id'], name: i['name'], partner: i['partner_id'], due_date: i['invoice_date_due'], amount: i['amount_total'] })) },
            crm_followups:    { count: briefing.crmFollowUps.length, items: briefing.crmFollowUps.map(l => ({ id: l['id'], name: l['name'], partner: l['partner_id'], stage: l['stage_id'], revenue: l['expected_revenue'] })) },
            unread_messages:  { count: briefing.unreadMessages.length, items: briefing.unreadMessages.map(m => ({ id: m['id'], subject: m['subject'], author: m['author_id'], model: m['model'] })) },
          },
        };
      } catch (e) { return { success: false, message: String(e) }; }
    },
  });

  api.logger.info('[odoo] 32 个工具已注册');
}

// ── 注册 before_prompt_build 钩子 ─────────────────────────────────────────────
function registerHooks(api: OpenClawPluginApi) {
  api.on('before_prompt_build', async (_event: unknown, ctx: unknown) => {
    const aid = (ctx as { agentId?: string } | undefined)?.agentId?.trim() ?? 'default';
    const todayStr = today();
    const tomorrowStr = tomorrow();

    // 尝试从持久化恢复连接（per-agent）
    let client = odooClients.get(aid);
    if (!client?.isAuthenticated()) {
      client = await tryRestoreAgent(api, aid) ?? undefined;
    }

    if (!client?.isAuthenticated()) {
      return {
        appendSystemContext: `
## 辉火云·欧度（Odoo 19）插件 — 未连接

插件已加载但当前用户（agent: ${aid}）尚未连接到 Odoo。当用户提到任何 ERP/Odoo 相关操作（待办、任务、商机、客户、订单、工单、发票、会议、提醒、项目、工时、库存、员工、审批等），你必须：

1. 告诉用户需要先连接辉火云·欧度
2. 依次询问以下信息：
   - **公司系统地址**（URL）：例如 https://www.huo15.com
   - **用户名**（邮箱或登录名）
   - **密码**
3. **数据库名不需要主动询问** — odoo_connect 会自动检测。如果只有一个数据库会自动连接；如果有多个数据库，工具会返回列表，届时再让用户选择。
4. 收集到 URL、用户名、密码后，立即调用 **odoo_connect**（不传 db 参数）
5. 连接成功后凭据会自动保存，下次使用无需重新输入

示例引导话术："要使用辉火云·欧度，需要先连接您公司的系统。请告诉我：1) 系统地址 2) 用户名 3) 密码"`.trim(),
      };
    }

    const info = client.getSessionInfo();
    return {
      appendSystemContext: `
## 辉火云·欧度（Odoo 19）已连接

**用户：** ${info.username}（uid: ${info.uid}）| **系统：** ${info.url} | **agent：** ${aid}
**今日：** ${todayStr} | **明日：** ${tomorrowStr}

### 工具速查（共 32 个）

**基础**：odoo_connect · odoo_status · odoo_disconnect
**任务**：odoo_create_task · odoo_list_tasks · odoo_update_task
**活动**：odoo_create_activity · odoo_list_activities · odoo_activity_types · odoo_create_event
**消息**：odoo_get_messages · odoo_send_message
**搜索**：odoo_search
**CRM** ：odoo_crm_pipeline · odoo_crm_create · odoo_crm_update · odoo_crm_won · odoo_crm_lost
**项目**：odoo_project_overview · odoo_timesheet_log
**销售**：odoo_sale_orders · odoo_purchase_orders
**客服**：odoo_tickets · odoo_ticket_create
**财务**：odoo_invoices
**联系人**：odoo_contacts · odoo_contact_create
**库存**：odoo_stock_levels · odoo_stock_pickings
**HR** ：odoo_employees · odoo_leaves · odoo_attendances
**审批**：odoo_approvals
**助手**：odoo_daily_briefing

### 自然语言 → 工具映射（直接调用，无需询问）

| 用户说 | 调用工具 |
|--------|---------|
| 今天有什么工作 / 每日概况 | **odoo_daily_briefing** |
| 帮我写个待办 / 创建任务 | **odoo_create_task** |
| 今日截止任务 / 今天要做什么 | **odoo_list_tasks**(today_only=true) |
| 把任务 #X 标记完成 | **odoo_update_task**(state="1_done") |
| 提醒我… | **odoo_create_activity** |
| 安排会议 / 约个时间 | **odoo_create_event** |
| 查看商机 / 销售管道 | **odoo_crm_pipeline** |
| 新建商机 | **odoo_crm_create** |
| 这个商机赢了 / 标记赢单 | **odoo_crm_won** |
| 商机丢了 / 标记输单 | **odoo_crm_lost** |
| 项目进展 / 里程碑进度 | **odoo_project_overview** |
| 记录工时 X 小时 | **odoo_timesheet_log** |
| 查看工单 / 待处理问题 | **odoo_tickets** |
| 新建工单 / 提交问题 | **odoo_ticket_create** |
| 查发票 / 逾期应收 | **odoo_invoices**(overdue_only=true) |
| 查销售订单 | **odoo_sale_orders** |
| 查采购订单 | **odoo_purchase_orders** |
| 查客户 / 找联系人 | **odoo_contacts** |
| 添加新客户 | **odoo_contact_create** |
| 查库存 / 产品还有多少 | **odoo_stock_levels** |
| 调拨单 / 出入库 | **odoo_stock_pickings** |
| 查员工 / 某部门有谁 | **odoo_employees** |
| 请假记录 | **odoo_leaves** |
| 考勤 / 打卡 | **odoo_attendances** |
| 审批 / 待审批 | **odoo_approvals** |
| 查看消息 / 邮件通知 | **odoo_get_messages** |
| 查活动类型 | **odoo_activity_types** |
| 断开连接 / 退出系统 | **odoo_disconnect** |

### Odoo 常用模型
project.task · project.project · project.milestone · mail.activity · calendar.event ·
crm.lead · crm.stage · sale.order · purchase.order · helpdesk.ticket · account.move ·
res.partner · hr.employee · hr.leave · hr.attendance · stock.quant · stock.picking ·
account.analytic.line · approval.request · planning.slot

### 日期 & 字段规范
- date 字段：YYYY-MM-DD，今天=${todayStr}，明天=${tomorrowStr}
- datetime 字段：YYYY-MM-DD HH:MM:SS，默认上午 09:00:00，下午 14:00:00
- 优先级：0=普通 1=中 2高 3=紧急
- Many2one 读取返回 [id, "名称"]，写入时传数字 id
- 商机阶段可通过 odoo_search(model="crm.stage") 查询
- 活动类型可通过 odoo_activity_types 查询
`.trim(),
    };
  });

  api.logger.info('[odoo] before_prompt_build 钩子已注册（per-agent 隔离）');
}

// ── 处理 Odoo 更新通知 ────────────────────────────────────────────────────────
function handleOdooUpdates(api: OpenClawPluginApi, updates: SyncUpdate[], aid: string) {
  for (const update of updates) {
    let title = '', body = '';
    const d = update.data as Record<string, unknown>;
    switch (update.type) {
      case 'todo':     title = update.action === 'create' ? '新待办' : '待办更新'; body = String(d['name'] ?? ''); break;
      case 'activity': title = '活动到期'; body = String(d['summary'] ?? '新活动'); break;
      case 'message':  title = '新消息'; body = String(d['subject'] ?? '无主题'); break;
      case 'email':    title = '新邮件通知'; body = `通知 ID: ${update.id}`; break;
      case 'calendar': title = update.action === 'create' ? '新日历事件' : '日历更新'; body = String(d['name'] ?? ''); break;
    }
    if (title && body) {
      (api as unknown as Record<string, unknown>)['sendNotification']?.({
        agentId: aid, title: `辉火云·欧度 — ${title}`, body, data: update,
      });
    }
  }
}
