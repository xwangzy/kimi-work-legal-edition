/**
 * 自然人姓名识别（第 02 篇 §8.3：“自然人姓名的识别靠当事人词典 + 实体识别，漏识别的姓名仍会出站，L3a 事项须人工核对词典”）。
 *
 * G0 实现（规则，不依赖模型）：
 * 1. 当事人词典与事项令牌表中已有的自然人姓名：全文精确匹配（长者优先）；
 * 2. 角色词之后的姓名：原告/被告/申请人/甲方/法定代表人/委托代理人/证人/联系人/户名……（可跳过冒号与括注）+ 姓氏 + 1–2 字；
 * 3. 称谓之前的姓名：……先生/女士/律师/法官/经理……；
 * 4. 本段识别出的姓名在全文再匹配一遍（同一份材料里无上下文的出现也替换）。
 * 覆盖扩展（审计 P1-3，2026-10-13）：
 * 5. 音译名（含“·”及其变体“•‧・･∙⋅”与全角句点）：角色词之后，或其后紧跟称谓/言语动词时识别；词典命中照常（分隔符不计）；
 * 6. 拉丁字母姓名（“John Smith”“Zhang San”，2–4 个首字母大写或全大写的词）：**只在角色词之后**识别，含机构词（Inc/Ltd/Group……）的不算；
 * 8. 表头写法（姓名后紧跟性别、身份证号或联系电话说明，见 headerNames）。
 * 7. 昵称与职务称呼（老王、小李、王总、李工、张律、刘董、陈经理、赵主任……）：**只在该姓氏属于已知自然人**（词典、令牌表、本段识别）时识别，
 *    作为独立的值获得代号；称呼取称呼表中的最长匹配（“王总经理”整体识别），其后若紧跟会改变词义的字（“王总监”“王总是”“李工程”）则整段不识别。
 * 偏向召回：误把普通词替换为代号只影响可读性（界面与交付件会还原），漏识别则姓名出站——漏识别率在合成测试集上如实报告。
 */
import { surnameAt } from "./surnames.ts";
import { shapeFold, softenSingleBreaks, VariantMatcher } from "./variants.ts";
import type { Hit } from "./patterns.ts";

const CJK = /[一-龥]/;

/** 不会出现在“名”位置的功能字、动词与常见后接字（宁可截短：截短的姓名仍会被识别为姓名并替换）。 */
const STOP = new Set([
  ..."诉称于与和及等的在向将已系为是因对同把被所曾自从经由以之签共均都也又还就并即则但而或认主提要请不未没应可能会说表承确拒支付借欠归交收出购买卖租住现户身男女年月日族名某方人辩述作起上下中内外前后时处至到去来给让叫每各该此其他她它们这那有无非合字盖章代委托申执行判决裁调解协议书证据材料院庭审案件号元万亿省市区县镇乡村路街楼室栋公司厂店行",
]);

/**
 * STOP 中常作名字用字的字（“张明月”“王建中”“李方”“王羲之”）：只在姓名有明确的右边界时才允许出现在名字里——
 * 角色词后的姓名紧跟标点、空白或文末，或称谓、言语动词、身份信息之前的姓名。否则按 STOP 截短会漏出名字的末字（S8 进所评测发现）。
 * 不含助词与后缀（等、的、某、们、人……）：“张三等，”仍取“张三”。
 */
// 复核 S6A-04：去掉“均、至、日、方”——“施工方”“甲方”“于近日”“均”这类功能写法太常见，宁可让“张晓方”的“方”照旧截短
// V13 第 38 批：加“行”（景行、知行、慎行；“申请人：方景行，男”原先截成“方景”，劳动案员工姓名送给模型成了“〔自然人〕行”）
const NAME_OK = new Set([..."月年中之承元万章栋镇路庭书申行"]);
/** 名字（1–2 字）：都是汉字；STOP 字只允许作两字名的末字且须在 NAME_OK 内（单字名“王月”与“官方”“许可”难以区分，宁可不认）。 */
const GIVEN_NOT = new Set([
  "双方", "各方", "对方", "我方", "他方", "己方", "一方", "三方", "多方", "四方", "八方", "本月", "当月", "次月", "每月", "当日", "次日", "本年", "当年", "次年",
]);
/** 角色与身份词不是名字（“由律师确认”“向股东转让”“董事和监事”；v9.4 第 25 批：方法正文与内核说明里的误认）。 */
const ROLE_GIVEN = new Set(["律师", "法官", "股东", "董事", "监事", "员工", "职工", "一项"]);
/**
 * 不会出现在名字里的字（与 STOP 不同：不论边界都不放宽）：虚词、疑问词与法律文书常见动词的用字
 * （“遇到时告知律师”“上诉范围须律师确认”“正文只写律师告知的”“内容待律师判断”“以哪一份为准时问律师”“合并成一项说明”）。
 * v9.4 第 25 批：方法正文与内核说明随每个任务发出，这些误认会把“任务”“修订”一类词换成自然人代号。
 */
// 复核 Q7-04：“项”“监”作名字用字（王项明、王监军），不放进来——“合并成一项”“董事和监事”由 GIVEN_NOT、ROLE_GIVEN、常见词挡
const NOT_GIVEN = new Set([..."且须只取写待按问询告哪些赔偿者"]);
/**
 * STOP 里的介词、连词（V13 第 38 批）：句法上必须带宾语，不会直接落在标点或文末之前——“法定代表人钱季同。”的“同”只能是名字末字。
 * 原先按 STOP 截成“钱季”，送给模型的是“〔自然人·…〕同。”，起草的协议首部把客户法定代表人写成“钱季”（V10 V15 评分律师：首页第一段必须改）。
 * 只在两字名末字、且右边紧跟标点、空白、文末或言语类动词时放宽（称谓作右边界不放宽：“张三同律师一起”）。
 */
const NAME_END_BEFORE_PUNCT = new Set([..."同和与及向对把被将从由以跟给为"]);
const givenOk = (given: string, loose = true, punct = false) => {
  if (GIVEN_NOT.has(given) || ROLE_GIVEN.has(given)) return false;
  const cs = [...given];
  // loose = 右边界是标点、文末、称谓或身份信息；言语动词与出庭类动词作右边界时不放宽（“李四方辩称”不能读成“李四方”）
  return (
    cs.length >= 1 &&
    cs.every((c, i) => CJK.test(c) && !NOT_GIVEN.has(c) && (!STOP.has(c) || (loose && i === 1 && cs.length === 2 && (NAME_OK.has(c) || (punct && NAME_END_BEFORE_PUNCT.has(c))))))
  );
};

/**
 * 强证据下的名字（V14 第 39 批）：函件与纪要表头冒号之后、括注职务之前，“周以宁”“叶书禾”这类名字里的“以”“书”在 STOP 里，
 * givenOk 不收。强证据下放宽为：都是汉字、不含 NOT_GIVEN、不是“双方”“律师”一类词，STOP 字至多一个。
 */
const strongGivenOk = (given: string) => {
  if (GIVEN_NOT.has(given) || ROLE_GIVEN.has(given)) return false;
  const cs = [...given];
  return cs.length >= 1 && cs.length <= 2 && cs.every((c) => CJK.test(c) && !NOT_GIVEN.has(c)) && cs.filter((c) => STOP.has(c)).length <= (cs.length === 2 ? 1 : 0);
};

/**
 * 常见名字用字（中档依据须至少含一个）：列举、名词并列与技术文字里“姓氏字 + 普通字”的组合（成果、解析、边界）由此排除。
 * 二次检测（candidates.ts）用它定中档置信度；规则识别的言语动词分支（只有“后面跟言语动词”这一条弱证据）也要求至少含一个（V13 第 38 批）。
 * 用字罕见的姓名在强证据（角色词、称谓、表头与身份信息、当事人名单）下照常认出。
 */
