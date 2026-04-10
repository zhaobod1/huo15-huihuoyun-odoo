/**
 * Odoo JSON-RPC API 客户端
 *
 * 支持 Odoo 19 Enterprise 的 JSON-RPC 接口：
 * - 认证：/web/session/authenticate
 * - 通用：/web/dataset/call_kw (search_read / read / create / write / unlink)
 * - 会话：/web/session/get_session_info / destroy
 *
 * 改进点（相比 dev 版）：
 * - ensureAuthenticated()：轮询前自动检查并重连 session，应对 Odoo 服务重启
 * - getSessionInfo()：暴露 url/username/uid，供 before_prompt_build 钩子读取
 * - getInboxNotifications()：查 mail.notification 未读
 * - getTodayActivities()：专用今日活动查询
 */

import type { OdooConfig, OdooSession, OdooRecord, OdooError } from '../types/index.js';
import { today } from '../utils/date-utils.js';

// Domain 类型
type DomainItem = string | [string, string, unknown];
type Domain = DomainItem[];

/** 类型守卫：检查是否为 Odoo 错误响应 */
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

  /** 认证登录 */
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
    if (!session.uid) {
      throw new Error('认证失败：用户名或密码错误');
    }

    this.uid = session.uid;
    this.session_id = (session as unknown as Record<string, unknown>).session_id as string | null ?? null;
    this.user_context = session.user_context || {};

    return session;
  }

  /** 检查当前会话是否仍然有效 */
  async checkSession(): Promise<boolean> {
    try {
      const result = await this.rpc('/web/session/get_session_info', {});
      const r = result as Record<string, unknown>;
      return 'uid' in r && r['uid'] !== false && r['uid'] !== null;
    } catch {
      return false;
    }
  }

  /**
   * 确保已认证 — 轮询前调用。
   * 如果 session 已过期则自动重新登录。
   */
  async ensureAuthenticated(): Promise<void> {
    if (!this.isAuthenticated() || !(await this.checkSession())) {
      await this.authenticate();
    }
  }

  /** 销毁会话 */
  async destroy(): Promise<void> {
    try {
      await this.rpc('/web/session/destroy', {});
    } finally {
      this.uid = null;
      this.session_id = null;
      this.user_context = {};
    }
  }

  /** 是否已登录 */
  isAuthenticated(): boolean {
    return this.uid !== null;
  }

  /** 获取当前用户 ID */
  getUid(): number | null {
    return this.uid;
  }

  /** 获取会话摘要（用于系统上下文注入） */
  getSessionInfo(): { uid: number | null; username: string; url: string } {
    return { uid: this.uid, username: this.username, url: this.url };
  }

  // ==================== 通用 ORM 方法 ====================

  /** search_read：搜索并返回记录 */
  async searchRead(
    model: string,
    domain: Domain,
    fields: string[] = ['id', 'name'],
    options: { limit?: number; offset?: number; order?: string } = {},
  ): Promise<{ length: number; records: OdooRecord[] }> {
    const { limit = 100, offset = 0, order = '' } = options;

    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'search_read',
      args: [domain],
      kwargs: { fields, domain, limit, offset, order },
    });

    if (isOdooError(result)) {
      throw new Error(`查询 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    const records = Array.isArray(result) ? result as OdooRecord[] : [];
    return { length: records.length, records };
  }

  /** read：读取指定 ID 的字段 */
  async read(model: string, ids: number[], fields: string[] = ['id', 'name']): Promise<OdooRecord[]> {
    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'read',
      args: [ids],
      kwargs: { fields },
    });

    if (isOdooError(result)) {
      throw new Error(`读取 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    return result as OdooRecord[];
  }

  /** create：创建记录，返回新记录 ID */
  async create(model: string, values: Record<string, unknown>): Promise<number> {
    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'create',
      args: [values],
      kwargs: {},
    });

    if (isOdooError(result)) {
      throw new Error(`创建 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    return result as number;
  }

  /** write：更新记录 */
  async write(model: string, ids: number[], values: Record<string, unknown>): Promise<boolean> {
    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'write',
      args: [ids, values],
      kwargs: {},
    });

    if (isOdooError(result)) {
      throw new Error(`更新 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    return result === true;
  }

  /** unlink：删除记录 */
  async unlink(model: string, ids: number[]): Promise<boolean> {
    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'unlink',
      args: [ids],
      kwargs: {},
    });

    if (isOdooError(result)) {
      throw new Error(`删除 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    return result === true;
  }

  /** search_count：统计匹配记录数 */
  async searchCount(model: string, domain: Domain): Promise<number> {
    const result = await this.rpc('/web/dataset/call_kw', {
      model,
      method: 'search_count',
      args: [domain],
      kwargs: {},
    });

    if (isOdooError(result)) {
      throw new Error(`计数 ${model} 失败: ${JSON.stringify(result.error)}`);
    }

    return result as number;
  }

  /** call：调用任意模型方法（通用逃生口） */
  async call(
    model: string,
    method: string,
    args: unknown[] = [],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    const result = await this.rpc('/web/dataset/call_kw', { model, method, args, kwargs });

    if (isOdooError(result)) {
      throw new Error(`调用 ${model}.${method} 失败: ${JSON.stringify(result.error)}`);
    }

    return result;
  }

  // ==================== 业务快捷方法 ====================

  /** 创建待办任务（project.task） */
  async createTask(values: {
    name: string;
    description?: string;
    project_id?: number;
    date_deadline?: string;
    user_ids?: number[];
    priority?: '0' | '1';
  }): Promise<number> {
    return this.create('project.task', {
      name: values.name,
      description: values.description || '',
      project_id: values.project_id || false,
      date_deadline: values.date_deadline || false,
      user_ids: values.user_ids
        ? [[6, false, values.user_ids]]
        : [[6, false, [this.uid ?? 1]]],
      priority: values.priority || '0',
      active: true,
    });
  }

  /** 获取我的待办列表 */
  async getMyTasks(options: {
    limit?: number;
    project_id?: number;
    today_only?: boolean;
  } = {}): Promise<OdooRecord[]> {
    const domain: Domain = [
      ['user_ids', 'in', [this.uid ?? 0]],
      ['active', '=', true],
    ];

    if (options.project_id) {
      domain.push(['project_id', '=', options.project_id]);
    }

    if (options.today_only) {
      domain.push(['date_deadline', '<=', today()]);
    }

    const result = await this.searchRead(
      'project.task',
      domain,
      ['id', 'name', 'description', 'date_deadline', 'stage_id', 'project_id', 'priority', 'user_ids'],
      { limit: options.limit ?? 50 },
    );

    return result.records;
  }

  /** 获取今日及逾期活动（mail.activity） */
  async getTodayActivities(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead(
      'mail.activity',
      [
        ['user_id', '=', this.uid ?? 0],
        ['date_deadline', '<=', today()],
      ],
      ['id', 'summary', 'date_deadline', 'activity_type_id', 'res_model', 'res_id', 'note', 'state'],
      { limit: options.limit ?? 50 },
    );

    return result.records;
  }

  /** 创建活动提醒（mail.activity） */
  async createActivity(values: {
    res_model: string;
    res_id: number;
    activity_type_id: number;
    summary?: string;
    note?: string;
    date_deadline: string;
    user_id?: number;
  }): Promise<number> {
    return this.create('mail.activity', {
      res_model: values.res_model,
      res_id: values.res_id,
      activity_type_id: values.activity_type_id,
      summary: values.summary || '',
      note: values.note || '',
      date_deadline: values.date_deadline,
      user_id: values.user_id ?? this.uid ?? 1,
    });
  }

  /** 创建日历事件（calendar.event） */
  async createCalendarEvent(values: {
    name: string;
    start: string;
    stop: string;
    description?: string;
    partner_ids?: number[];
    alarm_ids?: number[];
  }): Promise<number> {
    return this.create('calendar.event', {
      name: values.name,
      start: values.start,
      stop: values.stop,
      description: values.description || '',
      partner_ids: values.partner_ids
        ? [[6, false, values.partner_ids]]
        : [[6, false, [this.uid ?? 1]]],
      alarm_ids: values.alarm_ids ? [[6, false, values.alarm_ids]] : false,
    });
  }

  /** 获取未读消息（mail.message） */
  async getUnreadMessages(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead(
      'mail.message',
      [
        ['message_type', '!=', 'notification'],
        ['to_read', '=', true],
      ],
      ['id', 'body', 'date', 'author_id', 'model', 'res_id', 'subject'],
      { limit: options.limit ?? 20 },
    );

    return result.records;
  }

  /** 获取未读收件箱通知（mail.notification） */
  async getInboxNotifications(options: { limit?: number } = {}): Promise<OdooRecord[]> {
    const result = await this.searchRead(
      'mail.notification',
      [
        ['is_read', '=', false],
        ['notification_type', '=', 'inbox'],
      ],
      ['id', 'mail_message_id', 'notification_status', 'is_read', 'read_date'],
      { limit: options.limit ?? 20 },
    );

    return result.records;
  }

  // ==================== 私有传输层 ====================

  private async rpc(endpoint: string, params: Record<string, unknown>): Promise<unknown> {
    const url = `${this.url}${endpoint}`;

    const payload = {
      jsonrpc: '2.0',
      method: 'call',
      id: Date.now(),
      params,
    };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.session_id) {
      headers['Cookie'] = `session_id=${this.session_id}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const data = await response.json() as { result?: unknown; error?: OdooError };

    if (data.error) {
      return { error: data.error };
    }

    return data.result;
  }
}
