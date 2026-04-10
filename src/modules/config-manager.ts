/**
 * Odoo 插件配置管理器
 *
 * 负责 Odoo 连接配置的持久化存储与加载。
 * 当用户通过对话（odoo_connect 工具）提供连接信息时，将配置持久化到本地文件系统，
 * 下次启动时自动恢复连接，无需重新输入凭据。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { OdooPluginConfig, OdooConfig } from '../types/index.js';

const CONFIG_DIR = '.openclaw/plugin-configs';
const CONFIG_FILE = 'odoo-config.json';

export class ConfigManager {
  private configPath: string;

  constructor(homeDir: string = process.env['HOME'] ?? '/root') {
    this.configPath = join(homeDir, CONFIG_DIR, CONFIG_FILE);
  }

  /** 加载持久化配置 */
  load(): OdooPluginConfig | null {
    try {
      if (!existsSync(this.configPath)) {
        return null;
      }
      const data = readFileSync(this.configPath, 'utf-8');
      return JSON.parse(data) as OdooPluginConfig;
    } catch {
      return null;
    }
  }

  /** 持久化保存完整配置 */
  save(config: OdooPluginConfig): boolean {
    try {
      const dir = dirname(this.configPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /** 保存 Odoo 连接配置（合并到现有配置） */
  saveOdooConfig(odooConfig: OdooConfig): boolean {
    const config = this.load() ?? {};
    config.odoo = odooConfig;
    return this.save(config);
  }

  /** 清除持久化配置文件 */
  clear(): boolean {
    try {
      if (existsSync(this.configPath)) {
        unlinkSync(this.configPath);
      }
      return true;
    } catch {
      return false;
    }
  }
}