export const GIVEN_CHARS = new Set([
  ..."伟芳娜敏静丽强磊军洋勇艳杰娟涛明超秀霞平刚桂英华玉萍红鹏辉玲建国文斌宇浩凯健俊帆帅旭宁龙林欢阳佳晨婷雪琳晶颖倩蕾",
  ..."梅琴兰凤莉燕丹荣慧峰波亮飞彬鑫毅彤蓉薇菲璐瑶怡欣悦妍婕媛嫣娇嘉琪琦瑾瑜璇琼珊珍珠贞淑贤惠洁澜涵润泽",
  ..."海江河川山岩松柏桐楠榕梓杨柳枫桦森炎焱煜烨灿炜晖曦昊旻晟晓昕暄春夏秋冬晴虹霖霏露霜雯震雷云星辰",
  ..."东南正义仁礼智信忠孝德诚志远航腾达功胜福禄寿喜贵富康泰祥瑞吉庆乐怀思恩爱诗琴",
  ..."彪豪雄伦博学士元亨昌盛兴旺隆顺玮琛璋琰琨瑛璟珺珂玥瑗钰铭锦锋钧鸿鹤鹰麟骏驰骁",
  ..."永长青新晗笛竹筠菁芝芸芷茜茹荷莎莹萌蔚蓓蕊艺苒若萱紫翠碧",
  ..."娥婉婧婵姗姝姣姿威妮妤娅娴雅美俏可如意宏洪弘鸿童潼瞳",
  ..."立力利励俐礼亮良凌灵铃岭",
  // V13 第 38 批：言语动词分支也用这张表后补的常见名字用字（召回用例“据曹雨回忆”“聂雨证实”；历次材料“林岚表示”“周叙白称”一类）。
  // 不收“然、白、子、心、安”这类易与前一字组成常用词的字（“当然表示”“明白称”）
  ..."雨岚卓昀屹宸轩睿哲梦熙锐舒逸蕙沁叙",
]);
/** 姓名之前若是这些字，优先取较短的候选（“和王明律师”取“王明”而不是“和王明”）。 */
const FUNCTION_BEFORE = new Set([..."和与及同跟给向对由被把让请找叫是为因从在将等的了及或并而且就也都还又经据按向至到即"]);

/**
 * 也是姓氏的连词、介词与情态词（V13 第 38 批真实走查 W6）：只凭“后面跟言语动词”或“紧跟在角色词后”这类弱证据时不当姓氏读。
 * 起草的技术服务合同第 12.4 条“……，应事先说明依据”认出“应事先”、起草说明“由财务确认发票类型”认出“由财务”，学进事项令牌表后，
 * 第 10.4 条“乙方应事先在附件五中披露”送给模型成了“乙方〔自然人〕在附件五中披露”；独立复核据此报“文字残缺”，最终答复让律师删去“事先”。
 * 历次 828 份真实材料与成果里，这类字作姓氏的识别结果约 70 个不同值（和期限、和完成、应聘、应事先、和财务、向贵、由指定……），
 * 没有一个是真名（“向德隆确认”“由锦漪委派”的德隆、锦漪是公司字号）。真名照常由强证据认出：角色词后有冒号或空白（“证人：应晓明，”）、
 * 称谓（“向东律师”）、身份信息（“由志强，男”）、当事人名单。不含“于”：于是常见姓氏，误认少（“于当”1 次）。
 */
const FUNCTION_SURNAMES = new Set([..."和与及同跟由应向将从以为把被让给在经据按对"]);
/**
 * 角色词后不带分隔直接接这些字，是连词、介词（“负责人和期限”“财务负责人由锦漪委派”“员工和家属”），不是姓氏。
 * 不含“应”（另有合同角色规则）、“于”“向”（常见姓氏，第 29 批用例锁定“被告向乙明于 2025 年 3 月借款”照常认出）。
 */
const CONJ_AFTER_ROLE = new Set([..."和与及同跟或由对把被将从以为给让"]);
/** 诉讼文书的当事人角色词：裁判文书惯于不加标点直接接姓名（“原告和联辉于 2025 年 3 月签约”，第 29 批用例），上一条不适用。 */
const LITIGATION_ROLES = new Set(["再审申请人", "被申请人", "申请执行人", "被执行人", "申请人", "被上诉人", "上诉人", "原审原告", "原审被告", "原审第三人", "第三人", "原告", "被告人", "被告", "被申诉人", "申诉人", "起诉人", "反诉原告", "反诉被告", "犯罪嫌疑人", "被害人", "受害人", "证人"]);

/** 角色词（之后跟姓名）。 */
const ROLE_CUES = [
  "再审申请人", "被申请人", "申请执行人", "被执行人", "申请人", "被上诉人", "上诉人", "原审原告", "原审被告", "原审第三人", "第三人",
  "原告", "被告人", "被告", "被申诉人", "申诉人", "起诉人", "反诉原告", "反诉被告", "犯罪嫌疑人", "被害人", "受害人", "死者",
  "甲方", "乙方", "丙方", "丁方", "出借人", "借款人", "贷款人", "担保人", "保证人", "抵押人", "出质人", "质押人", "债权人", "债务人",
  "法定代表人", "负责人", "授权代表", "委托代理人", "诉讼代理人", "法定代理人", "代理人", "委托人", "受托人", "监护人", "被监护人",
  "证人", "鉴定人", "当事人", "联系人", "收款人", "付款人", "收件人", "寄件人", "户名", "开户名", "姓名", "户主", "持卡人", "开户人",
  "买受人", "出卖人", "买方", "卖方", "出租人", "承租人", "转让方", "受让方", "转让人", "受让人", "发包人", "承包人", "劳动者", "员工",
  "职工", "配偶", "丈夫", "妻子", "之夫", "之妻", "父亲", "母亲", "儿子", "女儿", "之子", "之女", "继承人", "被继承人", "股东", "董事", "监事",
  "总经理", "经理", "董事长", "签字人", "签署人", "经办人", "投保人", "被保险人", "受益人", "介绍人", "见证人", "担任", "签名",
];

/**
 * 往来函件与会议纪要的表头（V14 第 39 批真实走查 A：客户邮件“发件人：钟启衡（……董事长）”“抄送：周以宁（……销售总监）”、
 * 会谈纪要“檀屿参会：周以宁（销售总监）、韩策（财务经理）、顾言（质量负责人）”“记录：周以宁”里的 5 个自然人一个都没认出，
 * 以真名发给了模型）。这些词也常作普通动词（“记录显示”“主持召开”），只在后面紧跟冒号或空白时读姓名。
 */
const HEADER_LABELS = new Set([
  "发件人", "发信人", "抄送", "抄送人", "密送", "记录人", "记录", "整理人", "参会人员", "参会人", "参会", "与会人员", "出席人员", "出席", "列席人员", "列席",
  "主持人", "主持", "审核人", "审批人", "批准人", "报告人", "汇报人", "对接人", "承办人", "联络人", "接待人", "送达人", "签收人", "拟稿人", "核稿人", "访谈对象", "受访人", "访谈人",
]);
ROLE_CUES.push(...HEADER_LABELS);

/** 合同当事人代称：其后须有冒号、空白或括注才读姓名（第 35 批）。 */
const PARTY_LABELS = new Set(["甲方", "乙方", "丙方", "丁方", "买方", "卖方", "转让方", "受让方"]);
/** 合同当事人的角色词：其后直接接的“应”是“应当”（第 35 批）。 */
const CONTRACT_ROLES = new Set(["甲方", "乙方", "丙方", "丁方", "出借人", "借款人", "贷款人", "担保人", "保证人", "抵押人", "出质人", "质押人", "债权人", "债务人", "买受人", "出卖人", "买方", "卖方", "出租人", "承租人", "转让方", "受让方", "转让人", "受让人", "发包人", "承包人", "劳动者", "员工", "职工", "股东", "董事", "监事", "投保人", "被保险人", "受益人", "委托人", "受托人"]);

/** 称谓（之前跟姓名）：只用强指向个人的称谓；“经理”“主任”之类前面常是部门词，改在角色词里处理（“总经理王某”）。 */
const HONORIFICS = ["先生", "女士", "小姐", "夫人", "律师", "法官", "检察官", "书记员", "审判员", "审判长", "人民陪审员", "老师", "医生", "同志"];

