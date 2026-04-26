/**
 * Odoo JSON-RPC API 客户端 — v1.1
 *
 * 支持 Odoo 19 Enterprise 的 JSON-RPC 接口。
 * 覆盖模块：Session、Project、CRM、Sale、Purchase、
 *           Helpdesk、Accounting、HR、Stock、Mail/Activity
 */

import type { OdooConfig, OdooSession, OdooRecord, OdooError } from '../types/index.js';
import { today, tomorrow } from '../utils/date-utils.js';

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

  /**
   * 获取我的任务（待办）
   *
   * Odoo 待办应用（To-Do）基于 project.task 模型，
   * 过滤条件：project_id=False（无项目=私人任务）
   * 项目任务在「项目」应用中管理，不在待办里。
   *
   * Odoo project.task 状态机制：
   * - state 字段：01_in_progress / 04_waiting_normal / 1_done / 1_canceled 等
   * - is_closed = state in ['1_done', '1_canceled']
   *
   * stage_state 选项：
   *   'in_progress' — 进行中（未关闭，默认）
   *   'done'        — 已完成
   *   'all'         — 全部
   *
   * include_project — 是否包含项目任务（默认 false，待办应用模式）
   */
  async getMyTasks(options: {
    limit?: number;
    project_id?: number;
    today_only?: boolean;
    stage_state?: 'in_progress' | 'done' | 'all';
    state_filter?: string;
    stage_id?: number;
    include_project?: boolean;
  } = {}): Promise<OdooRecord[]> {
    // 待办应用过滤：project_id=False（私人任务），排除子任务
    // 项目任务（project_id 有值）属于「项目」应用，不在待办里
    const domain: Domain = [['user_ids', 'in', [this.uid ?? 0]], ['active', '=', true], ['project_id', '=', false], ['parent_id', '=', false]];
    if (options.project_id) {
      // 如果指定了 project_id，则切换到项目任务模式
      domain.length = 0;
      domain.push(['user_ids', 'in', [this.uid ?? 0]], ['active', '=', true], ['project_id', '=', options.project_id]);
    }
    if (options.today_only) domain.push(['date_deadline', '<=', today()]);

    const stageState = options.stage_state ?? 'in_progress';
    if (stageState === 'in_progress') {
      domain.push(['state', 'not in', ['1_done', '1_canceled']]);
    } else if (stageState === 'done') {
      domain.push(['state', 'in', ['1_done', '1_canceled']]);
    }

    if (options.state_filter) {
      domain.length = domain.filter(d => !Array.isArray(d) || d[0] !== 'state').length;
      domain.push(['state', '=', options.state_filter]);
    }

    if (options.stage_id) domain.push(['stage_id', '=', options.stage_id]);

    const result = await this.searchRead('project.task', domain,
      ['id', 'name', 'description', 'date_deadline', 'stage_id', 'project_id', 'priority', 'user_ids', 'milestone_id', 'state'],
      { limit: options.limit ?? 50 });
    return result.records;
  }

  /** 获取项目任务阶段列表（用于查找 stage_id） */
  async getTaskStages(projectId?: number): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (projectId) domain.push(['project_ids', '=', projectId]);
    const result = await this.searchRead('project.task.type', domain,
      ['id', 'name', 'fold', 'sequence'], { order: 'sequence asc' });
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

  /**
   * 完成活动（闭环）—— 调 mail.activity.action_feedback：
   * 活动标记为 done、写入反馈到源记录 chatter、从活动列表里移除。
   * 这是 Odoo 活动闭环的正式 API，不要直接 unlink。
   */
  async completeActivity(id: number, feedback?: string): Promise<unknown> {
    return this.call('mail.activity', 'action_feedback', [[id]], {
      feedback: feedback || '',
    });
  }

  /** 改期：把活动的 date_deadline 挪到新日期（YYYY-MM-DD） */
  async rescheduleActivity(id: number, newDeadline: string): Promise<boolean> {
    return this.write('mail.activity', [id], { date_deadline: newDeadline });
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

  /**
   * 获取今日会议/日程 —— 覆盖 [今天 00:00, 明天 00:00) 区间里与我相关的事件。
   * 包含：我是组织者、或我是参与者（partner_ids 含 my partner_id）。
   */
  async getCalendarToday(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const t = today();
    const next = tomorrow();
    const uid = this.uid ?? 0;
    // 我的 partner_id 需要先查一次（cached on session user_context 里没有，所以 read res.users）
    let myPartnerId: number | false = false;
    try {
      const users = await this.read('res.users', [uid], ['partner_id']);
      const pid = users[0]?.['partner_id'];
      if (Array.isArray(pid) && typeof pid[0] === 'number') myPartnerId = pid[0];
    } catch { /* ignore */ }

    const domain: Domain = [
      ['start', '>=', `${t} 00:00:00`],
      ['start', '<', `${next} 00:00:00`],
    ];
    if (myPartnerId) {
      domain.unshift('|', ['user_id', '=', uid], ['partner_ids', 'in', [myPartnerId]]);
    } else {
      domain.unshift(['user_id', '=', uid]);
    }

    const result = await this.searchRead('calendar.event', domain,
      ['id', 'name', 'start', 'stop', 'duration', 'location', 'partner_ids', 'description', 'user_id', 'allday'],
      { limit: options.limit ?? 30, order: 'start asc' });
    return result.records;
  }

  /** 更新日历事件（时间、地点、标题、描述、参与者） */
  async updateCalendarEvent(id: number, values: {
    name?: string; start?: string; stop?: string; location?: string;
    description?: string; partner_ids?: number[];
  }): Promise<boolean> {
    const payload: Record<string, unknown> = {};
    if (values.name !== undefined) payload['name'] = values.name;
    if (values.start !== undefined) payload['start'] = values.start;
    if (values.stop !== undefined) payload['stop'] = values.stop;
    if (values.location !== undefined) payload['location'] = values.location;
    if (values.description !== undefined) payload['description'] = values.description;
    if (values.partner_ids !== undefined) payload['partner_ids'] = [[6, false, values.partner_ids]];
    if (Object.keys(payload).length === 0) return true;
    return this.write('calendar.event', [id], payload);
  }

  /** 取消日历事件：active=false（软删除，保留历史），而不是 unlink */
  async cancelCalendarEvent(id: number): Promise<boolean> {
    return this.write('calendar.event', [id], { active: false });
  }

  // ==================== 关注者（followers）====================
  //
  // Odoo 的 mail.thread 混入提供：
  //   - message_subscribe(partner_ids, subtype_ids?) — 添加关注者
  //   - message_unsubscribe(partner_ids)              — 移除关注者
  //   - message_follower_ids                           — 列表
  // 任何继承 mail.thread 的模型（project.task、crm.lead、helpdesk.ticket、
  // sale.order、res.partner 等）都能用。

  async followRecord(model: string, resId: number, partnerIds?: number[]): Promise<unknown> {
    // 默认关注者 = 当前用户的 partner_id
    let targets = partnerIds;
    if (!targets || targets.length === 0) {
      const uid = this.uid ?? 0;
      const users = await this.read('res.users', [uid], ['partner_id']);
      const pid = users[0]?.['partner_id'];
      if (Array.isArray(pid) && typeof pid[0] === 'number') targets = [pid[0]];
      else throw new Error('无法获取当前用户的 partner_id');
    }
    return this.call(model, 'message_subscribe', [[resId]], { partner_ids: targets });
  }

  async unfollowRecord(model: string, resId: number, partnerIds?: number[]): Promise<unknown> {
    let targets = partnerIds;
    if (!targets || targets.length === 0) {
      const uid = this.uid ?? 0;
      const users = await this.read('res.users', [uid], ['partner_id']);
      const pid = users[0]?.['partner_id'];
      if (Array.isArray(pid) && typeof pid[0] === 'number') targets = [pid[0]];
      else throw new Error('无法获取当前用户的 partner_id');
    }
    return this.call(model, 'message_unsubscribe', [[resId]], { partner_ids: targets });
  }

  // ==================== 邮件（mail.mail + mail.template）====================
  //
  // 两条路径：
  //   1) 随手发一封：用 message_post 发在某条记录的 chatter，Odoo 会自动
  //      邮件化给 followers（如果 subtype 是 comment）。这是 Odoo 原生的"发邮件"方式。
  //   2) 显式发邮件给任意地址：mail.mail create → send。适合真正"给外部发邮件"场景。
  // 模板：mail.template.send_mail(res_id, force_send=True) 是 Odoo 原生的模板发送入口。

  /**
   * 直接发送邮件（不依赖 chatter）。
   * recipients 为 email 字符串数组（逗号分隔会被 Odoo 自行拆分，但我们显式传逗号拼接）。
   * bodyHtml 建议是 HTML，纯文本会按 <br/> 保留换行。
   */
  async sendEmail(values: {
    subject: string; bodyHtml: string;
    recipients: string[]; cc?: string[]; bcc?: string[];
    res_model?: string; res_id?: number;
    attachment_ids?: number[];
  }): Promise<number> {
    const payload: Record<string, unknown> = {
      subject: values.subject,
      body_html: values.bodyHtml,
      email_to: values.recipients.join(','),
      email_from: false, // Odoo 会用当前用户的邮箱/公司邮箱
    };
    if (values.cc && values.cc.length > 0) payload['email_cc'] = values.cc.join(',');
    if (values.bcc && values.bcc.length > 0) (payload as Record<string, unknown>)['email_bcc'] = values.bcc.join(',');
    if (values.res_model) payload['model'] = values.res_model;
    if (values.res_id) payload['res_id'] = values.res_id;
    if (values.attachment_ids && values.attachment_ids.length > 0) {
      payload['attachment_ids'] = [[6, false, values.attachment_ids]];
    }
    const id = await this.create('mail.mail', payload);
    // 立即发送（否则会等到 cron）
    await this.call('mail.mail', 'send', [[id]]);
    return id;
  }

  async getEmailTemplates(options: { model?: string; keyword?: string; limit?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.model) domain.push(['model', '=', options.model]);
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    const result = await this.searchRead('mail.template', domain,
      ['id', 'name', 'model', 'subject', 'email_from', 'email_to', 'use_default_to', 'lang'],
      { limit: options.limit ?? 50, order: 'name asc' });
    return result.records;
  }

  /**
   * 用模板发邮件。template_id 通过 getEmailTemplates 查。
   * res_id 是模板关联模型的记录 id（模板的 model 字段决定）。
   * force_send=true 立即入队发送。
   */
  async sendEmailFromTemplate(templateId: number, resId: number, options: {
    force_send?: boolean; email_values?: Record<string, unknown>;
  } = {}): Promise<unknown> {
    return this.call('mail.template', 'send_mail', [templateId, resId], {
      force_send: options.force_send ?? true,
      email_values: options.email_values ?? false,
    });
  }

  // ==================== 附件（ir.attachment）/ 文档（documents.document）====================
  //
  // ir.attachment 是 Odoo 通用附件表；传 datas（base64 编码）即可。
  // 挂到记录：res_model + res_id 就会在该记录的 chatter/附件面板出现。
  // documents.document 是 Enterprise 文档管理应用，可选 folder_id 归档。

  async attachFile(values: {
    res_model: string; res_id: number;
    name: string; datas_base64: string; mimetype?: string;
  }): Promise<number> {
    return this.create('ir.attachment', {
      name: values.name,
      datas: values.datas_base64,
      res_model: values.res_model,
      res_id: values.res_id,
      type: 'binary',
      mimetype: values.mimetype || 'application/octet-stream',
    });
  }

  async listAttachments(model: string, resId: number, options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead('ir.attachment',
      [['res_model', '=', model], ['res_id', '=', resId]],
      ['id', 'name', 'mimetype', 'file_size', 'create_date', 'create_uid', 'url', 'type'],
      { limit: options.limit ?? 50, order: 'create_date desc' });
    return result.records;
  }

  async uploadDocument(values: {
    name: string; datas_base64: string; mimetype?: string;
    folder_id?: number; tag_ids?: number[];
  }): Promise<number> {
    const payload: Record<string, unknown> = {
      name: values.name,
      datas: values.datas_base64,
      type: 'binary',
      mimetype: values.mimetype || 'application/octet-stream',
    };
    if (values.folder_id) payload['folder_id'] = values.folder_id;
    if (values.tag_ids && values.tag_ids.length > 0) payload['tag_ids'] = [[6, false, values.tag_ids]];
    return this.create('documents.document', payload);
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

  // ==================== Knowledge（知识库 / knowledge.article）====================
  //
  // Odoo 19 Enterprise 的 `knowledge.article` 模型要点：
  //  - body 字段是 HTML
  //  - category 由 internal_permission 计算得出：
  //      internal_permission='write' → workspace，='none' → private（无 parent 时）
  //      子文章不需要 internal_permission，权限沿 parent 继承
  //  - DB 约束：顶层文章必须给 internal_permission；子文章必须给 parent_id
  //  - 通过 action_toggle_favorite / action_send_to_trash / move_to 等 action 操作
  //  - is_user_favorite 是 compute + search，不能直接 write

  async searchKnowledgeArticles(options: {
    keyword?: string;
    category?: 'workspace' | 'private' | 'shared';
    only_favorite?: boolean;
    only_roots?: boolean;         // 只列顶层文章
    parent_id?: number;           // 列某文章的直接子节点
    limit?: number;
    include_trashed?: boolean;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (!options.include_trashed) domain.push(['to_delete', '=', false]);
    domain.push(['active', '=', true]);
    if (options.category) domain.push(['category', '=', options.category]);
    if (options.only_favorite) domain.push(['is_user_favorite', '=', true]);
    if (options.only_roots) domain.push(['parent_id', '=', false]);
    if (options.parent_id !== undefined) domain.push(['parent_id', '=', options.parent_id]);
    if (options.keyword) {
      domain.push('|', ['name', 'ilike', options.keyword], ['body', 'ilike', options.keyword]);
    }
    const result = await this.searchRead('knowledge.article', domain,
      ['id', 'name', 'icon', 'parent_id', 'root_article_id', 'category',
       'is_user_favorite', 'favorite_count', 'last_edition_date', 'last_edition_uid',
       'has_article_children', 'sequence'],
      { limit: options.limit ?? 30, order: 'sequence asc, last_edition_date desc, id desc' });
    return result.records;
  }

  /** 读取单篇文章完整内容（含 body） */
  async readKnowledgeArticle(id: number): Promise<OdooRecord | null> {
    const records = await this.read('knowledge.article', [id],
      ['id', 'name', 'icon', 'body', 'parent_id', 'root_article_id', 'category',
       'internal_permission', 'inherited_permission',
       'is_user_favorite', 'favorite_count', 'is_locked', 'to_delete',
       'last_edition_date', 'last_edition_uid', 'sequence', 'has_article_children']);
    return records[0] ?? null;
  }

  /**
   * 创建知识库文章
   *
   * - 顶层：必须传 category='workspace'|'private'；自动映射到 internal_permission
   *     workspace → 'write'  （默认所有内部用户可编辑）
   *     private   → 'none'   （仅所有者）
   *     shared    → 'none'（通常通过加 member 实现）
   * - 子文章：传 parent_id，其余权限继承
   */
  async createKnowledgeArticle(values: {
    name?: string;
    body?: string;                // HTML
    icon?: string;                // emoji
    parent_id?: number;
    category?: 'workspace' | 'private' | 'shared';
  }): Promise<number> {
    const payload: Record<string, unknown> = {
      name: values.name || '未命名',
      body: values.body ?? false,
      icon: values.icon || false,
    };
    if (values.parent_id) {
      payload['parent_id'] = values.parent_id;
    } else {
      const cat = values.category ?? 'private';
      payload['internal_permission'] = cat === 'workspace' ? 'write' : 'none';
      if (cat === 'workspace') payload['is_article_visible_by_everyone'] = true;
    }
    return this.create('knowledge.article', payload);
  }

  async updateKnowledgeArticle(id: number, values: {
    name?: string; body?: string; icon?: string;
  }): Promise<boolean> {
    const payload: Record<string, unknown> = {};
    if (values.name !== undefined) payload['name'] = values.name;
    if (values.body !== undefined) payload['body'] = values.body;
    if (values.icon !== undefined) payload['icon'] = values.icon || false;
    if (Object.keys(payload).length === 0) return true;
    return this.write('knowledge.article', [id], payload);
  }

  /**
   * 在现有文章的 body 末尾追加一段 HTML —— 读-改-写（Odoo body 字段无原子 append）。
   * 调用者负责把 markdown 之类的输入转成合法 HTML。
   */
  async appendKnowledgeArticle(id: number, htmlSuffix: string): Promise<boolean> {
    const rec = await this.readKnowledgeArticle(id);
    if (!rec) throw new Error(`文章 ${id} 不存在`);
    const body = (rec['body'] as string | false) || '';
    const next = `${body}${htmlSuffix}`;
    return this.write('knowledge.article', [id], { body: next });
  }

  /** 移动到新 parent 或在兄弟节点中排序 */
  async moveKnowledgeArticle(id: number, options: {
    parent_id?: number | false;
    before_article_id?: number;
    category?: 'workspace' | 'private' | 'shared';
  }): Promise<unknown> {
    return this.call('knowledge.article', 'move_to', [[id]], {
      parent_id: options.parent_id ?? false,
      before_article_id: options.before_article_id ?? false,
      category: options.category ?? false,
    });
  }

  async toggleKnowledgeFavorite(id: number): Promise<unknown> {
    return this.call('knowledge.article', 'action_toggle_favorite', [[id]]);
  }

  async trashKnowledgeArticle(id: number): Promise<unknown> {
    return this.call('knowledge.article', 'action_send_to_trash', [[id]]);
  }

  async restoreKnowledgeArticle(id: number): Promise<unknown> {
    return this.call('knowledge.article', 'action_unarchive', [[id]]);
  }

  // ==================== v1.8 — Chatter / Project / Ticket / Approval ====================
  //
  // Chatter = Odoo 的内置沟通轨迹。任何 mail.thread 混入的模型（几乎所有业务模型）
  // 都有 message_post() 方法：
  //   - subtype 'mail.mt_comment'   → 评论，会 email 给 followers
  //   - subtype 'mail.mt_note'      → 内部记录，只留痕不发邮件
  // body 是 HTML；message_type 常用 'comment' / 'notification'。

  /**
   * 在任意记录 chatter 发消息（评论，会通知 followers）。
   * partner_ids 传进来会被当作额外收件人加入。
   */
  async postMessage(model: string, resId: number, values: {
    bodyHtml: string;
    subject?: string;
    partner_ids?: number[];
    attachment_ids?: number[];
    as_log?: boolean;                // true = 内部记录（mt_note），false = 评论（mt_comment）
  }): Promise<number> {
    const kwargs: Record<string, unknown> = {
      body: values.bodyHtml,
      message_type: values.as_log ? 'notification' : 'comment',
      subtype_xmlid: values.as_log ? 'mail.mt_note' : 'mail.mt_comment',
    };
    if (values.subject) kwargs['subject'] = values.subject;
    if (values.partner_ids && values.partner_ids.length > 0) {
      kwargs['partner_ids'] = values.partner_ids;
    }
    if (values.attachment_ids && values.attachment_ids.length > 0) {
      kwargs['attachment_ids'] = values.attachment_ids;
    }
    const result = await this.call(model, 'message_post', [[resId]], kwargs);
    if (typeof result === 'number') return result;
    // Odoo 19 返回的是 mail.message 记录（dict），取 id
    if (typeof result === 'object' && result !== null && 'id' in (result as Record<string, unknown>)) {
      const r = result as Record<string, unknown>;
      return typeof r['id'] === 'number' ? r['id'] : 0;
    }
    return 0;
  }

  /** 读取某条记录的 chatter 消息历史（最新在前） */
  async getMessageHistory(model: string, resId: number, options: {
    limit?: number;
    include_notifications?: boolean;   // 默认 false，过滤掉系统通知（auto-followers 之类）
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['model', '=', model], ['res_id', '=', resId]];
    if (!options.include_notifications) {
      domain.push(['message_type', 'in', ['comment', 'email']]);
    }
    const result = await this.searchRead('mail.message', domain,
      ['id', 'date', 'author_id', 'email_from', 'subject', 'body', 'message_type', 'subtype_id'],
      { limit: options.limit ?? 20, order: 'date desc' });
    return result.records;
  }

  // ------- Project / Milestone ------------------------------------------------

  async createProject(values: {
    name: string;
    partner_id?: number;
    user_id?: number;                   // 项目负责人
    date_start?: string;
    date?: string;                      // 结束日期
    description?: string;
    privacy_visibility?: 'followers' | 'employees' | 'portal';
  }): Promise<number> {
    return this.create('project.project', {
      name: values.name,
      partner_id: values.partner_id || false,
      user_id: values.user_id || this.uid || false,
      date_start: values.date_start || false,
      date: values.date || false,
      description: values.description || '',
      privacy_visibility: values.privacy_visibility || 'employees',
      active: true,
    });
  }

  async createMilestone(values: {
    name: string;
    project_id: number;
    deadline?: string;
  }): Promise<number> {
    return this.create('project.milestone', {
      name: values.name,
      project_id: values.project_id,
      deadline: values.deadline || false,
    });
  }

  // ------- Helpdesk ticket 更新/关闭 ----------------------------------------

  /**
   * 查找某客服团队里 fold=true 的阶段（= 关闭阶段）。
   * 不传 teamId 就找任何 fold=true 的阶段，返回最小 sequence 的那条。
   */
  async findHelpdeskClosedStage(teamId?: number): Promise<OdooRecord | null> {
    const domain: Domain = [['fold', '=', true]];
    if (teamId) domain.push(['team_ids', 'in', [teamId]]);
    const result = await this.searchRead('helpdesk.stage', domain,
      ['id', 'name', 'sequence'], { limit: 1, order: 'sequence asc' });
    return result.records[0] ?? null;
  }

  // ------- 审批 approval.request -------------------------------------------
  //
  // 审批流状态机：
  //   new → pending（action_confirm）→ approved（action_approve）
  //                                  → refused  （action_refuse）
  //                                  → cancel   （action_withdraw）
  // 我们只暴露 approve / refuse 两个最常见的审批人动作；
  // 发起人侧的 action_confirm 可以后续再加。

  async approveApprovalRequest(id: number): Promise<unknown> {
    return this.call('approval.request', 'action_approve', [[id]]);
  }

  async refuseApprovalRequest(id: number): Promise<unknown> {
    return this.call('approval.request', 'action_refuse', [[id]]);
  }

  // ==================== HR 扩展（v1.11） ====================
  //
  // v1.11 新增：请假闭环 / 报销闭环 / 招聘 / 考核 / 工资 / 排班
  //
  // 注意权限边界：
  //   - hr_payroll.* 需要 hr_payroll.group_hr_payroll_user
  //   - hr_recruitment.stage 写操作需要 hr_recruitment.group_hr_recruitment_user
  //   - hr.expense 的 action_approve 之上需要 hr_expense.group_hr_expense_team_approver
  //   - hr.leave 的 action_validate（二次审批）需要 hr_holidays.group_hr_holidays_manager
  //
  // 这里只做 RPC 调用，权限错误由 Odoo 自己抛 → 上层 catch 后返回给用户

  // ---------- 请假类型 / 申请 / 审批 / 额度分配 ----------

  async getLeaveTypes(options: { keyword?: string; limit?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    const result = await this.searchRead('hr.leave.type', domain,
      ['id', 'name', 'requires_allocation', 'leave_validation_type', 'request_unit', 'company_id', 'color'],
      { limit: options.limit ?? 30, order: 'name asc' });
    return result.records;
  }

  async createLeave(values: {
    employee_id?: number;            // 不填默认当前 user 的 employee
    holiday_status_id: number;
    request_date_from: string;       // YYYY-MM-DD
    request_date_to: string;         // YYYY-MM-DD
    name?: string;                   // 请假事由
  }): Promise<number> {
    const payload: Record<string, unknown> = {
      holiday_status_id: values.holiday_status_id,
      request_date_from: values.request_date_from,
      request_date_to: values.request_date_to,
    };
    if (values.employee_id) payload['employee_id'] = values.employee_id;
    if (values.name) payload['name'] = values.name;
    return this.create('hr.leave', payload);
  }

  async approveLeave(id: number): Promise<unknown> {
    // action_approve 自动在 confirm→validate1→validate 状态机里递进
    return this.call('hr.leave', 'action_approve', [[id]]);
  }

  async refuseLeave(id: number): Promise<unknown> {
    return this.call('hr.leave', 'action_refuse', [[id]]);
  }

  async cancelLeave(id: number, reason?: string): Promise<unknown> {
    // hr.leave.action_cancel 在 v17+ 支持 reason 参数；v15/v16 直接 action_cancel
    if (reason) {
      try { return await this.call('hr.leave', 'action_cancel', [[id]], { reason }); }
      catch { /* fallback */ }
    }
    return this.call('hr.leave', 'action_cancel', [[id]]);
  }

  async createLeaveAllocation(values: {
    employee_id: number;
    holiday_status_id: number;
    number_of_days: number;
    name?: string;
    date_from?: string;              // YYYY-MM-DD，默认今天
    auto_approve?: boolean;          // true 时创建后立即调 action_approve
  }): Promise<{ id: number; approved: boolean }> {
    const payload: Record<string, unknown> = {
      employee_id: values.employee_id,
      holiday_status_id: values.holiday_status_id,
      number_of_days: values.number_of_days,
      allocation_type: 'regular',
    };
    if (values.name) payload['name'] = values.name;
    if (values.date_from) payload['date_from'] = values.date_from;
    const id = await this.create('hr.leave.allocation', payload);
    let approved = false;
    if (values.auto_approve) {
      try { await this.call('hr.leave.allocation', 'action_approve', [[id]]); approved = true; }
      catch { /* 权限不足 / 状态不对 → 保留 draft，让用户手动审批 */ }
    }
    return { id, approved };
  }

  // ---------- 报销 ----------

  async getExpenses(options: {
    employee_id?: number;
    state?: string;                  // draft / submitted / approved / posted / paid / refused
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    const result = await this.searchRead('hr.expense', domain,
      ['id', 'name', 'employee_id', 'product_id', 'date', 'total_amount', 'currency_id', 'state', 'payment_state'],
      { limit: options.limit ?? 30, order: 'date desc' });
    return result.records;
  }

  async createExpense(values: {
    name: string;
    product_id?: number;             // 默认 0 时让 Odoo 取默认产品
    employee_id?: number;
    quantity?: number;
    unit_amount?: number;            // 当 product 是按数量计费时
    total_amount?: number;           // 总金额（首选；产品行无单价时直接传）
    date?: string;                   // YYYY-MM-DD，默认今天
    description?: string;
  }): Promise<number> {
    const payload: Record<string, unknown> = {
      name: values.name,
      quantity: values.quantity ?? 1,
    };
    if (values.product_id) payload['product_id'] = values.product_id;
    if (values.employee_id) payload['employee_id'] = values.employee_id;
    if (values.unit_amount !== undefined) payload['unit_amount'] = values.unit_amount;
    if (values.total_amount !== undefined) payload['total_amount'] = values.total_amount;
    if (values.date) payload['date'] = values.date;
    if (values.description) payload['description'] = values.description;
    return this.create('hr.expense', payload);
  }

  async submitExpense(ids: number[]): Promise<unknown> {
    // hr.expense.action_submit 在不同版本叫法不一：v17 是 action_submit_sheet，v18+ 是 action_submit
    try { return await this.call('hr.expense', 'action_submit', [ids]); }
    catch {
      return this.call('hr.expense', 'action_submit_sheet', [ids]);
    }
  }

  async approveExpense(ids: number[]): Promise<unknown> {
    try { return await this.call('hr.expense', 'action_approve', [ids]); }
    catch {
      // 老版本走 sheet
      return this.call('hr.expense', 'action_approve_expense_sheets', [ids]);
    }
  }

  async refuseExpense(ids: number[], reason?: string): Promise<unknown> {
    if (reason) {
      try { return await this.call('hr.expense', 'action_refuse', [ids], { reason }); }
      catch { /* fallback */ }
    }
    try { return await this.call('hr.expense', 'action_refuse', [ids]); }
    catch {
      return this.call('hr.expense', 'action_refuse_expense_sheets', [ids]);
    }
  }

  // ---------- 招聘 ----------

  async getApplicants(options: {
    job_id?: number;
    stage_id?: number;
    keyword?: string;
    only_active?: boolean;
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.only_active !== false) domain.push(['active', '=', true]);
    if (options.job_id) domain.push(['job_id', '=', options.job_id]);
    if (options.stage_id) domain.push(['stage_id', '=', options.stage_id]);
    if (options.keyword) domain.push('|', ['partner_name', 'ilike', options.keyword], ['email_from', 'ilike', options.keyword]);
    const result = await this.searchRead('hr.applicant', domain,
      ['id', 'partner_name', 'email_from', 'job_id', 'stage_id', 'kanban_state', 'priority',
       'user_id', 'date_open', 'date_last_stage_update', 'salary_expected', 'salary_proposed', 'availability'],
      { limit: options.limit ?? 30, order: 'priority desc, date_last_stage_update desc' });
    return result.records;
  }

  async getRecruitmentStages(jobId?: number): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (jobId) domain.push('|', ['job_ids', 'in', [jobId]], ['job_ids', '=', false]);
    const result = await this.searchRead('hr.recruitment.stage', domain,
      ['id', 'name', 'sequence', 'hired_stage', 'fold'],
      { limit: 50, order: 'sequence asc' });
    return result.records;
  }

  async moveApplicantStage(id: number, opts: {
    stage_id?: number;
    kanban_state?: 'normal' | 'done' | 'blocked';
    refuse_reason_id?: number;
  }): Promise<boolean> {
    const values: Record<string, unknown> = {};
    if (opts.stage_id) values['stage_id'] = opts.stage_id;
    if (opts.kanban_state) values['kanban_state'] = opts.kanban_state;
    if (opts.refuse_reason_id) values['refuse_reason_id'] = opts.refuse_reason_id;
    if (Object.keys(values).length === 0) return true;
    return this.write('hr.applicant', [id], values);
  }

  async getApplicantRefuseReasons(): Promise<OdooRecord[]> {
    const result = await this.searchRead('hr.applicant.refuse.reason', [],
      ['id', 'name'], { limit: 30, order: 'name asc' });
    return result.records;
  }

  // ---------- 考核 ----------

  async getAppraisals(options: {
    employee_id?: number;
    state?: '1_new' | '2_pending' | '3_done';
    only_mine?: boolean;             // 我作为 reviewer
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    if (options.only_mine) domain.push(['manager_ids.user_id', '=', this.uid ?? 0]);
    const result = await this.searchRead('hr.appraisal', domain,
      ['id', 'employee_id', 'department_id', 'job_id', 'manager_ids',
       'date_close', 'state', 'next_appraisal_date', 'waiting_feedback'],
      { limit: options.limit ?? 20, order: 'date_close desc' });
    return result.records;
  }

  async appraisalAction(id: number, action: 'confirm' | 'done' | 'back'): Promise<unknown> {
    const methodMap = { confirm: 'action_confirm', done: 'action_done', back: 'action_back' };
    return this.call('hr.appraisal', methodMap[action], [[id]]);
  }

  // ---------- 工资 ----------

  async getPayslips(options: {
    employee_id?: number;
    state?: 'draft' | 'verify' | 'done' | 'paid' | 'cancel';
    payslip_run_id?: number;
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.state) domain.push(['state', '=', options.state]);
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    if (options.payslip_run_id) domain.push(['payslip_run_id', '=', options.payslip_run_id]);
    const result = await this.searchRead('hr.payslip', domain,
      ['id', 'name', 'employee_id', 'date_from', 'date_to', 'state',
       'basic_wage', 'gross_wage', 'net_wage', 'currency_id', 'payslip_run_id', 'paid'],
      { limit: options.limit ?? 20, order: 'date_from desc' });
    return result.records;
  }

  // ---------- 排班 ----------

  async getPlanningShifts(options: {
    employee_id?: number;
    department_id?: number;
    date_from?: string;              // YYYY-MM-DD，默认今天
    date_to?: string;                // YYYY-MM-DD，默认 7 天后
    only_published?: boolean;
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const dFrom = options.date_from ?? today();
    const dTo = options.date_to ?? (() => {
      const d = new Date(); d.setDate(d.getDate() + 7);
      return d.toISOString().substring(0, 10);
    })();
    const domain: Domain = [
      ['start_datetime', '>=', `${dFrom} 00:00:00`],
      ['start_datetime', '<=', `${dTo} 23:59:59`],
    ];
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    if (options.department_id) domain.push(['department_id', '=', options.department_id]);
    if (options.only_published) domain.push(['state', '=', 'published']);
    const result = await this.searchRead('planning.slot', domain,
      ['id', 'employee_id', 'role_id', 'department_id', 'start_datetime', 'end_datetime',
       'allocated_hours', 'state', 'name'],
      { limit: options.limit ?? 50, order: 'start_datetime asc' });
    return result.records;
  }

  // ==================== HR 行动力补完（v1.12） ====================
  //
  // v1.12 把 v1.11 中只读的几个 HR 域升级到完整 action 闭环：
  //   - hr.payslip 工资单生命周期：validate → paid → cancel
  //   - hr.appraisal 考核：confirm → done → back
  //   - hr.recruitment.stage / hr.applicant.refuse.reason：master data 查询
  //   - hr.applicant.action_create_meeting：创建面试日历事件
  //   - planning.slot publish/unpublish：排班发布/取消发布
  // 以及新增三个 HR 域：
  //   - hr.employee.skill / hr.skill[.type|.level]：员工技能管理
  //   - hr.employee.location（hr_homeworking 模块）：远程办公地点
  //   - fleet.vehicle：员工车辆

  // ---------- 工资单生命周期 ----------

  async validatePayslip(ids: number[]): Promise<unknown> {
    // draft → done。需要 hr_payroll.group_hr_payroll_user
    return this.call('hr.payslip', 'action_payslip_done', [ids]);
  }

  async markPayslipPaid(ids: number[]): Promise<unknown> {
    // done → paid。需要 hr_payroll.group_hr_payroll_user
    return this.call('hr.payslip', 'action_payslip_paid', [ids]);
  }

  async cancelPayslip(ids: number[]): Promise<unknown> {
    // any → cancel。需要 hr_payroll.group_hr_payroll_user
    return this.call('hr.payslip', 'action_payslip_cancel', [ids]);
  }

  // ---------- 招聘助手 ----------

  async createApplicantMeeting(applicantId: number, values: {
    name: string;
    start: string;                   // YYYY-MM-DD HH:MM:SS
    duration?: number;               // 小时，默认 1
    description?: string;
  }): Promise<number> {
    // 通过创建 calendar.event 来"约面试"，把 default_applicant_id 填到上下文
    // 比直接调 action_create_meeting（返回 act_window dict）更适合工具化调用
    const app = (await this.read('hr.applicant', [applicantId],
      ['id', 'partner_name', 'partner_id', 'email_from', 'user_id', 'department_id']))[0];
    if (!app) throw new Error(`未找到应聘者 #${applicantId}`);

    // 自动建一个联系人（如果没有）
    let partnerId = Array.isArray(app['partner_id']) ? app['partner_id'][0] as number : null;
    if (!partnerId && app['partner_name']) {
      partnerId = await this.create('res.partner', {
        name: app['partner_name'],
        is_company: false,
        email: app['email_from'] ?? false,
      });
      // 回写到 applicant
      await this.write('hr.applicant', [applicantId], { partner_id: partnerId });
    }

    const partnerIds: number[] = [];
    if (partnerId) partnerIds.push(partnerId);
    const recruiter = Array.isArray(app['user_id']) ? app['user_id'][0] as number : null;
    if (recruiter) {
      const recruiterUser = (await this.read('res.users', [recruiter], ['partner_id']))[0];
      const rPartner = Array.isArray(recruiterUser?.['partner_id']) ? recruiterUser['partner_id'][0] as number : null;
      if (rPartner && !partnerIds.includes(rPartner)) partnerIds.push(rPartner);
    }

    const duration = values.duration ?? 1;
    const startDate = new Date(values.start.replace(' ', 'T') + 'Z');
    const endDate = new Date(startDate.getTime() + duration * 60 * 60 * 1000);
    const stop = endDate.toISOString().substring(0, 19).replace('T', ' ');

    const eventValues: Record<string, unknown> = {
      name: values.name,
      start: values.start,
      stop,
      duration,
      partner_ids: [[6, 0, partnerIds]],
      applicant_id: applicantId,
    };
    if (values.description) eventValues['description'] = values.description;
    return this.create('calendar.event', eventValues);
  }

  // ---------- 排班发布 / 取消发布 ----------

  async publishPlanningShift(ids: number[], notify: boolean = true): Promise<unknown> {
    // 简单地写 state='published'；如需通知员工，逐条调 action_send
    if (notify) {
      // action_send 会按 employee_id 发邮件 + 自动写 state='published'
      const results: unknown[] = [];
      for (const id of ids) {
        try { results.push(await this.call('planning.slot', 'action_send', [[id]])); }
        catch (e) { results.push({ error: String(e), id }); }
      }
      return results;
    }
    return this.write('planning.slot', ids, { state: 'published' });
  }

  async unpublishPlanningShift(ids: number[]): Promise<unknown> {
    // 需要 planning.group_planning_manager
    return this.call('planning.slot', 'action_unpublish', [ids]);
  }

  // ---------- 技能管理 ----------

  async getEmployeeSkills(options: {
    employee_id?: number;
    skill_type_id?: number;
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    if (options.skill_type_id) domain.push(['skill_type_id', '=', options.skill_type_id]);
    const result = await this.searchRead('hr.employee.skill', domain,
      ['id', 'employee_id', 'skill_id', 'skill_type_id', 'skill_level_id', 'level_progress'],
      { limit: options.limit ?? 50, order: 'skill_type_id, skill_id' });
    return result.records;
  }

  async addEmployeeSkill(values: {
    employee_id: number;
    skill_type_id: number;
    skill_id: number;
    skill_level_id: number;
  }): Promise<number> {
    return this.create('hr.employee.skill', {
      employee_id: values.employee_id,
      skill_type_id: values.skill_type_id,
      skill_id: values.skill_id,
      skill_level_id: values.skill_level_id,
    });
  }

  async getSkillsCatalog(options: {
    keyword?: string;
    skill_type_id?: number;
    limit?: number;
  } = {}): Promise<{
    skill_types: OdooRecord[];
    skills: OdooRecord[];
    skill_levels: OdooRecord[];
  }> {
    const skillDomain: Domain = [];
    if (options.skill_type_id) skillDomain.push(['skill_type_id', '=', options.skill_type_id]);
    if (options.keyword) skillDomain.push(['name', 'ilike', options.keyword]);
    const [skillTypes, skills, levels] = await Promise.all([
      this.searchRead('hr.skill.type', [], ['id', 'name'], { limit: 30, order: 'name asc' }),
      this.searchRead('hr.skill', skillDomain, ['id', 'name', 'skill_type_id'],
        { limit: options.limit ?? 50, order: 'skill_type_id, name asc' }),
      this.searchRead('hr.skill.level', [], ['id', 'name', 'level_progress', 'skill_type_id'],
        { limit: 60, order: 'skill_type_id, level_progress asc' }),
    ]);
    return {
      skill_types: skillTypes.records,
      skills: skills.records,
      skill_levels: levels.records,
    };
  }

  // ---------- 远程办公（hr_homeworking） ----------

  async setHomeworking(values: {
    employee_id?: number;            // 不填默认为当前用户的员工
    date: string;                    // YYYY-MM-DD
    work_location_id: number;        // hr.work.location id（办公室/家/其他）
  }): Promise<number> {
    // hr.employee.location 有 unique(employee_id, date) 约束
    // 已存在则更新，没有则创建
    const empId = values.employee_id ?? await this._getCurrentEmployeeId();
    const existing = await this.searchRead('hr.employee.location',
      [['employee_id', '=', empId], ['date', '=', values.date]],
      ['id'], { limit: 1 });
    if (existing.records.length > 0) {
      const id = existing.records[0]?.['id'] as number;
      await this.write('hr.employee.location', [id], { work_location_id: values.work_location_id });
      return id;
    }
    return this.create('hr.employee.location', {
      employee_id: empId,
      date: values.date,
      work_location_id: values.work_location_id,
    });
  }

  private async _getCurrentEmployeeId(): Promise<number> {
    const users = await this.read('res.users', [this.uid ?? 0], ['employee_id']);
    const empField = users[0]?.['employee_id'];
    if (Array.isArray(empField) && typeof empField[0] === 'number') return empField[0];
    throw new Error('当前用户没有关联员工记录（res.users.employee_id 为空）');
  }

  // ---------- 车队 ----------

  async getFleetVehicles(options: {
    driver_user_id?: number;         // 按司机的 res.users id 筛
    employee_id?: number;
    keyword?: string;
    only_active?: boolean;
    limit?: number;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.only_active !== false) domain.push(['active', '=', true]);
    if (options.driver_user_id) {
      // driver_id 是 Many2one('res.partner')，所以要过 res.users.partner_id 联表
      domain.push(['driver_id.user_ids', 'in', [options.driver_user_id]]);
    }
    if (options.keyword) domain.push('|', ['name', 'ilike', options.keyword], ['license_plate', 'ilike', options.keyword]);
    const result = await this.searchRead('fleet.vehicle', domain,
      ['id', 'name', 'license_plate', 'model_id', 'driver_id', 'acquisition_date',
       'odometer', 'odometer_unit', 'state_id', 'company_id'],
      { limit: options.limit ?? 30, order: 'name asc' });
    return result.records;
  }

  // ==================== HR 全生命周期治理（v1.13） ====================
  //
  // v1.13 把 HR 推到「全生命周期 + 数据洞察 + 组织治理」：
  //   - 员工 CRUD：create / update / archive / unarchive（入职 → 改资料 → 离职/返聘）
  //   - HR 仪表盘：一次聚合在编/今日生日/待审请假/待审报销/招聘漏斗/今日请假人
  //   - 部门 / 岗位 / 工作地点：列表 + 创建
  //   - 合同 / 版本：hr.version 列表与历史
  //   - 工时洞察：本月按项目聚合 / 经理查下属工时
  //   - 组织架构：上下级树
  //
  // 数据洞察大量用 read_group（Odoo 原生 group-by + 聚合，比 search_read
  // 自己 reduce 高效得多）。

  // ---------- 通用：read_group helper ----------

  async readGroup(model: string, domain: Domain,
                  fields: string[], groupby: string[],
                  options: { limit?: number; orderby?: string; lazy?: boolean } = {}): Promise<OdooRecord[]> {
    const result = await this.call(model, 'read_group', [domain, fields, groupby], {
      limit: options.limit ?? 100,
      orderby: options.orderby ?? '',
      lazy: options.lazy ?? true,
    });
    return Array.isArray(result) ? result as OdooRecord[] : [];
  }

  // ---------- 员工 CRUD ----------

  async createEmployee(values: {
    name: string;
    work_email?: string;
    work_phone?: string;
    mobile_phone?: string;
    job_title?: string;
    department_id?: number;
    job_id?: number;
    parent_id?: number;            // 上级 hr.employee.id
    coach_id?: number;
    user_id?: number;              // 关联的 res.users.id
    work_location_id?: number;
    company_id?: number;
  }): Promise<number> {
    // hr.employee 的 resource_id 是 required，但 Odoo 在 create 时会按 name 自动建一条 resource.resource
    return this.create('hr.employee', values as Record<string, unknown>);
  }

  async updateEmployee(id: number, values: {
    name?: string;
    work_email?: string;
    work_phone?: string;
    mobile_phone?: string;
    job_title?: string;
    department_id?: number;
    job_id?: number;
    parent_id?: number;
    coach_id?: number;
    user_id?: number;
    work_location_id?: number;
  }): Promise<boolean> {
    return this.write('hr.employee', [id], values as Record<string, unknown>);
  }

  async archiveEmployee(id: number): Promise<boolean> {
    // active 字段 related to resource_id.active；写 active=false 会同时归档 resource
    return this.write('hr.employee', [id], { active: false });
  }

  async unarchiveEmployee(id: number): Promise<boolean> {
    return this.write('hr.employee', [id], { active: true });
  }

  // ---------- HR 仪表盘 ----------

  async getHrDashboard(): Promise<{
    today: string;
    headcount: { total: number; by_department: Record<string, unknown>[] };
    today_birthdays: Record<string, unknown>[];
    today_on_leave: Record<string, unknown>[];
    pending_leaves: number;
    pending_expenses: number;
    recruitment_pipeline: Record<string, unknown>[];
    open_positions: number;
  }> {
    const todayStr = today();
    const [
      totalActive,
      byDept,
      birthdays,
      onLeave,
      pendingLeaves,
      pendingExpenses,
      pipeline,
      openPositions,
    ] = await Promise.all([
      this.searchCount('hr.employee', [['active', '=', true]]),
      // 部门人数分布（read_group）
      this.readGroup('hr.employee',
        [['active', '=', true], ['department_id', '!=', false]],
        ['department_id'], ['department_id'], { limit: 30 }),
      // 今日生日（按 birthday 字段的 month-day 匹配；只有 hr.group_hr_user 才能读 birthday）
      // 退化方案：按 search_read，前端 reduce
      this.searchRead('hr.employee',
        [['active', '=', true]],
        ['id', 'name', 'birthday', 'department_id'],
        { limit: 200 }).then(r => r.records.filter(e => {
          const bd = e['birthday'];
          if (typeof bd !== 'string' || bd.length < 10) return false;
          return bd.substring(5, 10) === todayStr.substring(5, 10);
        })).catch(() => []),  // 没权限读 birthday 时静默返空
      // 今日请假中（state=validate, date_from <= today <= date_to）
      this.searchRead('hr.leave',
        [['state', '=', 'validate'],
         ['date_from', '<=', `${todayStr} 23:59:59`],
         ['date_to', '>=', `${todayStr} 00:00:00`]],
        ['id', 'employee_id', 'holiday_status_id', 'date_from', 'date_to'],
        { limit: 50 }),
      // 待审请假（confirm + validate1）
      this.searchCount('hr.leave', ['|', ['state', '=', 'confirm'], ['state', '=', 'validate1']]),
      // 待审报销（submitted）
      this.searchCount('hr.expense', [['state', '=', 'submitted']]),
      // 招聘漏斗：按 stage 分组
      this.readGroup('hr.applicant',
        [['active', '=', true]],
        ['stage_id'], ['stage_id'], { limit: 20 }).catch(() => []),
      // 招聘中的岗位数
      this.searchCount('hr.job', [['active', '=', true]]),
    ]);
    return {
      today: todayStr,
      headcount: {
        total: totalActive,
        by_department: byDept.map((g: OdooRecord) => ({
          department: g['department_id'],
          count: g['department_id_count'] ?? g['__count'] ?? 0,
        })),
      },
      today_birthdays: (birthdays as OdooRecord[]).map(e => ({
        id: e['id'], name: e['name'], department: e['department_id'],
      })),
      today_on_leave: onLeave.records.map(l => ({
        id: l['id'], employee: l['employee_id'], type: l['holiday_status_id'],
        from: l['date_from'], to: l['date_to'],
      })),
      pending_leaves: pendingLeaves,
      pending_expenses: pendingExpenses,
      recruitment_pipeline: pipeline.map((g: OdooRecord) => ({
        stage: g['stage_id'],
        count: g['stage_id_count'] ?? g['__count'] ?? 0,
      })),
      open_positions: openPositions,
    };
  }

  // ---------- 部门 / 岗位 / 工作地点 ----------

  async getDepartments(options: { keyword?: string; parent_id?: number; limit?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    if (options.parent_id !== undefined) domain.push(['parent_id', '=', options.parent_id || false]);
    const result = await this.searchRead('hr.department', domain,
      ['id', 'name', 'complete_name', 'parent_id', 'manager_id', 'company_id', 'member_ids'],
      { limit: options.limit ?? 100, order: 'complete_name asc' });
    return result.records;
  }

  async createDepartment(values: {
    name: string;
    parent_id?: number;
    manager_id?: number;
    company_id?: number;
  }): Promise<number> {
    return this.create('hr.department', values as Record<string, unknown>);
  }

  async getJobs(options: { department_id?: number; only_active?: boolean; limit?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [];
    if (options.only_active !== false) domain.push(['active', '=', true]);
    if (options.department_id) domain.push(['department_id', '=', options.department_id]);
    const result = await this.searchRead('hr.job', domain,
      ['id', 'name', 'department_id', 'expected_employees', 'company_id', 'sequence'],
      { limit: options.limit ?? 100, order: 'sequence asc, name asc' });
    return result.records;
  }

  async createJob(values: {
    name: string;
    department_id?: number;
    company_id?: number;
    sequence?: number;
  }): Promise<number> {
    return this.create('hr.job', values as Record<string, unknown>);
  }

  async getWorkLocations(options: { keyword?: string; location_type?: string; limit?: number } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [['active', '=', true]];
    if (options.keyword) domain.push(['name', 'ilike', options.keyword]);
    if (options.location_type) domain.push(['location_type', '=', options.location_type]);
    const result = await this.searchRead('hr.work.location', domain,
      ['id', 'name', 'location_type', 'address_id', 'company_id'],
      { limit: options.limit ?? 50, order: 'name asc' });
    return result.records;
  }

  // ---------- 合同 / 版本（hr.version） ----------

  async getEmployeeVersions(employeeId: number, options: { limit?: number } = {}): Promise<OdooRecord[]> {
    // 注意：date_start/date_end/wage 等字段需要 hr.group_hr_user / hr_manager 才能读
    // 没权限时退化只取基本字段
    const fields = ['id', 'name', 'employee_id', 'date_version', 'department_id', 'job_id',
                    'contract_type_id', 'wage', 'company_id', 'active'];
    try {
      const result = await this.searchRead('hr.version',
        [['employee_id', '=', employeeId]],
        fields,
        { limit: options.limit ?? 30, order: 'date_version desc' });
      return result.records;
    } catch {
      // 退化只取基础字段
      const result = await this.searchRead('hr.version',
        [['employee_id', '=', employeeId]],
        ['id', 'name', 'employee_id', 'department_id', 'job_id', 'company_id', 'active'],
        { limit: options.limit ?? 30 });
      return result.records;
    }
  }

  // ---------- 工时洞察 ----------

  async getTimesheetSummary(options: {
    employee_id?: number;            // 不填默认当前用户
    date_from?: string;              // YYYY-MM-DD，默认本月初
    date_to?: string;                // YYYY-MM-DD，默认今天
    group_by?: 'project' | 'task' | 'employee';   // 默认 project
  } = {}): Promise<{
    period: { from: string; to: string };
    total_hours: number;
    groups: Record<string, unknown>[];
  }> {
    const todayStr = today();
    const dFrom = options.date_from ?? todayStr.substring(0, 7) + '-01';
    const dTo = options.date_to ?? todayStr;
    const domain: Domain = [
      ['date', '>=', dFrom],
      ['date', '<=', dTo],
      ['project_id', '!=', false],
    ];
    if (options.employee_id) domain.push(['employee_id', '=', options.employee_id]);
    else domain.push(['employee_id.user_id', '=', this.uid ?? 0]);
    const groupField = options.group_by === 'task' ? 'task_id'
                       : options.group_by === 'employee' ? 'employee_id'
                       : 'project_id';
    const groups = await this.readGroup('account.analytic.line',
      domain, ['unit_amount:sum'], [groupField], { limit: 200 });
    const totalHours = groups.reduce((sum: number, g: OdooRecord) => sum + Number(g['unit_amount'] ?? 0), 0);
    return {
      period: { from: dFrom, to: dTo },
      total_hours: totalHours,
      groups: groups.map((g: OdooRecord) => ({
        [groupField]: g[groupField],
        hours: g['unit_amount'] ?? 0,
        count: g[`${groupField}_count`] ?? g['__count'] ?? 0,
      })),
    };
  }

  async getTeamTimesheets(options: {
    manager_id?: number;             // 默认当前用户对应的 employee.id
    date_from?: string;
    date_to?: string;
    limit?: number;
  } = {}): Promise<Record<string, unknown>[]> {
    const todayStr = today();
    const dFrom = options.date_from ?? todayStr.substring(0, 7) + '-01';
    const dTo = options.date_to ?? todayStr;
    // 找经理对应的 employee
    let managerEmpId = options.manager_id;
    if (!managerEmpId) {
      try {
        const me = await this.read('res.users', [this.uid ?? 0], ['employee_id']);
        if (Array.isArray(me[0]?.['employee_id'])) managerEmpId = me[0]?.['employee_id'][0] as number;
      } catch { /* noop */ }
    }
    if (!managerEmpId) {
      throw new Error('未能确定当前经理 employee_id（res.users.employee_id 为空？）');
    }
    // 查所有 parent_id = managerEmpId 的下属
    const subordinates = await this.searchRead('hr.employee',
      [['parent_id', '=', managerEmpId], ['active', '=', true]],
      ['id', 'name'], { limit: 100 });
    const subIds = subordinates.records.map(e => e['id'] as number);
    if (subIds.length === 0) return [];
    // 查这批人在时间范围内的工时聚合
    const groups = await this.readGroup('account.analytic.line',
      [
        ['employee_id', 'in', subIds],
        ['date', '>=', dFrom],
        ['date', '<=', dTo],
        ['project_id', '!=', false],
      ],
      ['unit_amount:sum'], ['employee_id'], { limit: options.limit ?? 100 });
    // 组装：员工→工时
    const empMap = new Map(subordinates.records.map(e => [e['id'] as number, e['name']]));
    return groups.map((g: OdooRecord) => {
      const empArr = g['employee_id'];
      const empId = Array.isArray(empArr) ? empArr[0] as number : 0;
      return {
        employee: g['employee_id'],
        employee_name: empMap.get(empId),
        hours: g['unit_amount'] ?? 0,
        days_in_period: g['employee_id_count'] ?? g['__count'] ?? 0,
      };
    });
  }

  // ---------- 组织架构（上下级树） ----------

  async getEmployeeOrgChart(employeeId: number): Promise<{
    employee: OdooRecord | null;
    manager: OdooRecord | null;
    coach: OdooRecord | null;
    direct_reports: OdooRecord[];
    skip_level_reports_count: number;
  }> {
    const fields = ['id', 'name', 'job_title', 'department_id', 'parent_id',
                    'coach_id', 'work_email', 'mobile_phone'];
    const me = (await this.read('hr.employee', [employeeId], fields))[0];
    if (!me) return { employee: null, manager: null, coach: null, direct_reports: [], skip_level_reports_count: 0 };
    const managerId = Array.isArray(me['parent_id']) ? me['parent_id'][0] as number : null;
    const coachId = Array.isArray(me['coach_id']) ? me['coach_id'][0] as number : null;
    const [manager, coach, directReports] = await Promise.all([
      managerId ? this.read('hr.employee', [managerId], fields).then(r => r[0] ?? null) : Promise.resolve(null),
      coachId ? this.read('hr.employee', [coachId], fields).then(r => r[0] ?? null) : Promise.resolve(null),
      this.searchRead('hr.employee',
        [['parent_id', '=', employeeId], ['active', '=', true]],
        fields, { limit: 100, order: 'name asc' }),
    ]);
    const directReportIds = directReports.records.map(r => r['id'] as number);
    let skipLevelCount = 0;
    if (directReportIds.length > 0) {
      skipLevelCount = await this.searchCount('hr.employee',
        [['parent_id', 'in', directReportIds], ['active', '=', true]]);
    }
    return {
      employee: me,
      manager: manager ?? null,
      coach: coach ?? null,
      direct_reports: directReports.records,
      skip_level_reports_count: skipLevelCount,
    };
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
