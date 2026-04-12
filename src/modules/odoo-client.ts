/**
 * Odoo JSON-RPC API 客户端 — v1.1
 *
 * 支持 Odoo 19 Enterprise 的 JSON-RPC 接口。
 * 覆盖模块：Session、Project、CRM、Sale、Purchase、
 *           Helpdesk、Accounting、HR、Stock、Mail/Activity
 */

import type { OdooConfig, OdooSession, OdooRecord, OdooError } from '../types/index.js';
import { today } from '../utils/date-utils.js';

type DomainItem = string | [string, string, unknown];
type Domain = DomainItem[];

function isOdooError(result: unknown): result is { error: OdooError } {
  return typeof result === 'object' && result !== null && 'error' in result;
}

export class OdooClient {
  private url: string;
  private db: string;
  private username: string;
  private password: string;
  private uid: number | null = null;
  private session_id: string | null = null;
  private user_context: Record<string, unknown> = {};

  constructor(config: OdooConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.db = config.db;
    this.username = config.username;
    this.password = config.password;
  }

  // ==================== 会话管理 ====================

  async authenticate(): Promise<OdooSession> {
    const result = await this.rpc('/web/session/authenticate', {
      db: this.db,
      login: this.username,
      password: this.password,
    });

    if (isOdooError(result)) {
      throw new Error(`认证失败: ${JSON.stringify(result.error)}`);
    }

    const session = result as OdooSession;
    if (!session.uid) throw new Error('认证失败：用户名或密码错误');

    this.uid = session.uid;
    this.session_id = (session as unknown as Record<string, unknown>).session_id as string | null ?? null;
    this.user_context = session.user_context || {};
    return session;
  }

  async checkSession(): Promise<boolean> {
    try {
      const result = await this.rpc('/web/session/get_session_info', {});
      const r = result as Record<string, unknown>;
      return 'uid' in r && r['uid'] !== false && r['uid'] !== null;
    } catch {
      return false;
    }
  }

  async ensureAuthenticated(): Promise<void> {
    if (!this.isAuthenticated() || !(await this.checkSession())) {
      await this.authenticate();
    }
  }

  async destroy(): Promise<void> {
    try { await this.rpc('/web/session/destroy', {}); } finally {
      this.uid = null; this.session_id = null; this.user_context = {};
    }
  }

  isAuthenticated(): boolean { return this.uid !== null; }
  getUid(): number | null { return this.uid; }

  /**
   * 查询 Odoo 实例可用的数据库列表（无需认证）
   * Odoo 19 端点: POST /web/database/list
   */
  static async listDatabases(url: string): Promise<string[]> {
    const endpoint = `${url.replace(/\/$/, '')}/web/database/list`;
    const payload = { jsonrpc: '2.0', method: 'call', id: Date.now(), params: {} };
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    const data = await response.json() as { result?: string[]; error?: unknown };
    if (data.error) throw new Error(`获取数据库列表失败: ${JSON.stringify(data.error)}`);
    return data.result ?? [];
  }
  getSessionInfo(): { uid: number | null; username: string; url: string } {
    return { uid: this.uid, username: this.username, url: this.url };
  }

  // ==================== 通用 ORM ====================