/** 以姓氏字开头的常见词：不是姓名（“项目经理”“公司法务”）。 */
const COMMON_WORDS = new Set([
  // 第 35 批真实走查 R3：合同、劳动文书里紧跟在“员工、劳动者、出租人”等角色词后的常用词（首字恰好是姓氏）；“劳动”误登记成人名后，“劳动合同法”“劳动争议”全被换成代号
  "劳动", "劳务", "劳资", "计算", "付款", "车间", "利息", "利润", "余款", "林木", "许诺", "计划", "计费", "谈妥", "白天", "白班", "毛利", "罗列", "夏季",
  "任职", "程度", "成员", "成果", "季节", "康复", "卫生", "齐全", "齐备", "储存", "储备", "申报", "晋升", "易耗", "甘愿", "万一", "万分", "安置", "安保",
  "苗木", "封存", "甄别", "时限", "时点", "包装", "包干", "宁愿",
  "项目", "公司", "公民", "公众", "公开", "公告", "公证", "公平", "公安", "公章", "公务", "区域", "国家", "国际", "国内", "国有", "全国", "全部",
  "全体", "全额", "时间", "时候", "时效", "文件", "文书", "文字", "安全", "安排", "安装", "明确", "明细", "平台", "平等", "原告", "原审",
  "原件", "原因", "原则", "信息", "信用", "信托", "由于", "云端", "来源", "南方", "和解", "和谐", "成立", "成本", "成交", "高级", "高等",
  "金额", "金融", "黄金", "石油", "方式", "方面", "方案", "方法", "关于", "关系", "关联", "华东", "华北", "江苏", "江西", "海关", "海南",
  "海外", "管理", "管辖", "程序", "苏州", "武汉", "温州", "宁波", "常州", "余额", "万元", "钱款", "车辆", "车位", "房屋", "房产", "房租",
  "邮政", "邮箱", "包括", "包含", "应当", "应该", "商品", "商业", "商标", "商事", "普通", "宣传", "宣告", "相关", "相应", "初步", "门店",
  "门市", "容易", "来往", "尚未", "上述", "以上", "司法", "司机", "史上", "龙头", "牛市", "熊市", "钟点", "谷歌", "阿里", "百度", "华为",
  "苗圃", "蓝色", "黄色", "白色", "红色", "金色", "常务", "常规", "常年", "简易", "简称", "简单", "左右", "左侧", "师范", "师资", "季度",
  "单位", "单独", "单方", "单价", "盛世", "曲线", "路径", "路面", "游戏", "邓氏", "冷库", "席位", "党委", "党支部", "宫殿", "费用", "卜卦",
  "银行", "海运", "江河", "林地", "田地", "马路", "高度", "温度", "方向", "金属", "石头", "黄色", "龙头", "华人", "周边", "周末", "周年",
  "周期", "周转", "孙子", "孟子", "孔子", "庄子", "韩国", "秦朝", "宋朝", "唐朝", "明朝", "清朝", "汉族", "满族", "蒙古", "鲁迅", "苏联",
  // 法律文书与方法正文里的常用词（v9.4 第 25 批：“律师的任务说明”“股东权利”“劳动者主张”“出租人解除权”“章程另有规定”曾被认成姓名）
  // 只收方法正文与内核说明里实际误认过的（复核 Q7-04：多收会挡掉以它们作名字的真名，如“李劳动律师”）
  "任务", "修改", "修订", "文稿", "关键", "单列", "文风", "解除", "权利", "权属", "权益", "公示", "高管", "董监", "章程", "原样", "迟延",
  "封闭", "容忍",
  // V10 真实走查 V4：客户说明“商场说这是标准文本”把“商场”学成人名，合同第 5.4 条“根据商场整体经营需要”送给模型成了“根据〔自然人〕整体经营需要”；
  // 同类以姓氏字开头、常作“说 / 称 / 表示”主语的经营场所与租赁、车辆纠纷常用词一并收
  "商场", "商铺", "商户", "商家", "商城", "商圈", "商超", "房东", "房主", "房客", "车主",
  // 第 34 批真实走查（增资协议）：“结果令甲方满意”“创始股东连带地”“全球范围内”“杭州清禾天使投资合伙企业”被认成姓名学进事项令牌表，
  // 助手读到的尽调先决条件成了“结果令甲方〔自然人〕”。以姓氏字开头的城市名一并收（“杭州”“郑州”“成都”“沈阳”……）
  "满意", "连带", "范围", "杭州", "郑州", "成都", "沈阳", "徐州", "金华", "兰州", "江门", "惠州", "吉林", "唐山", "秦皇",
  // V13 第 38 批：个人信息合规材料“员工、应聘者及家属”认出“应聘”（历次材料 10 次）
  "应聘",
]);

/**
 * 角色词后直接接、没有明确边界时，这些词是动词或副词的开头，不是姓名（第 27 批真实模型走查：合同里“卖方严重违约”“买方严格按照”
 * “乙方全面履行”“承租人连续两个月”被读成“角色词 + 姓名”，模型收到“卖方〔自然人〕约”，违约门槛词丢了；490 句合同式短句里误认 70 句）。
 * 复核 Q8-01：只在“没有明确边界”的那一支用——有标点、称谓、言语动词等强证据时（“原告：严重阳，男”“证人严格律师”）照常认出。
 */
// 第 34 批：增资协议里“结果令甲方满意”“创始股东连带地”被读成“角色词 + 姓名”；补合同里角色词后常跟的副词与动词
const ROLE_FOLLOW_WORDS = new Set(["严重", "严格", "全面", "连续", "任何", "满意", "连带", "单方", "书面", "足额", "按期", "按时", "逾期", "擅自", "优先", "先行", "另行", "分别"]);
/**
 * 角色词后直接接、没有明确边界时，以这些短语开头的不是姓名（第 29 批真实模型走查：股权转让协议“甲方应缴纳的个人所得税”
 * “总经理，任期三年”被读成姓名，模型收到“甲方〔自然人〕的个人所得税”“〔自然人〕年”，以为条款文字缺失）。
 * 同一批审查任务里，助手自己写的意见经出站令牌化时又认出“应全额、应负责、应依法、任何、向乙、由双、付款义、付清全、任职期、时生效”，
 * 这些值进了事项令牌表后，合同原文里的“任何一方”“向乙方支付”在定位视图里被换成代号，5 张风险卡因此定位不到。
 * 按短语收（“应保国”“付清华”这类真名不受影响），同样只用在没有明确边界的那一支。
 */
const ROLE_FOLLOW_PHRASES =
  /^(?:应(?:缴纳|缴付|保证|遵守|遵循|全额|负责|依法|及时|立即|支付|承担|赔偿|返还|退还|确保|促使|协助|配合|提供|履行)|任期(?:届满|内|为|自|[一二三四五六七八九十两\d]+年)|任职期间|[向由](?:甲|乙|丙|双|对|一)方|[和与及](?:实际|联系)|付款义务|付清(?:全部|全款|余款|货款|价款|欠款|款项)|时生效)/;

/** 角色词后紧跟这些，说明是机构（“被告北京……有限公司”）。 */
const ORG_TAIL = /^[一-龥A-Za-z0-9（）()]{0,16}?(?:有限责任公司|股份有限公司|有限公司|公司|集团|事务所|银行|支行|分行|医院|学校|大学|学院|研究院|研究所|委员会|政府|法院|检察院|公安局|派出所|中心|合作社|工作室|商行|商店|超市|酒店|宾馆|饭店|门市部|经营部|厂|店)/;

