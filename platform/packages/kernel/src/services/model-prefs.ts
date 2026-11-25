/**
 * 律师本人的模型选择（第 66 批，V40）：首页（任务）与问答各记一份，只在本机、按律师本人（表 model_prefs，迁移 0073），不同步、不上云。
 * 存的是别名；用的时候再按云端目录核一次（之后被停用、套餐撤掉的，界面回落到缺省并说明原因）。
 */
import type { KernelDb } from "../db.ts";
import type { ModelScope } from "./model-catalog.ts";

export function selectedModelOf(db: KernelDb, tenantId: string, userId: string, scope: ModelScope): string | null {
  try {
    return db.get<{ model_id: string }>(`SELECT model_id FROM model_prefs WHERE tenant_id = ? AND user_id = ? AND scope = ?`, [tenantId, userId, scope])?.model_id ?? null;
  } catch {
    return null; // 旧库还没有这张表（迁移前）：当没选过
  }
}

export function saveModelPref(db: KernelDb, tenantId: string, userId: string, scope: ModelScope, modelId: string): void {
  db.run(
    `INSERT INTO model_prefs (tenant_id, user_id, scope, model_id, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (tenant_id, user_id, scope) DO UPDATE SET model_id = excluded.model_id, updated_at = excluded.updated_at`,
    [tenantId, userId, scope, modelId, new Date().toISOString()],
  );
}
