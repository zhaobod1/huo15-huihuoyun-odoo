/**
 * Odoo 插件配置管理器 — v2 (per-agent 隔离)
 *
 * 每个 agent（WeCom 动态 agent 的每个用户/群组）拥有独立的 Odoo 凭据。
 * 存储路径: ~/.openclaw/plugin-configs/odoo/{agentId}.json
 *
 * 向下兼容：如果存在旧的单文件 odoo-config.json，作为 'default' agent 的配置。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OdooPluginConfig, OdooConfig } from '../types/index.js';

const CONFIG_BASE = '.openclaw/plugin-configs/odoo';
const LEGACY_FILE = '.openclaw/plugin-configs/odoo-config.json';

function sanitizeAgentId(agentId: string): string {
  return agentId.replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 128) || 'default';
}

export class ConfigManager {
  private baseDir: string;
  private legacyPath: string;

  constructor(homeDir: string = process.env['HOME'] ?? '/root') {
    this.baseDir = join(homeDir, CONFIG_BASE);
    this.legacyPath = join(homeDir, LEGACY_FILE);
  }

  /** 获取 agent 配置文件路径 */
  private agentPath(agentId: string): string {
    return join(this.baseDir, `${sanitizeAgentId(agentId)}.json`);
  }

  /** 加载指定 agent 的配置（带 legacy 回退） */
  load(agentId: string = 'default'): OdooPluginConfig | null {
    try {
      const path = this.agentPath(agentId);
      if (existsSync(path)) {
        return JSON.parse(readFileSync(path, 'utf-8')) as OdooPluginConfig;
      }
      // legacy 回退：default agent 读旧文件
      if (agentId === 'default' && existsSync(this.legacyPath)) {
        return JSON.parse(readFileSync(this.legacyPath, 'utf-8')) as OdooPluginConfig;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** 保存指定 agent 的完整配置 */
  save(config: OdooPluginConfig, agentId: string = 'default'): boolean {
    try {
      if (!existsSync(this.baseDir)) {
        mkdirSync(this.baseDir, { recursive: true });
      }
      writeFileSync(this.agentPath(agentId), JSON.stringify(config, null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /** 保存 Odoo 连接配置（合并到现有配置） */
  saveOdooConfig(odooConfig: OdooConfig, agentId: string = 'default'): boolean {
    const config = this.load(agentId) ?? {};
    config.odoo = odooConfig;
    return this.save(config, agentId);
  }

  /** 清除指定 agent 的配置 */
  clear(agentId: string = 'default'): boolean {
    try {
      const path = this.agentPath(agentId);
      if (existsSync(path)) unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }

  /** 列出所有已保存配置的 agentId */
  listAgents(): string[] {
    try {
      if (!existsSync(this.baseDir)) return [];
      return readdirSync(this.baseDir)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace(/\.json$/, ''));
    } catch {
      return [];
    }
  }
}