/** 言语与行为动词（之前常是姓名：“据王某回忆”“李某证实”）；只在候选前是句首、标点或功能字时采用。 */
const SPEECH_VERBS = ["辩称", "诉称", "述称", "声称", "表示", "回忆", "陈述", "证实", "证明", "承认", "否认", "认为", "签署", "签字", "签名", "收到", "出具", "确认", "主张", "介绍", "反映", "告知", "要求", "借款", "还款", "转账", "汇款", "入职", "离职", "出生", "驾驶", "称", "说"];
const SPEECH_RE = new RegExp(`(?:${SPEECH_VERBS.join("|")})`, "g");
const BOUNDARY = /[\s，。；：、“”"‘’（）()！？!?,.;:\u3000]/;

const ROLE_RE = new RegExp(`(?:${ROLE_CUES.sort((a, b) => b.length - a.length).join("|")})(?:[一二三四五六七八九十]|\\d{1,2})?`, "g");
const HONORIFIC_RE = new RegExp(`(?:${HONORIFICS.sort((a, b) => b.length - a.length).join("|")})`, "g");
/**
 * 介词、连词后面紧跟角色词或“对方 / 双方”：是“向原告支付”“由甲方承担”“和被告协商”，不是姓名“向原”“由甲”
 * （第 29 批真实模型走查：起诉状里的“被告向原告支付”认出“向原”，学进事项令牌表后，材料里的“向原告”都被换成代号）。只用在没有明确边界的那一支。
 */
// V13 第 38 批：“申请人向贵院申请”“申请人向仲裁委员会申请仲裁”认出“向贵”“向仲”（历次材料 7 次）——介词后接受理机构
const ROLE_AFTER_FUNCTION = new RegExp(`^(?:${ROLE_CUES.join("|")}|[对双各一我他本]方|第三方|守约方|违约方|原审|原单位|原地址|贵(?:院|方|司|所|会|行|公司)|仲裁|人民法院|法院)`);
/** “对方、双方、甲方……”里的“方”是名词，不是姓氏（第 29 批：“微信中对方亦确认”认出“方亦”）。 */
// 第 35 批：“转让方违反陈述与保证”“出租方迟延”“守约方依法”“发包方通过”里的“方”同样是名词（真实走查 R1、R2 的事项令牌表里登记了“方违反”“方迟延”“方依法”“方通过”）
const PARTY_FANG_BEFORE = new Set([..."对双各一我他本甲乙丙丁买卖让租约包托资供需务可作"]);

/** 姓名之后常见的字（动词、介词、助词）：姓名后紧跟它们，说明姓名到此为止。 */
const NAME_DELIM = new Set([..."在于与和及等的向将已系为是因对同把被所曾自从经由以诉称签共均都也又还就并即则但而或认说表承确拒支付借欠归交收出购买卖租住现男女年月日作提要请不未没应可能会"]);

// ── 音译名（含“·”）──────────────────────────────────────────────

/** 音译名的分隔点（识别在 foldWidth 视图上进行：全角句点已折成“.”）。 */
const DOT_CLASS = "[·•‧・･∙⋅⸱᛫.\u0387]";
const DOTTED_AT = new RegExp(`^[一-龥]{1,8}(?:${DOT_CLASS}[一-龥]{1,8}){1,3}`);
const DOTTED_RUN = new RegExp(`[一-龥]+(?:${DOT_CLASS}[一-龥]+){1,3}`, "g");
const DOT_SPLIT = new RegExp(DOT_CLASS);
/** 音译名最后一段在这些词或字处截断（“买买提诉称”→“买买提”）；不含音译常用字（提、买、尔、都、不……）。 */
const DOTTED_CUT_WORDS = ["出庭", "到庭", "作证", "陈述", ...SPEECH_VERBS, ...HONORIFICS].sort((a, b) => b.length - a.length);
const DOTTED_CUT_CHARS = new Set([..."向于在与和及等的为系是已将对被把从自同因就也均诉辩签称说男女现住"]);
const ORG_WORD_IN = /(?:有限责任公司|股份有限公司|有限公司|公司|集团|事务所|银行|支行|分行|医院|学校|大学|学院|研究院|研究所|委员会|政府|法院|检察院|公安局|派出所|中心|合作社|工作室|商行|商店|超市|酒店|宾馆|饭店|门市部|经营部)/;
const ORG_AFTER = /^(?:律师|会计师)?(?:事务所|有限|股份|公司|集团|银行|医院|学校|大学|学院|研究|中心|基金|合伙|工作室|商行|酒店)/;

/** 音译名不用的字：以间隔号分隔的清单（“涉及·不涉及·待确认”“材料载明·推论·待确认”“出庭·补充反证·调查取证”）不是音译名（v9.4 第 25 批）。 */
// 复核 Q7-01：“不、理、查、由、提……”是维吾尔族名与西文音译名的常用字（阿不都热依木、理查德、查尔斯），不能放进来；只收音译名不用的字
const NOT_TRANSLIT = new Set([..."及涉料载论待区间补反证庭调具"]);

function cutDottedTail(last: string): string {
  for (let p = 1; p < last.length; p++) {
    if (DOTTED_CUT_CHARS.has(last[p]!)) return last.slice(0, p);
    if (DOTTED_CUT_WORDS.some((w) => last.startsWith(w, p))) return last.slice(0, p);
  }
  return last;
}

/** 从 j 起读一个音译名（角色词之后用）；不是返回 null。 */
function readDottedAt(text: string, j: number): string | null {
  const m = DOTTED_AT.exec(text.slice(j, j + 64));
  if (!m) return null;
  return finishDotted(text, j, m[0]);
}

/** 截断最后一段、排除机构名；返回姓名或 null。 */
function finishDotted(text: string, start: number, raw: string): string | null {
  const segs = raw.split(DOT_SPLIT);
  const full = segs[segs.length - 1]!;
  const last = cutDottedTail(full);
  if (last.length === 0) return null;
  // 最后一段没有在动词、称谓处截断，而其后还连着汉字（被 8 字上限截断，如“史密斯贸易有限公司”）：不是姓名
  if (last === full && CJK.test(text[start + raw.length] ?? "")) return null;
  const name = raw.slice(0, raw.length - segs[segs.length - 1]!.length) + last;
  if (name.length > 24 || ORG_WORD_IN.test(name) || ORG_AFTER.test(text.slice(start + name.length))) return null;
  if ([...name].some((c) => NOT_TRANSLIT.has(c))) return null;
  return name;
}

/** 无角色词锚定的音译名：其后紧跟称谓或言语动词时识别；第一段从句首、标点或功能字之后起算。 */
function dottedByContext(text: string, out: Set<string>): void {
  DOTTED_RUN.lastIndex = 0;
  for (const m of text.matchAll(DOTTED_RUN)) {
    const raw = m[0];
    const segs = raw.split(DOT_SPLIT);
    let first = segs[0]!;
    let start = m.index!;
    // 第一段内含角色词（“证人约翰·史密斯先生”）：从角色词之后起算（取最长的角色词前缀）
    for (let p = first.length - 1; p >= 1; p--) {
      if (ROLE_END_RE.test(first.slice(0, p))) {
        start += p;
        first = first.slice(p);
        break;
      }
    }
    // 去掉前导功能字（“据约翰·史密斯回忆”）
    while (first.length > 2 && FUNCTION_BEFORE.has(first[0]!)) {
      first = first.slice(1);
      start += 1;
    }
    if (first.length > 4) {
      // 第一段过长：取最后一个功能字之后的部分（“庭审中据约翰”→“约翰”）；没有功能字就放弃（宁可漏识别）
      let k = -1;
      for (let i = first.length - 2; i >= 1; i--) if (FUNCTION_BEFORE.has(first[i]!)) { k = i; break; }
      if (k < 0) continue;
      start += k + 1;
      first = first.slice(k + 1);
    }
    const name = finishDotted(text, start, first + raw.slice(segs[0]!.length));
    if (!name) continue;
    const after = text.slice(start + name.length);
    if (HONORIFICS.some((h) => after.startsWith(h)) || SPEECH_VERBS.some((v) => after.startsWith(v))) out.add(name);
  }
}

// ── 拉丁字母姓名（只在角色词之后）──────────────────────────────────

const LATIN_WORD = "(?:[A-Z][a-z]+(?:-[A-Z][a-z]+)?|[A-Z]'[A-Z][a-z]+|[A-Z]{2,}(?:-[A-Z]{2,})?|[A-Z]\\.)";
const LATIN_NAME_AT = new RegExp(`^${LATIN_WORD}(?: ${LATIN_WORD}){1,3}(?![A-Za-z])`);
const LATIN_ORG_WORDS = new Set(
  (
    "inc ltd llc llp lp plc gmbh ag sa nv bv pte corp corporation co company companies limited group holding holdings bank trust fund capital " +
    "partners partnership law firm office department committee court government school college university institute hospital center centre " +
    "association foundation studio store shop hotel restaurant club team agency service services technology technologies tech trading " +
    "international industries industry enterprise enterprises investment investments management consulting systems solutions media logistics " +
    "pharma pharmaceutical labs lab network networks software electronics motors airlines insurance securities branch china asia pacific global " +
    "the and of for party seller buyer lessor lessee plaintiff defendant appellant appellee applicant respondent " +
    "name full first last given family date birth address phone tel mobile email gender sex nationality passport number no signature sign " +
    "title position contact account"
  ).split(" "),
);

function readLatinAt(text: string, j: number): string | null {
  const m = LATIN_NAME_AT.exec(text.slice(j, j + 80));
  if (!m) return null;
  const name = m[0].replace(/\s+$/, "");
  const words = name.split(" ");
  if (words.some((w) => LATIN_ORG_WORDS.has(w.replace(/\.$/, "").toLowerCase()))) return null;
  // 紧随其后的词是机构词（“John Smith Ltd.”）
  const next = /^[\s,]*([A-Za-z]+)/.exec(text.slice(j + name.length, j + name.length + 24))?.[1];
  if (next && LATIN_ORG_WORDS.has(next.toLowerCase())) return null;
  // 全是单字母缩写不算
  if (words.every((w) => /^[A-Z]\.?$/.test(w))) return null;
  return name;
}

// ── 昵称与职务称呼 ───────────────────────────────────────────────

/** 称呼表（最长匹配优先）。“总监”不在表中：“王总监”不识别，也不会被截成“王总”。 */
const TITLES = [
  "副总经理", "总经理", "副董事长", "董事长", "副总裁", "总裁", "副总", "经理", "主任", "局长", "处长", "科长", "厂长", "行长", "院长",
  "所长", "部长", "校长", "书记", "队长", "主管", "老师", "师傅", "总", "董", "工", "律", "姐", "哥",
].sort((a, b) => b.length - a.length);
/** 称呼之后允许紧跟的字（动词、介词、助词的首字）；“是/会/则/之/共/计/监/裁/经/程/师”等会改变词义的字不在其中。 */
const NICK_FOLLOW = new Set([..."说称表在和与跟及等让给已也都又还就对向于为被把从提要请不没认签打找来去告问讲答回介吗呢啊吧了的曾当亲本所再确承拒负主参通核审查看知希建指强坚否陈补借欠交付购租住同带"]);
/** 单字称呼与“老/小 + 姓”前面允许的字（句首、标点之外）：功能字与“联系/致电/拜访/通知……”的尾字。 */
const NICK_LEFT = new Set([...FUNCTION_BEFORE, ..."系电访见约陪称说告知诉问"]);
/** 形似昵称的常用词（“小区”“小于”“小时”“法律”“员工”“古董”“空姐”……）。 */
const NICK_EXCLUDE = new Set([
  "老师", "老庄", "小区", "小于", "小时", "小白", "小康", "小米", "小麦", "小车", "小童", "小孔", "小商", "小程", "小龙", "小牛", "小毛",
  "法律", "纪律", "规律", "定律", "旋律", "韵律", "格律", "戒律", "一律", "自律", "金律", "音律", "刑律",
  "员工", "职工", "人工", "加工", "施工", "化工", "电工", "木工", "车工", "农工", "劳工", "民工", "技工", "分工", "开工", "停工", "完工", "竣工",
  "复工", "用工", "务工", "打工", "怠工", "罢工", "美工", "手工", "义工", "童工", "女工", "包工", "监工", "军工", "石工", "金工", "钳工", "焊工",
  "瓦工", "漆工", "矿工", "船工", "帮工", "散工", "零工", "长工", "短工", "雇工", "招工", "做工", "上工", "下工", "收工", "赶工", "旷工",
  "汇总", "古董", "校董", "副董", "执董", "空姐", "表姐", "堂姐", "师姐", "学姐", "大姐", "阿姐", "大哥", "表哥", "堂哥", "师哥", "学哥", "帅哥",
  "阿哥", "老哥", "八哥", "高工",
]);
const ROLE_END_RE = new RegExp(`(?:${ROLE_CUES.join("|")})(?:[一二三四五六七八九十]|\\d{1,2})?[\\s：:，,、]*$`);

function leftOk(text: string, i: number, roleOk: boolean): boolean {
  if (i === 0) return true;
  const c = text[i - 1]!;
  if (BOUNDARY.test(c) || c === "〕" || !CJK.test(c) || NICK_LEFT.has(c)) return !/[0-9A-Za-z]/.test(c);
  return roleOk && ROLE_END_RE.test(text.slice(Math.max(0, i - 12), i));
}

function rightOk(text: string, e: number): boolean {
  const c = text[e];
  if (c === undefined) return true;
  if (/[0-9A-Za-z]/.test(c)) return false;
  return !CJK.test(c) || NICK_FOLLOW.has(c);
}

/** 昵称形态（“老王”“小欧阳”“王总”“陈经理”）的姓氏；不是昵称形态返回 null。 */
export function nicknameSurname(value: string): string | null {
  const v = value.trim();
  if (NICK_EXCLUDE.has(v)) return null;
  if ((v[0] === "老" || v[0] === "小") && v.length >= 2) {
    const s = surnameAt(v, 1);
    if (s > 0 && v.length === 1 + s) return v.slice(1);
  }
  const s = surnameAt(v, 0);
  if (s > 0 && TITLES.includes(v.slice(s))) return v.slice(0, s);
  return null;
}

/** 中文姓名的姓氏（须有 1–3 字的名；音译名、拉丁字母姓名返回 null）。 */
export function surnameOf(value: string): string | null {
  const v = value.trim();
  if (!/^[一-龥]{2,5}$/.test(v)) return null;
  const s = surnameAt(v, 0);
  return s > 0 && v.length > s ? v.slice(0, s) : null;
}

/**
 * 昵称与职务称呼的位置（只认 `surnames` 中的姓氏）。规则：
 * - “老/小 + 姓”：前面是句首、标点、功能字（和、跟、请、找、联系……）；后面是标点或动词、介词、助词；
 * - “姓 + 称呼”：称呼取最长匹配（“王总经理”整体）；单字称呼（总/董/工/律/姐/哥）前面的要求同上（角色词之后也可）；
 * - 后面紧跟会改变词义的字（“王总监”“王总是”“李工程”）或数字、字母：整段不识别；形似昵称的常用词（小区、小时、法律、员工……）不识别。
 */
export function findNicknames(
  text: string,
  surnames: ReadonlySet<string>,
  /** 已作为自然人识别过的昵称写法（本段上下文识别或令牌表）：姓氏不在 `surnames` 中也按同一边界规则识别这个写法本身。 */
  allowed: ReadonlySet<string> = new Set(),
): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  if (surnames.size === 0 && allowed.size === 0) return out;
  const allowedSurnames = new Set([...allowed].map((v) => nicknameSurname(v)).filter((x): x is string => x !== null));
  const known = (i: number): number => {
    const s = surnameAt(text, i);
    const has = (x: string) => surnames.has(x) || allowedSurnames.has(x);
    if (s === 2 && has(text.slice(i, i + 2))) return 2;
    if (s >= 1 && has(text[i]!)) return 1;
    return 0;
  };
  const ok = (v: string, surname: string): boolean => surnames.has(surname) || allowed.has(v);
  for (let i = 0; i < text.length; ) {
    const c = text[i]!;
    // 老王 / 小李
    if ((c === "老" || c === "小") && leftOk(text, i, false)) {
      const s = known(i + 1);
      if (s > 0) {
        const v = text.slice(i, i + 1 + s);
        if (ok(v, v.slice(1)) && !NICK_EXCLUDE.has(v) && rightOk(text, i + 1 + s)) {
          out.push({ start: i, end: i + 1 + s, value: v });
          i += 1 + s;
          continue;
        }
      }
    }
    // 王总 / 陈经理 / 王总经理
    const s = known(i);
    if (s > 0) {
      const title = TITLES.find((t) => text.startsWith(t, i + s));
      if (title) {
        const v = text.slice(i, i + s + title.length);
        const single = title.length === 1;
        // 已识别过的这个写法本身（allowed）不再要求左边界：它已在某处有过自然人上下文；右边界与常用词排除照旧（“王总监”仍不识别）
        if (ok(v, text.slice(i, i + s)) && !NICK_EXCLUDE.has(v) && (!single || allowed.has(v) || leftOk(text, i, true)) && rightOk(text, i + s + title.length)) {
          out.push({ start: i, end: i + s + title.length, value: v });
          i += s + title.length;
          continue;
        }
      }
    }
    i += 1;
  }
  return out;
}

