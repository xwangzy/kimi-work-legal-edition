-- 第 66 批（V40，D-292）：个人账号新电脑由控制面的“账号设备签发钥”签设备证书（证书 issuer = account_ca）。
-- 本机记下这把签发钥的公钥（随自动登记应答经控制面签名信封送达、按内置控制面公钥验过），本机账本的证书链核对据此接受本机设备的 account_ca 证书；
-- 团队功能（成员日志、团队共享、批准成员、发布策略）仍只认律所根签发的证书，不读这一列。律所根签发的电脑这一列为 NULL。
ALTER TABLE firm_identity ADD COLUMN account_ca_public_key_pem TEXT;
