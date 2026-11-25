-- 第 66 批（V40）：所选模型真实作用于任务；律师的模型选择按入口记在本机。
--   runs.model     这次任务用的模型别名（云端模型目录里的 id，如 legal/k3、legal/k3-fast）。发起时由内核按目录核过
--                  （在目录中、可用、入口含 task、能力含 tool_use）后写入；助手宿主按它生成引擎配置并发起，追问 / 修改轮 / 重试沿用它，
--                  内核自发的复核也跟随它。NULL = 第 66 批之前的任务（当时一律 legal/k3）。
--   model_prefs    律师在首页（任务）与问答里各自选的模型（只在本机、按律师本人，不同步、不上云）；所选模型之后不可用时
--                  界面回落到缺省模型并说明原因，不静默改用别的模型发出。
ALTER TABLE runs ADD COLUMN model text;
CREATE TABLE model_prefs (
  tenant_id  text NOT NULL,
  user_id    text NOT NULL,
  scope      text NOT NULL CHECK (scope IN ('qa', 'task')),
  model_id   text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (tenant_id, user_id, scope)
);