/** 姓名的明确右边界（除标点、空白、文末外）：言语动词、称谓、出庭类动词。 */
const RIGHT_ANCHORS = [...SPEECH_VERBS, ...HONORIFICS, "出庭", "到庭", "作证"].sort((a, b) => b.length - a.length);

/** 从 j 起读一个姓名：姓氏 + 1–2 个名字；不是姓名返回 null。 */
function readName(text: string, j: number, strong = false): string | null {
  const s = surnameAt(text, j);
  if (s === 0) return null;
  if (COMMON_WORDS.has(text.slice(j, j + 2))) return null;
  // 有明确右边界（标点、空白、文末）：名字可含常作名字用字的功能字（“原告：张明月，”）
  for (const g of [2, 1]) {
    const given = text.slice(j + s, j + s + g);
    const at = j + s + g;
    const after = text[at] ?? "";
    const hard = after === "" || BOUNDARY.test(after) || HONORIFICS.some((w) => text.startsWith(w, at));
    const anchored = hard || RIGHT_ANCHORS.some((w) => text.startsWith(w, at));
    // 介词、连词作名字末字（NAME_END_BEFORE_PUNCT）：右边是标点或文末，或直接是言语、出庭类动词（“钱季同签字”——“同”后没有宾语，不是介词）；称谓不算
    const verbAfter = RIGHT_ANCHORS.some((w) => !HONORIFICS.includes(w) && text.startsWith(w, at));
    const prepOk = after === "" || BOUNDARY.test(after) || verbAfter;
    if (given.length !== g || !anchored || !(givenOk(given, hard || (prepOk && NAME_END_BEFORE_PUNCT.has(given[1] ?? "")), prepOk) || (strong && hard && strongGivenOk(given)))) continue;
    // “姓氏”其实是前一个词的功能字（“向双方，”）：不认
    if (s === 1 && FUNCTION_BEFORE.has(text[j]!) && surnameAt(text, j + 1) > 0) continue;
    // 列明退役的误认值即使有边界也不认（第 29 批：“到达甲方时生效，”）
    if (!stillLooksLikeName(text.slice(j, j + s + g))) continue;
    return text.slice(j, j + s + g);
  }
  if (ROLE_FOLLOW_WORDS.has(text.slice(j, j + 2)) || ROLE_FOLLOW_PHRASES.test(text.slice(j, j + 8))) return null;
  if (s === 1 && FUNCTION_BEFORE.has(text[j]!) && ROLE_AFTER_FUNCTION.test(text.slice(j + 1, j + 9))) return null;
  const g1 = text[j + s];
  const g2 = text[j + s + 1];
  if (!g1 || !CJK.test(g1) || STOP.has(g1) || NOT_GIVEN.has(g1) || (g2 && ROLE_GIVEN.has(g1 + g2))) return null;
  let len = s + 1;
  if (g2 && CJK.test(g2) && !STOP.has(g2) && !NOT_GIVEN.has(g2)) len = s + 2;
  const next = text[j + len] ?? "";
  // 姓名后紧跟标点或常见动词、介词：姓名到此为止；否则可能是机构名的开头（“张家港市……有限公司”）
  if (next !== "" && CJK.test(next) && !NAME_DELIM.has(next) && ORG_TAIL.test(text.slice(j))) return null;
  return text.slice(j, j + len);
}

