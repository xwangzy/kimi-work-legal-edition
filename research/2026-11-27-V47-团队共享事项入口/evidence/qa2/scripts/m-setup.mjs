// 成员：注册 → 账号页凭码加入（INVF）
import reg from "./reg.mjs";
import join from "./join.mjs";
export default async (ctx) => { await reg(ctx); process.env.TAG = process.env.TAG2; await join(ctx); };
