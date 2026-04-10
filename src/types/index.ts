/**
 * 火一五·辉火云企业套件插件 — 类型定义
 */

/** Odoo 连接配置 */
export interface OdooConfig {
  url: string;
  db: string;
  username: string;
  password: string;
}

/** Odoo 会话信息 */
export interface OdooSession {
  uid: number;
  session_id: string;
  user_context: Record<string, unknown>;
  company_id: number;
  partner_id: number;
  name: string;
  login: string;
}

/** Odoo API 错误 */
export interface OdooError {
  code: number;
  message: string;
  data?: {
    name: string;
    debug: string;
    message: string;
    arguments: unknown[];
  };
}

/** Odoo 记录（通用） */
export interface OdooRecord {
  id: number;
  [key: string]: unknown;
}

/** 同步更新 — 判别联合，用于 exhaustive switch */
export type SyncUpdate =
  | { type: 'todo';     action: 'create' | 'update' | 'delete'; id: number; data: OdooRecord; timestamp: number }
  | { type: 'activity'; action: 'due';                           id: number; data: OdooRecord; timestamp: number }
  | { type: 'message';  action: 'create';                        id: number; data: OdooRecord; timestamp: number }
  | { type: 'email';    action: 'create';                        id: number; data: OdooRecord; timestamp: number }
  | { type: 'calendar'; action: 'create' | 'update';             id: number; data: OdooRecord; timestamp: number };

/** 意图解析结果 */
export interface IntentResult {
  intent: string;
  confidence: number;
  entities: Record<string, unknown>;
  model?: string;
  method?: string;
}

/** 自定义意图模式 */
export interface IntentPattern {
  pattern: string;
  intent: string;
  model?: string;
  method?: string;
}

/** 插件配置（对应 openclaw.plugin.json configSchema） */
export interface OdooPluginConfig {
  odoo?: OdooConfig;
  sync?: {
    enabled: boolean;
    intervalSeconds: number;
    channels: string[];
  };
}