/** 跳过角色词后的冒号、空白与括注（“原告（反诉被告）：张三”）。 */
function skipSeparators(text: string, i: number): number {
  let k = i;
  for (let guard = 0; guard < 4; guard++) {
    while (k < text.length && /[\s：:，,、]/.test(text[k]!)) k++;
    if (text[k] === "（" || text[k] === "(") {
      const close = text.slice(k, k + 16).search(/[）)]/);
      if (close > 0) {
        k += close + 1;
        continue;
      }
    }
    break;
  }
  return k;
}

/**
 * 8. 表头写法（v9.2 R7；二次检测发现的高置信写法并入规则，直接替换）：姓名后紧跟性别或身份、联系方式说明——
 * “王明，男，汉族”“王明（女，1985 年生）”“王明，身份证号……”“王明，电话……”。只认起点在句首、标点、空白或功能字之后的候选
 * （“其中李明，男”这种起点不清的不认，宁可交给二次检测提示）。
 */
const HEADER_CUE = /[，,（(]\s?(?:[男女](?=[，,。；;、）)]|$)|身份证号?|公民身份号码|身份证件号码|联系电话|手机号?|电话)/g;
function headerNames(text: string, out: Set<string>): void {
  HEADER_CUE.lastIndex = 0;
  for (const m of text.matchAll(HEADER_CUE)) {
    const k = m.index!;
    for (const len of [4, 3, 2]) {
      const j = k - len;
      if (j < 0) continue;
      const before = j === 0 ? "" : text[j - 1]!;
      if (before !== "" && !BOUNDARY.test(before) && !FUNCTION_BEFORE.has(before)) continue;
      const s = surnameAt(text, j);
      if (s === 0 || len - s < 1 || len - s > 2) continue;
      if (s === 1 && FUNCTION_BEFORE.has(text[j]!) && surnameAt(text, j + 1) > 0) continue;
      const given = text.slice(j + s, k);
      if (!givenOk(given)) continue;
      if (COMMON_WORDS.has(text.slice(j, j + 2))) continue;
      out.add(text.slice(j, k));
      break;
    }
  }
}

/** 以角色词或表头词开头（顿号列举到下一个角色时停下，由角色词那一支处理）。 */
const ROLE_START = new RegExp(`^(?:${ROLE_CUES.slice().sort((a, b) => b.length - a.length).join("|")})`);

/**
 * 顿号列举（V14 第 39 批）：角色词或表头词后的姓名之后，跳过括注（职务、性别），遇“、”继续读下一个姓名——
 * “参会：周以宁（销售总监）、韩策（财务经理）、顾言（质量负责人）”“被告：张三、李四”。下一段以角色词开头的停下。
 */
function listNames(text: string, at: number, out: Set<string>, strong = false): void {
  let k = at;
  for (let n = 0; n < 12; n++) {
    if (text[k] === "（" || text[k] === "(") {
      const close = text.slice(k, k + 40).search(/[）)]/);
      if (close < 0) return;
      k += close + 1;
    }
    if (text[k] !== "、") return;
    if (ROLE_START.test(text.slice(k + 1))) return;
    const next = readName(text, k + 1, strong);
    if (!next) return;
    out.add(next);
    k += 1 + next.length;
  }
}