  async searchRead(
    model: string, domain: Domain, fields: string[] = ['id', 'name'],
    options: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<{ length: number; records: OdooRecord[] }> {
    const { limit = 100, offset = 0, order = '' } = options;
    const result = await this.rpc('/web/dataset/call_kw', {
      model, method: 'search_read', args: [domain],
      kwargs: { fields, domain, limit, offset, order },
    });
    if (isOdooError(result)) throw new Error(`查询 ${model} 失败: ${JSON.stringify(result.error)}`);
    const records = Array.isArray(result) ? result as OdooRecord[] : [];
    return { length: records.length, records };
  }

  async read(model: string, ids: number[], fields: string[] = ['id', 'name']): Promise<OdooRecord[]> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method: 'read', args: [ids], kwargs: { fields } });
    if (isOdooError(result)) throw new Error(`读取 ${model} 失败: ${JSON.stringify(result.error)}`);
    return result as OdooRecord[];
  }

  async create(model: string, values: Record<string, unknown>): Promise<number> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method: 'create', args: [values], kwargs: {} });
    if (isOdooError(result)) throw new Error(`创建 ${model} 失败: ${JSON.stringify(result.error)}`);
    return result as number;
  }

  async write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method: 'write', args: [ids, values], kwargs: {} });
    if (isOdooError(result)) throw new Error(`更新 ${model} 失败: ${JSON.stringify(result.error)}`);
    return result === true;
  }

  async unlink(model: string, ids: number[]): Promise<boolean> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method: 'unlink', args: [ids], kwargs: {} });
    if (isOdooError(result)) throw new Error(`删除 ${model} 失败: ${JSON.stringify(result.error)}`);
    return result === true;
  }

  async searchCount(model: string, domain: Domain): Promise<number> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method: 'search_count', args: [domain], kwargs: {} });
    if (isOdooError(result)) throw new Error(`计数 ${model} 失败: ${JSON.stringify(result.error)}`);
    return result as number;
  }

  async call(model: string, method: string, args: unknown[] = [], kwargs: Record<string, unknown> = {}): Promise<unknown> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method, args, kwargs });
    if (isOdooError(result)) throw new Error(`调用 ${model}.${method} 失败: ${JSON.stringify(result.error)}`);
    return result;
  }

  // ==================== Project / Task ====================

  async createTask(values: {
    name: string; description?: string; project_id?: number;
    date_deadline?: string; user_ids?: number[]; priority?: '0' | '1' | '2' | '3';
  }): Promise<number> {
    return this.create('project.task', {
      name: values.name,
      description: values.description || '',
      project_id: values.project_id || false,
      date_deadline: values.date_deadline || false,
      user_ids: values.user_ids ? [[6, false, values.user_ids]] : [[6, false, [this.uid ?? 1]]],
      priority: values.priority || '0',
      active: true,
    });
  }

  async getMyTasks(options: { limit?: number; project_id?: number; today_only?: boolean; state?: string } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['user_ids', 'in', [this.uid ?? 0]], ['active', '=', true]];
    if (options.project_id) domain.push(['project_id', '=', options.project_id]);
    if (options.today_only) domain.push(['date_deadline', '<=', today()]);
    if (options.state) domain.push(['state', '=', options.state]);
    const result = await this.searchRead('project.task', domain,
      ['id', 'name', 'description', 'date_deadline', 'stage_id', 'project_id', 'priority', 'user_ids', 'state', 'milestone_id'],
      { limit: options.limit ?? 50 });
    return result.records;
  }

  async getProjectOverview(projectId?: number): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (projectId) domain.push(['id', '=', projectId]);
    const result = await this.searchRead('project.project', domain,
      ['id', 'name', 'partner_id', 'user_id', 'date_start', 'date', 'task_count', 'open_task_count', 'closed_task_count'],
      { limit: 50 });
    return result.records;
  }

  async getMilestones(projectId?: number): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (projectId) domain.push(['project_id', '=', projectId]);
    const result = await this.searchRead('project.milestone', domain,
      ['id', 'name', 'project_id', 'deadline', 'is_reached', 'reached_date', 'task_count', 'done_task_count', 'is_deadline_exceeded'],
      { limit: 50 });
    return result.records;
  }

  async logTimesheet(values: {
    name: string; unit_amount: number; project_id?: number; task_id?: number; date?: string;
  }): Promise<number> {
    return this.create('account.analytic.line', {
      name: values.name,
      unit_amount: values.unit_amount,
      date: values.date || today(),
      user_id: this.uid ?? 1,
      project_id: values.project_id || false,
      task_id: values.task_id || false,
    });
  }

  // ==================== CRM ====================

  async getCrmPipeline(options: {
    limit?: number; stage_id?: number; user_id?: number;
    type?: 'lead' | 'opportunity'; won_status?: string;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.stage_id) domain.push(['stage_id', '=', options.stage_id]);
    if (options.user_id) domain.push(['user_id', '=', options.user_id]);
    else domain.push(['user_id', '=', this.uid ?? 0]);
    if (options.type) domain.push(['type', '=', options.type]);
    const result = await this.searchRead('crm.lead', domain,
      ['id', 'name', 'partner_id', 'stage_id', 'probability', 'expected_revenue', 'user_id', 'team_id', 'date_deadline', 'type', 'won_status', 'activity_ids', 'tag_ids'],
      { limit: options.limit ?? 50, order: 'stage_id asc, probability desc' });
    return result.records;
  }

  async createCrmLead(values: {
    name: string; type?: 'lead' | 'opportunity'; partner_id?: number;
    expected_revenue?: number; probability?: number; user_id?: number;
    stage_id?: number; date_deadline?: string; description?: string;
  }): Promise<number> {
    return this.create('crm.lead', {
      name: values.name,
      type: values.type || 'opportunity',
      partner_id: values.partner_id || false,
      expected_revenue: values.expected_revenue || 0,
      probability: values.probability || 10,
      user_id: values.user_id || this.uid || 1,
      stage_id: values.stage_id || false,
      date_deadline: values.date_deadline || false,
      description: values.description || '',
    });
  }

  async setCrmWon(leadIds: number[]): Promise<boolean> {
    await this.call('crm.lead', 'action_set_won', [leadIds]);
    return true;
  }

  async setCrmLost(leadIds: number[], lostReasonId?: number): Promise<boolean> {
    const kwargs: Record<string, unknown> = {};
    if (lostReasonId) kwargs['additional_values'] = { lost_reason_id: lostReasonId };
    await this.call('crm.lead', 'action_set_lost', [leadIds], kwargs);
    return true;
  }

  async getCrmStages(): Promise<OdooRecord[]> {
    const result = await this.searchRead('crm.stage', [],
      ['id', 'name', 'sequence', 'is_won', 'fold'], { order: 'sequence asc' });
    return result.records;
  }

  // ==================== Sales ====================

  async getSaleOrders(options: {
    limit?: number; state?: string; partner_id?: number; user_id?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    else domain.push(['state', 'not in', ['cancel']]);
    if (options.partner_id) domain.push(['partner_id', '=', options.partner_id]);
    if (options.user_id) domain.push(['user_id', '=', options.user_id]);
    const result = await this.searchRead('sale.order', domain,
      ['id', 'name', 'partner_id', 'state', 'date_order', 'amount_total', 'invoice_status', 'user_id', 'team_id', 'validity_date'],
      { limit: options.limit ?? 20, order: 'date_order desc' });
    return result.records;
  }

  async confirmSaleOrder(orderId: number): Promise<unknown> {
    return this.call('sale.order', 'action_confirm', [[orderId]]);
  }

  // ==================== Purchase ====================

  async getPurchaseOrders(options: { limit?: number; state?: string } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    else domain.push(['state', 'not in', ['cancel']]);
    const result = await this.searchRead('purchase.order', domain,
      ['id', 'name', 'partner_id', 'state', 'date_order', 'date_planned', 'amount_total', 'invoice_status', 'user_id'],
      { limit: options.limit ?? 20, order: 'date_order desc' });
    return result.records;
  }

  // ==================== Helpdesk ====================

  async getHelpdeskTickets(options: {
    limit?: number; stage_id?: number; user_id?: number; priority?: string;
    partner_id?: number; team_id?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.user_id !== undefined) domain.push(['user_id', '=', options.user_id]);
    if (options.stage_id) domain.push(['stage_id', '=', options.stage_id]);
    if (options.priority) domain.push(['priority', '=', options.priority]);
    if (options.partner_id) domain.push(['partner_id', '=', options.partner_id]);
    if (options.team_id) domain.push(['team_id', '=', options.team_id]);
    const result = await this.searchRead('helpdesk.ticket', domain,
      ['id', 'name', 'ticket_ref', 'team_id', 'stage_id', 'user_id', 'partner_id', 'priority', 'kanban_state', 'sla_deadline', 'sla_fail', 'create_date', 'close_date'],
      { limit: options.limit ?? 30, order: 'priority desc, create_date desc' });
    return result.records;
  }

  async createHelpdeskTicket(values: {
    name: string; team_id?: number; partner_id?: number;
    description?: string; priority?: '0' | '1' | '2' | '3'; user_id?: number;
  }): Promise<number> {
    return this.create('helpdesk.ticket', {
      name: values.name,
      team_id: values.team_id || false,
      partner_id: values.partner_id || false,
      description: values.description || '',
      priority: values.priority || '0',
      user_id: values.user_id || false,
    });
  }

  async getHelpdeskStages(teamId?: number): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (teamId) domain.push(['team_ids', 'in', [teamId]]);
    const result = await this.searchRead('helpdesk.stage', domain,
      ['id', 'name', 'sequence', 'fold'], { order: 'sequence asc' });
    return result.records;
  }

  // ==================== Accounting ====================

  async getInvoices(options: {
    limit?: number; move_type?: string; state?: string;
    partner_id?: number; payment_state?: string;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['move_type', 'in', options.move_type
      ? [options.move_type]
      : ['out_invoice', 'out_refund', 'in_invoice', 'in_refund']]];
    if (options.state) domain.push(['state', '=', options.state]);
    if (options.partner_id) domain.push(['partner_id', '=', options.partner_id]);
    if (options.payment_state) domain.push(['payment_state', '=', options.payment_state]);
    const result = await this.searchRead('account.move', domain,
      ['id', 'name', 'move_type', 'partner_id', 'state', 'invoice_date', 'invoice_date_due', 'amount_total', 'payment_state', 'invoice_status'],
      { limit: options.limit ?? 20, order: 'invoice_date desc' });
    return result.records;
  }

  async getOverdueInvoices(): Promise<OdooRecord[]> {
    const result = await this.searchRead('account.move', [
      ['move_type', '=', 'out_invoice'],
      ['state', '=', 'posted'],
      ['payment_state', 'not in', ['paid', 'reversed']],
      ['invoice_date_due', '<', today()],
    ],
      ['id', 'name', 'partner_id', 'invoice_date_due', 'amount_total', 'payment_state'],
      { limit: 30, order: 'invoice_date_due asc' });
    return result.records;
  }

  // ==================== 联系人 / 客户 ====================

  async getPartners(options: {
    limit?: number; is_company?: boolean; customer_rank?: boolean;
    supplier_rank?: boolean; keyword?: string;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.is_company !== undefined) domain.push(['is_company', '=', options.is_company]);
    if (options.customer_rank) domain.push(['customer_rank', '>', 0]);
    if (options.supplier_rank) domain.push(['supplier_rank', '>', 0]);
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    const result = await this.searchRead('res.partner', domain,
      ['id', 'name', 'email', 'phone', 'mobile', 'is_company', 'city', 'country_id', 'customer_rank', 'supplier_rank', 'parent_id'],
      { limit: options.limit ?? 30, order: 'name asc' });
    return result.records;
  }

  async createPartner(values: {
    name: string; email?: string; phone?: string; mobile?: string;
    is_company?: boolean; city?: string; street?: string;
    customer_rank?: number; supplier_rank?: number; parent_id?: number;
  }): Promise<number> {
    return this.create('res.partner', {
      name: values.name,
      email: values.email || false,
      phone: values.phone || false,
      mobile: values.mobile || false,
      is_company: values.is_company ?? false,
      city: values.city || false,
      street: values.street || false,
      customer_rank: values.customer_rank ?? 1,
      supplier_rank: values.supplier_rank ?? 0,
      parent_id: values.parent_id || false,
    });
  }

  // ==================== 库存 ====================

  async getStockLevels(options: {
    limit?: number; product_id?: number; location_id?: number; keyword?: string;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['quantity', '>', 0]];
    if (options.product_id) domain.push(['product_id', '=', options.product_id]);
    if (options.location_id) domain.push(['location_id', '=', options.location_id]);
    if (options.keyword) domain.push(['product_id.name', 'ilike', options.keyword]);
    const result = await this.searchRead('stock.quant', domain,
      ['id', 'product_id', 'location_id', 'lot_id', 'quantity', 'reserved_quantity', 'available_quantity'],
      { limit: options.limit ?? 50, order: 'product_id asc' });
    return result.records;
  }

  async getStockPickings(options: {
    limit?: number; state?: string; picking_type?: string;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    else domain.push(['state', 'not in', ['done', 'cancel']]);
    if (options.picking_type) domain.push(['picking_type_code', '=', options.picking_type]);
    const result = await this.searchRead('stock.picking', domain,
      ['id', 'name', 'partner_id', 'picking_type_id', 'state', 'scheduled_date', 'date_done', 'origin'],
      { limit: options.limit ?? 20, order: 'scheduled_date asc' });
    return result.records;
  }

  // ==================== HR ====================

  async getEmployees(options: { limit?: number; department_id?: number; active?: boolean; keyword?: string } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', options.active !== false]];
    if (options.department_id) domain.push(['department_id', '=', options.department_id]);
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    const result = await this.searchRead('hr.employee', domain,
      ['id', 'name', 'department_id', 'job_id', 'work_email', 'mobile_phone', 'parent_id', 'user_id'],
      { limit: options.limit ?? 50, order: 'name asc' });
    return result.records;
  }

  async getLeaves(options: { limit?: number; state?: string; employee_id?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    const result = await this.searchRead('hr.leave', domain,
      ['id', 'name', 'employee_id', 'holiday_status_id', 'date_from', 'date_to', 'number_of_days', 'state'],
      { limit: options.limit ?? 20, order: 'date_from desc' });
    return result.records;
  }

  async getAttendances(options: { limit?: number; employee_id?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    const result = await this.searchRead('hr.attendance', domain,
      ['id', 'employee_id', 'check_in', 'check_out', 'worked_hours'],
      { limit: options.limit ?? 20, order: 'check_in desc' });
    return result.records;
  }

  // ==================== 审批 ====================

  async getApprovals(options: { limit?: number; state?: string; my_requests?: boolean } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['request_status', '=', options.state]);
    if (options.my_requests) domain.push(['request_owner_id.user_id', '=', this.uid ?? 0]);
    const result = await this.searchRead('approval.request', domain,
      ['id', 'name', 'category_id', 'request_owner_id', 'request_status', 'date', 'date_confirmed', 'amount', 'reason'],
      { limit: options.limit ?? 20, order: 'date desc' });
    return result.records;
  }

  // ==================== Mail / Activity ====================

  async getTodayActivities(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead('mail.activity',
      [['user_id', '=', this.uid ?? 0], ['date_deadline', '<=', today()]],
      ['id', 'summary', 'date_deadline', 'activity_type_id', 'res_model', 'res_id', 'note', 'state'],
      { limit: options.limit ?? 50 });
    return result.records;
  }

  async createActivity(values: {
    res_model: string; res_id: number; activity_type_id: number;
    summary?: string; note?: string; date_deadline: string; user_id?: number;
  }): Promise<number> {
    return this.create('mail.activity', {
      res_model: values.res_model, res_id: values.res_id,
      activity_type_id: values.activity_type_id,
      summary: values.summary || '', note: values.note || '',
      date_deadline: values.date_deadline,
      user_id: values.user_id ?? this.uid ?? 1,
    });
  }

  async getActivityTypes(): Promise<OdooRecord[]> {
    const result = await this.searchRead('mail.activity.type', [],
      ['id', 'name', 'icon', 'category', 'delay_count', 'delay_unit'], { order: 'name asc' });
    return result.records;
  }

  async createCalendarEvent(values: {
    name: string; start: string; stop: string;
    description?: string; partner_ids?: number[]; alarm_ids?: number[];
  }): Promise<number> {
    return this.create('calendar.event', {
      name: values.name, start: values.start, stop: values.stop,
      description: values.description || '',
      partner_ids: values.partner_ids ? [[6, false, values.partner_ids]] : [[6, false, [this.uid ?? 1]]],
      alarm_ids: values.alarm_ids ? [[6, false, values.alarm_ids]] : false,
    });
  }

  async getUnreadMessages(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead('mail.message',
      [['message_type', '!=', 'notification'], ['to_read', '=', true]],
      ['id', 'body', 'date', 'author_id', 'model', 'res_id', 'subject'],
      { limit: options.limit ?? 20 });
    return result.records;
  }

  async getInboxNotifications(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead('mail.notification',
      [['is_read', '=', false], ['notification_type', '=', 'inbox']],
      ['id', 'mail_message_id', 'notification_status', 'is_read', 'read_date'],
      { limit: options.limit ?? 20 });
    return result.records;
  }

  // ==================== 实施经理每日概况 ====================

  async getDailyBriefing(): Promise<{
    todayTasks: OdooRecord[];
    overdueActivities: OdooRecord[];
    openTickets: OdooRecord[];
    overdueInvoices: OdooRecord[];
    crmFollowUps: OdooRecord[];
    unreadMessages: OdooRecord[];
  }> {
    const uid = this.uid ?? 0;
    const [todayTasks, overdueActivities, openTickets, overdueInvoices, crmFollowUps, unreadMessages] = await Promise.all([
      // 今日截止任务
      this.searchRead('project.task',
        [['user_ids', 'in', [uid]], ['active', '=', true], ['date_deadline', '<=', today()]],
        ['id', 'name', 'project_id', 'date_deadline', 'priority', 'stage_id'], { limit: 20 }),
      // 逾期活动
      this.searchRead('mail.activity',
        [['user_id', '=', uid], ['date_deadline', '<=', today()]],
        ['id', 'summary', 'date_deadline', 'activity_type_id', 'res_model', 'res_id', 'state'], { limit: 20 }),
      // 我的待处理工单
      this.searchRead('helpdesk.ticket',
        [['user_id', '=', uid], ['active', '=', true]],
        ['id', 'name', 'ticket_ref', 'priority', 'stage_id', 'sla_deadline', 'sla_fail'], { limit: 10 }).catch(() => ({ records: [] })),
      // 逾期应收发票
      this.getOverdueInvoices().then(r => ({ records: r })).catch(() => ({ records: [] })),
      // 需要跟进的商机（today activities）
      this.searchRead('crm.lead',
        [['user_id', '=', uid], ['active', '=', true], ['activity_date_deadline', '<=', today()]],
        ['id', 'name', 'partner_id', 'stage_id', 'probability', 'expected_revenue', 'activity_summary'], { limit: 10 }).catch(() => ({ records: [] })),
      // 未读消息
      this.searchRead('mail.message',
        [['message_type', '!=', 'notification'], ['to_read', '=', true]],
        ['id', 'subject', 'author_id', 'date', 'model', 'res_id'], { limit: 10 }),
    ]);

    return {
      todayTasks: todayTasks.records,
      overdueActivities: overdueActivities.records,
      openTickets: openTickets.records,
      overdueInvoices: overdueInvoices.records,
      crmFollowUps: crmFollowUps.records,
      unreadMessages: unreadMessages.records,
    };
  }

  // ==================== 私有传输层 ====================

  private async rpc(endpoint: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.url}${endpoint}`;
    const payload = { jsonrpc: '2.0', method: 'call', id: Date.now(), params };
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.session_id) headers['Cookie'] = `session_id=${this.session_id}`;

    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${response.statusText}`);

    const data = await response.json() as { result?: unknown; error?: OdooError };
    if (data.error) return { error: data.error };
    return data.result;
  }
}
