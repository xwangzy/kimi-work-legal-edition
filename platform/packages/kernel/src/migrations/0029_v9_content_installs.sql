-- 0029_v9_content_installs.sql — 第 8 批（v9.2 §5.1 S6 法规增量包、S7 方法模板分发）：在线内容更新的本机记录。
-- 法规库与方法模板包自带的版本号由内容摘要派生、不可比较先后——先后只认签名通道清单的 seq；本表是本机的防回退依据（账本加密，改不动）。
-- content_installs：每次装上的内容（类别、通道、seq、版本、内容摘要），active = 当前使用；被通道清单撤回或本机核验失败即标记、不再使用。
-- content_channel_hw：见过的最高通道 seq（云端清单回退到更低 seq 时不采用，防“冻结在旧版本”）。
-- 两表只在本机（不进共享文件夹同步：内容是公开产品内容，各设备各自更新）。

CREATE TABLE content_installs (
  kind text NOT NULL CHECK (kind IN ('lawdb', 'skills')),
  channel text NOT NULL CHECK (channel IN ('stable', 'beta')),
  seq integer NOT NULL CHECK (seq > 0),
  version text NOT NULL,
  content_sha256 text NOT NULL,
  installed_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  active integer NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
  revoked_at text,
  problem text,
  PRIMARY KEY (kind, channel, seq)
);

CREATE TABLE content_channel_hw (
  kind text NOT NULL,
  channel text NOT NULL,
  seq integer NOT NULL,
  updated_at text NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, channel)
);