/**
 * 姓名后紧跟括注职务（V14 第 39 批）：“钟启衡（苏州檀屿医疗器械有限公司 董事长）”“韩策（财务经理）”。
 * 括注以职务词收尾才算；候选前须是句首、标点、空白或功能字，候选不以部门、机构用字收尾（“董事会（董事长……）”）。
 */
const TITLE_PAREN_CUE =
  /[（(][^（）()\n]{0,24}?(?:副?董事长|副?总经理|副?总裁|总监|经理|负责人|主管|专员|助理|主任|秘书|会计|出纳|法务|工程师|厂长|部长|处长|科长|院长|行长|店长|组长|队长|董事|监事|实际控制人|法定代表人|联系人|业务员|销售代表|驻场代表)[^（）()\n]{0,6}[）)]/g;
const NOT_NAME_TAIL = new Set([..."会部处科司厂院局组室所行队方"]);
function titleParenNames(text: string, out: Set<string>): void {
  TITLE_PAREN_CUE.lastIndex = 0;
  for (const m of text.matchAll(TITLE_PAREN_CUE)) {
    const k = m.index!;
    for (const len of [4, 3, 2]) {
      const j = k - len;
      if (j < 0) continue;
      const before = j === 0 ? "" : text[j - 1]!;
      if (before !== "" && !BOUNDARY.test(before) && !FUNCTION_BEFORE.has(before)) continue;
      const s = surnameAt(text, j);
      if (s === 0 || len - s < 1 || len - s > 2) continue;
      if (s === 1 && FUNCTION_BEFORE.has(text[j]!) && surnameAt(text, j + 1) > 0) continue;
      const given = text.slice(j + s, k);
      if (!(givenOk(given) || strongGivenOk(given)) || NOT_NAME_TAIL.has(given.at(-1) ?? "")) continue;
      if (COMMON_WORDS.has(text.slice(j, j + 2))) continue;
      out.add(text.slice(j, k));
      break;
    }
  }
}

/**
 * 规则早先认出、已存进事项令牌表的值，还算不算已知姓名（v9.4 第 25 批）：旧规则把内核说明与方法正文里的“任务”“权利”“时告知”一类认成过姓名，
 * 这些条目留在表里（旧成果里的代号照常还原），但不再当作已知姓名去匹配新文字。
 * 复核 Q7-01：只退役列明的误认值，不按规则泛化判断——泛化会让以前认出的真名（音译名、含这些字的名字）此后明文发出。
 */
const KNOWN_MISREADS = new Set([
  "任务", "修改", "修订", "文稿", "关键", "单列", "文风", "解除", "解除权", "权利", "权属", "权益", "公示", "高管", "董监高", "章程另", "原样使", "迟延受",
  "封闭式", "容忍简", "劳动者", "明且", "时告知", "范围须", "由只取", "项只取", "文只写", "成一项", "时问", "时询问", "容待", "由律师", "师按", "明须",
  "向律师", "向股东", "向股", "和监事", "应赔偿", "查哪些", "都写了", "涉及·不涉及·待", "材料载明·推论·待", "工具结果·区间·待", "出庭·补充反证·调查取证",
  // 第 35 批真实走查：此前登记进事项令牌表的误认（“转让方违反陈述”“违约方迟延”“股东向第三方”“转让方向受让方”）。
  // “应进”这类“应＋一字”可能是真名（“联系人：应进，”），不列入——已误登记的由律师在当事人名单里删除
  "方迟延", "方依法", "方通过", "方违反", "方转", "向第三", "向受",
  // 第 27 批真实模型走查：合同正文里的误认（“不承担任何间接损失”“卖方严重违约”等）
  // “严格”是两字值，可能是以前认对的真名（“被告：严格，女”），不退役（复核 Q8-02）
  "何间接", "严重违", "严重迟", "全面履", "连续两",
  // 第 29 批真实模型走查：股权转让协议里的误认（“甲方应缴纳的个人所得税”“任期三年”“监事任期届满”）
  "应缴纳", "任期三", "任期届", "应遵守",
  "应全额", "应负责", "应依法", "任何", "任何披", "向乙", "由双", "付款义", "付清全", "任职期", "时生效",
  // 同一形态（“乙方向甲方”“由对方承担”）：旧规则在其他事项里学进令牌表的同类值一并退役（货款纠纷事项里“向甲”仍在替换合同原文）
  "向甲", "向丙", "向双", "向对", "向一", "由甲", "由乙", "由丙", "由对", "由一",
  // 第 29 批复测：货款纠纷事项令牌表里旧规则学进的值（“被告向原告支付”“甲方向乙方采购”“对方亦确认”“法定代表人和联系方式”
  // “和实际”“双方确认的封样”，以及把句点当间隔号读出的一段）仍在替换合同原文
  "向原", "方采", "方亦", "和联", "和实", "封样", "元.保全费未发生不",
  // V13 第 38 批（W6 真实走查与历次 828 份材料复扫）：此前规则学进事项令牌表的连词、情态字开头的误认
  "应事先", "由财务", "和期限", "和完成", "和家属", "和财务", "和依赖", "和管辖", "和整改", "和候选", "和关联", "向贵", "向仲", "应法域", "和责任", "由指定", "由独立",
]);
export function stillLooksLikeName(value: string): boolean {
  // 整条值就是常用词的（“劳动”“付款”，第 35 批）同样退役：此前误登记进事项令牌表的条目在规则修正后不再替换
  return !KNOWN_MISREADS.has(value) && !COMMON_WORDS.has(value);
}

/** 规则识别出的候选姓名（去重；不含位置）。 */
export function recognizeNames(text: string): Set<string> {
  const out = new Set<string>();
  ROLE_RE.lastIndex = 0;
  for (const m of text.matchAll(ROLE_RE)) {
    // “担任”其实是“承担”的后一字加下一词的首字（“不承担任何间接损失”）：不是角色词（第 27 批真实模型走查：
    // “何间接”被认成姓名，模型收到“不承担任〔自然人·1〕损失”，一条责任限制条款被改坏）
    if (m[0].startsWith("担任") && text[m.index! - 1] === "承") continue;
    const j = skipSeparators(text, m.index! + m[0].length);
    // 角色词后直接接“应”（中间没有冒号、空白、括注）是“应当”，不是姓“应”（第 35 批真实走查 R2：“甲方应进行验收”送给模型的是
    // “甲方〔自然人〕行验收”，审查意见据此误判“表述不完整”；短语表逐个补不完——表外 852 个常见“××方应＋动词”组合里 456 个被认成姓名）。
    // 只对合同当事人角色词这样处理：诉讼文书里“被告应晓明于 2025 年 3 月借款”没有标点也是姓名（第 29 批用例），有分隔的“甲方：应保国，”照常识别
    if (j === m.index! + m[0].length && text[j] === "应" && CONTRACT_ROLES.has(m[0])) continue;
    // 合同当事人代称（甲方、乙方、买方……）后没有分隔就直接接的两个字，是合同用语不是姓名（第 35 批真实走查 R3：竞业限制协议
    // “标准为乙方劳动合同解除或终止前……”把“劳动”登记成人名，此后材料与检索词里的“劳动合同法”“劳动争议”都被换成代号；
    // 同法造句，“乙方付款、乙方计算、乙方利息、乙方时限”等 330 组被误认）。代称后的真名在合同里写作“乙方：张三”“乙方（劳动者）：张三”，照常识别
    if (j === m.index! + m[0].length && PARTY_LABELS.has(m[0])) continue;
    // 非诉讼角色词后直接接连词、介词（V13 第 38 批）：“负责人和期限”“财务负责人由锦漪委派”“员工和家属”不是姓名
    if (j === m.index! + m[0].length && CONJ_AFTER_ROLE.has(text[j] ?? "") && !LITIGATION_ROLES.has(m[0])) continue;
    // 音译名与拉丁字母姓名优先（否则“阿卜杜拉·买买提”会被截成“阿卜杜”）
    const special = readDottedAt(text, j) ?? readLatinAt(text, j);
    if (special) {
      out.add(special);
      continue;
    }
    // 函件与纪要表头只在冒号或空白之后读姓名（“记录显示”“主持召开”不是）
    if (HEADER_LABELS.has(m[0].replace(/[一二三四五六七八九十\d]+$/, "")) && !/[：:\s]/.test(text[m.index! + m[0].length] ?? "")) continue;
    const strong = HEADER_LABELS.has(m[0].replace(/[一二三四五六七八九十\d]+$/, ""));
    // “当事人一方明确表示”（民法典第五百六十三条）：角色词后的“一”被当成序号（“证人一”），“方明”被认成姓名，学进事项令牌表后
    // 法条原文成了“当事人一〔自然人〕确表示”，助手起草的“卖方明知”在回读里也被换成代号、改不掉（V14 第 39 批真实走查 A）。
    // “一方、双方、对方……”里的“方”不作姓氏读，与称谓分支同一口径
    if (text[j] === "方" && PARTY_FANG_BEFORE.has(text[j - 1] ?? "")) continue;
    const name = readName(text, j, strong);
    if (name) {
      out.add(name);
      listNames(text, j + name.length, out, strong);
    }
  }
  dottedByContext(text, out);
  headerNames(text, out);
  titleParenNames(text, out);
  HONORIFIC_RE.lastIndex = 0;
  for (const m of text.matchAll(HONORIFIC_RE)) {
    const k = m.index!;
    // 候选：姓氏 + 2 字 / 姓氏 + 1 字（复姓各加 1）
    const tries: string[] = [];
    for (const len of [4, 3, 2]) {
      const j = k - len;
      if (j < 0) continue;
      const s = surnameAt(text, j);
      if (s === 0 || len - s < 1 || len - s > 2) continue;
      const given = text.slice(j + s, k);
      if (!givenOk(given)) continue;
      if (COMMON_WORDS.has(text.slice(j, j + 2)) || COMMON_WORDS.has(text.slice(j + 1, j + 3))) continue;
      // 较长候选的“姓氏”若其实是前一个词的功能字（“和王明律师”的“和”），放弃较长候选
      if (s === 1 && FUNCTION_BEFORE.has(text[j]!) && surnameAt(text, j + 1) > 0) continue;
      if (text[j] === "方" && PARTY_FANG_BEFORE.has(text[j - 1] ?? "")) continue;
      // 连词、情态字其实是前一个词的末字或词中连词（“向相应法域律师”“上传人和责任律师”）：前面紧挨着普通汉字时不认（V13 第 38 批）
      if (s === 1 && FUNCTION_SURNAMES.has(text[j]!) && j > 0 && CJK.test(text[j - 1]!) && !FUNCTION_BEFORE.has(text[j - 1]!)) continue;
      // “麻烦沈律师”（V14 第 39 批真实走查 A）：称谓前一个字本身是姓（“沈律师”是称呼），名字部分又没有常见名字用字——是“麻烦”+“沈律师”，不是三字名
      if (s === 1 && given.length === 2 && surnameAt(text, k - 1) > 0 && ![...given].some((c) => GIVEN_CHARS.has(c))) continue;
      tries.push(text.slice(j, k));
    }
    if (tries.length > 0) out.add(tries[0]!);
  }
  SPEECH_RE.lastIndex = 0;
  for (const m of text.matchAll(SPEECH_RE)) {
    const k = m.index!;
    for (const len of [4, 3, 2]) {
      const j = k - len;
      if (j < 0) continue;
      const before = j === 0 ? "" : text[j - 1]!;
      if (before !== "" && !BOUNDARY.test(before) && !FUNCTION_BEFORE.has(before)) continue;
      const s = surnameAt(text, j);
      if (s === 0 || len - s < 1 || len - s > 2) continue;
      if (FUNCTION_BEFORE.has(text[j]!) && surnameAt(text, j + 1) > 0 && s === 1) continue;
      // 言语动词前的“应事先（说明）”“由财务（确认）”“向贵方（确认）”：姓氏位置是连词、介词或情态词，只有这一条弱证据时不认（V13 第 38 批）
      if (s === 1 && FUNCTION_SURNAMES.has(text[j]!)) continue;
      if (text[j] === "方" && PARTY_FANG_BEFORE.has(before)) continue;
      const given = text.slice(j + s, k);
      if (!givenOk(given, false)) continue;
      if (COMMON_WORDS.has(text.slice(j, j + 2))) continue;
      // 只有“后面跟言语动词”这一条弱证据：名字须含常见名字用字（V13 第 38 批 W4：“现有证据支持主张”认出“支持”，
      // 学进事项令牌表后意见书里的“裁判支持数额”“能否同时支持”全被换成自然人代号；历次材料里还有“区分×31、权限×22、利益×20、危险×19”）
      // 称呼形态（“王总表示”“李工称”）是昵称，照常认出
      if (!TITLES.includes(given) && ![...given].some((c) => GIVEN_CHARS.has(c))) continue;
      out.add(text.slice(j, k));
      break;
    }
  }
  // 列明退役的误认值任何一支都不出（第 29 批真实走查：“甲方向乙方采购”里“方采”先被令牌表换掉，“向乙”后面看不到“方”，
  // 没有边界的那一支又把“向乙”认了出来，合同第 3.1、4.2、6.1 条的“向乙方”跟着被换成代号）
  for (const n of out) if (!stillLooksLikeName(n)) out.delete(n);
  return out;
}

/** 词典匹配（长者优先，不重叠）。 */
export function matchDictionary(
  text: string,
  entries: readonly { value: string; category: "person" | "org" }[],
  taken: { start: number; end: number }[],
  source: Hit["source"],
): Hit[] {
  // 容忍写法变体（审查 S4-02：全角、繁体、插入空白与零宽字符）；命中记规范写法，替换原文中实际出现的一段
  const byValue = new Map<string, "person" | "org">();
  for (const e of entries) if (!byValue.has(e.value)) byValue.set(e.value, e.category);
  const hits: Hit[] = [];
  // 单个折行视同插入字符（终核 S4-27）；空行、制表与编号前的换行仍是硬边界
  for (const m of matcherFor([...byValue.keys()]).find(softenSingleBreaks(text))) {
    if (taken.some((t) => m.start < t.end && m.end > t.start)) continue;
    // 代号按原文片段的字形分配（终核 S4-25）：与词典写法只差插入字符、宽度或大小写时用词典写法；
    // 繁体等不同字形的写法用原文片段本身——各有代号，还原逐字等于原文字形，不会还原成另一个写法或另一个人
    const surface = text.slice(m.start, m.end);
    // 拉丁字母姓名按词边界匹配（“Li Na”不命中“Carolina”）
    if (byValue.get(m.value) === "person" && (latinJoin(text[m.start - 1], surface[0]) || latinJoin(surface[surface.length - 1], text[m.end]))) continue;
    const value = shapeFold(surface) === shapeFold(m.value) ? m.value : surface;
    hits.push({ category: byValue.get(m.value)!, start: m.start, end: m.end, value, source });
    taken.push({ start: m.start, end: m.end });
  }
  return hits;
}

function latinJoin(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && /[A-Za-z0-9]/.test(a) && /[A-Za-z0-9]/.test(b);
}

/** 编译后的匹配器按词典内容缓存（同一事项的词典在多次令牌化之间不变）。 */
const matcherCache = new Map<string, VariantMatcher>();
export function matcherFor(values: readonly string[]): VariantMatcher {
  const key = [...values].sort().join("\u0000");
  let m = matcherCache.get(key);
  if (!m) {
    m = new VariantMatcher(values);
    if (matcherCache.size > 64) matcherCache.delete(matcherCache.keys().next().value!);
    matcherCache.set(key, m);
  }
  return m;
}

/** 供二次检测（candidates.ts）复用的规则表与读名函数：与本模块的识别同一口径。 */
export const NAME_RULES = { STOP, COMMON_WORDS, FUNCTION_BEFORE, NAME_DELIM, ORG_AFTER, ORG_TAIL, SPEECH_VERBS, CJK } as const;
export { readName };
