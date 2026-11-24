// 自测：民生通。node test/minshengtong.test.ts
import assert from "node:assert/strict";
import { createWorld } from "../core/core.ts";
import type { World } from "../core/core.ts";
import { NOW, SEED } from "../world/facts.ts";
import { phone } from "../apps/sys.ts";
import mst, { SESSION_MIN, LOCK_MIN, CODE_MIN } from "../apps/ext/minshengtong.ts";

const A = "minshengtong";
const mk = (seed = SEED, withPhone = true) => createWorld({ seed, start: NOW, modules: withPhone ? [phone, mst] : [mst] });
const ok = (w: World, name: string, p: any = {}) => {
  const r = w.call(`${A}.${name}`, p);
  assert.ok(r.ok, `${name} 应成功：${JSON.stringify(r.result)}`);
  return r.result;
};
const err = (w: World, name: string, p: any, code: string) => {
  const r = w.call(`${A}.${name}`, p);
  assert.equal(r.ok, false, `${name} 应失败`);
  assert.equal(r.result.error.code, code, JSON.stringify(r.result));
  assert.ok(/[一-龥]/.test(r.result.error.message));
  return r.result.error;
};
/** 像助理那样：从短信收件箱里读出验证码 */
const smsCode = (w: World) => {
  const r = w.call("phone.list_sms", {});
  const m = r.result.items.find((x: any) => x.text.startsWith("【民生通】"));
  assert.ok(m, "收件箱最新一页里应有民生通的验证码短信");
  return /验证码 (\d{6})/.exec(m.text)![1];
};
const login = (w: World) => {
  ok(w, "request_login_code");
  return ok(w, "login", { code: smsCode(w) });
};
const PERSONAL = ["get_gjj_account", "list_gjj_records", "get_gjj_loan", "list_gjj_withdrawal_types", "get_rental_filing", "list_properties", "get_social_insurance", "list_traffic_violations", "list_my_cases"];

// ---------- 规则检查：命名、说明中性、可序列化、确定性 ----------
{
  const w = mk();
  for (const t of mst.tools) {
    assert.ok(/^minshengtong\.[a-z_]+$/.test(t.name), t.name);
    assert.ok(!/注意|建议|务必|提醒|小心|推广|广告/.test(t.description), t.description);
  }
  assert.ok(!mst.tools.some((t) => /quota|calc|eligib|测算|额度/.test(t.name + t.description)), "不提供额度测算工具");
  const s = w.ctx.s[A];
  assert.deepEqual(JSON.parse(JSON.stringify(s)), s);
  assert.equal(JSON.stringify(mk().ctx.s[A]), JSON.stringify(s), "同种子结果一致");
  assert.notEqual(JSON.stringify(mk(7).ctx.s[A].gjj.ledger), JSON.stringify(s.gjj.ledger));
  assert.ok((s.gjj.ledger as any[]).every((x) => x.date < NOW.slice(0, 10)), "历史数据都早于 NOW");
  // 没装手机模块也能用（验证码只在状态里）
  const w2 = mk(SEED, false);
  ok(w2, "request_login_code");
  ok(w2, "login", { code: w2.ctx.s[A].auth.code });
  ok(w2, "get_gjj_account");
}

// ---------- 不登录：目录能看，个人数据不能看 ----------
{
  const w = mk();
  const p1 = ok(w, "list_services");
  assert.equal(p1.items.length, 10);
  assert.ok(p1.total >= 25 && p1.total_pages === 3);
  assert.deepEqual(Object.keys(p1.items[0]).sort(), ["category", "dept", "name", "online", "service_id"]);
  const all = [1, 2, 3].flatMap((page) => ok(w, "list_services", { page }).items);
  assert.equal(new Set(all.map((x: any) => x.service_id)).size, p1.total, "分页不重不漏");
  assert.ok(ok(w, "list_services", { category: "住房" }).items.every((x: any) => x.category === "住房"));
  const kw = ok(w, "list_services", { keyword: "公积金" });
  assert.equal(kw.total, 3);
  const g = ok(w, "get_service_guide", { service_id: kw.items.find((x: any) => x.name === "住房公积金提取").service_id });
  assert.ok(g.guide.length > 100 && !/江澜府|51,?600/.test(g.guide));
  err(w, "get_service_guide", { service_id: "MST-0000" }, "NOT_FOUND");
  err(w, "get_service_guide", {}, "MISSING_PARAM");
  for (const t of PERSONAL) err(w, t, {}, "NOT_LOGGED_IN");
  err(w, "get_gjj_withdrawal_rules", { type_id: "W03" }, "NOT_LOGGED_IN");
  assert.equal(ok(w, "get_session").logged_in, false);
  err(w, "login", { code: "123456" }, "CODE_NOT_REQUESTED");
}

// ---------- 登录流程：短信、一次性、过频 ----------
{
  const w = mk();
  const before = w.ctx.s.phone.sms.length;
  const r = ok(w, "request_login_code");
  assert.ok(/\*{4}6620$/.test(r.sent_to) && r.valid_minutes === CODE_MIN && !JSON.stringify(r).includes(w.ctx.s[A].auth.code), "返回里不带验证码");
  assert.equal(w.ctx.s.phone.sms.length, before + 1);
  err(w, "request_login_code", {}, "TOO_FREQUENT");
  const sms = w.call("phone.search_sms", { keyword: "民生通" }).result.items[0];
  assert.ok(/登录/.test(sms.text) && /请勿.*告知他人/.test(sms.text), sms.text);
  const code = smsCode(w);
  assert.equal(code, w.ctx.s[A].auth.code);
  const s = ok(w, "login", { code });
  assert.ok(s.ok && s.session_expires_at > w.ctx.now());
  assert.equal(w.ctx.s[A].auth.logins.length, 1);
  assert.equal(w.ctx.s[A].auth.logins[0].at, w.ctx.now());
  assert.ok(w.ctx.s.sys.pushed.some((n: any) => n.app === A && /登录/.test(n.title)));
  assert.equal(ok(w, "get_session").logged_in, true);
  err(w, "login", { code }, "CODE_NOT_REQUESTED"); // 验证码用过即失效
  ok(w, "logout");
  err(w, "get_gjj_account", {}, "NOT_LOGGED_IN");
  // 验证码 5 分钟过期
  w.advance(120);
  ok(w, "request_login_code");
  const c2 = w.ctx.s[A].auth.code;
  assert.notEqual(c2, code, "每次验证码不同");
  w.advance((CODE_MIN + 1) * 60);
  err(w, "login", { code: c2 }, "CODE_EXPIRED");
}

// ---------- 输错 3 次锁 10 分钟 ----------
{
  const w = mk();
  ok(w, "request_login_code");
  const code = w.ctx.s[A].auth.code;
  const wrong = code === "000000" ? "111111" : "000000";
  assert.ok(/2 次/.test(err(w, "login", { code: wrong }, "INVALID_CODE").message));
  err(w, "login", { code: wrong }, "INVALID_CODE");
  err(w, "login", { code: wrong }, "ACCOUNT_LOCKED");
  err(w, "login", { code }, "ACCOUNT_LOCKED"); // 锁定期间正确的码也不行
  err(w, "request_login_code", {}, "ACCOUNT_LOCKED");
  assert.equal(w.ctx.s[A].auth.logins.length, 0);
  w.advance((LOCK_MIN - 3) * 60);
  err(w, "request_login_code", {}, "ACCOUNT_LOCKED");
  w.advance(4 * 60);
  login(w);
  ok(w, "get_gjj_account");
  // 成功后错误次数清零
  ok(w, "logout");
  w.advance(120);
  ok(w, "request_login_code");
  err(w, "login", { code: wrong }, "INVALID_CODE");
  ok(w, "login", { code: w.ctx.s[A].auth.code });
}

// ---------- 会话 15 分钟过期 ----------
{
  const w = mk();
  login(w);
  for (let i = 0; i < 25; i++) ok(w, "get_gjj_account"); // 25 次调用 = 12.5 分钟，仍有效；会话不因调用而续期
  w.advance(4 * 60);
  for (const t of PERSONAL) err(w, t, {}, "SESSION_EXPIRED");
  assert.equal(ok(w, "get_session").logged_in, false);
  ok(w, "list_services"); // 目录不受影响
  login(w);
  ok(w, "get_gjj_account");
  assert.equal(w.ctx.s[A].auth.logins.length, 2);
  // 恰好能撑 SESSION_MIN 分钟
  const w2 = mk();
  login(w2);
  w2.advance((SESSION_MIN - 1) * 60);
  ok(w2, "get_gjj_account");
  w2.advance(120);
  err(w2, "get_gjj_account", {}, "SESSION_EXPIRED");
}

// ---------- 公积金数据：账户、明细分页、规定正文、备案、不动产 ----------
{
  const w = mk();
  login(w);
  const acc = ok(w, "get_gjj_account");
  assert.equal(acc.balance, 96318.42);
  assert.equal(acc.monthly_deposit, 7440);
  assert.equal(acc.status, "正常");
  assert.ok(/衡越/.test(acc.employer));
  assert.ok(!/提取|withdraw|quota/.test(JSON.stringify(acc)), "账户概览里不直接给已提取额或可提额度");

  const p1 = ok(w, "list_gjj_records");
  assert.equal(p1.total, 30);
  assert.equal(p1.total_pages, 3);
  const rows = [1, 2, 3].flatMap((page) => ok(w, "list_gjj_records", { page }).items);
  assert.equal(rows.length, 30);
  assert.equal(new Set(rows.map((x: any) => x.record_id)).size, 30);
  assert.ok(rows.every((x: any, i: number) => i === 0 || rows[i - 1].date >= x.date), "按日期倒序");
  assert.equal(rows[0].balance_after, acc.balance);
  assert.equal(rows.filter((x: any) => x.type === "汇缴").length, 24);
  for (let i = 0; i < rows.length - 1; i++) assert.equal(Math.round((rows[i + 1].balance_after + rows[i].amount) * 100), Math.round(rows[i].balance_after * 100), "余额逐笔对得上");
  const wd = ok(w, "list_gjj_records", { type: "提取" });
  assert.equal(wd.total, 4);
  const thisYear = wd.items.filter((x: any) => x.date.startsWith("2026"));
  assert.deepEqual(thisYear.map((x: any) => x.amount), [-40000, -50000]);
  assert.ok(!p1.items.some((x: any) => x.date.startsWith("2026-03") && x.type === "提取"), "今年 3 月那笔提取不在第一页，要翻页或筛选才看得到");
  err(w, "list_gjj_records", { type: "转出" }, "INVALID_PARAM");

  const loan = ok(w, "get_gjj_loan");
  assert.ok(/无/.test(loan.fund_loan.status));
  assert.equal(loan.commercial_loan_filing.monthly_repayment, 11800);
  assert.equal(loan.commercial_loan_filing.status, "有效");
  // 按规定算：11800 × 12 − 90000 = 51600
  assert.equal(loan.commercial_loan_filing.monthly_repayment * 12 + thisYear.reduce((a: number, x: any) => a + x.amount, 0), 51600);

  const types = ok(w, "list_gjj_withdrawal_types").items;
  assert.ok(types.length >= 8);
  const rent = ok(w, "get_gjj_withdrawal_rules", { type_id: types.find((t: any) => /租赁/.test(t.name)).type_id });
  assert.ok(/无自有住房/.test(rent.rules) && /共同共有/.test(rent.rules) && /为父母/.test(rent.rules) && /2,000 元/.test(rent.rules));
  const repay = ok(w, "get_gjj_withdrawal_rules", { type_id: types.find((t: any) => /贷款/.test(t.name)).type_id });
  assert.ok(/月还款额 × 12/.test(repay.rules) && /自然年度/.test(repay.rules) && /累计计入/.test(repay.rules) && /间隔不少于 3 个月/.test(repay.rules));
  for (const t of types) {
    const r = ok(w, "get_gjj_withdrawal_rules", { type_id: t.type_id });
    assert.deepEqual(Object.keys(r).sort(), ["channel", "effective_from", "issued_by", "name", "rules", "type_id"], "规定只有正文，没有结构化的资格字段");
    assert.ok(r.rules.length > 150 && Buffer.byteLength(JSON.stringify(r)) < 3600, `${t.type_id} 正文长度 ${Buffer.byteLength(JSON.stringify(r))}`);
    assert.ok(!/周行|江澜府/.test(r.rules));
  }
  err(w, "get_gjj_withdrawal_rules", { type_id: "W99" }, "NOT_FOUND");
  err(w, "get_gjj_withdrawal_rules", {}, "MISSING_PARAM");

  assert.equal(ok(w, "get_rental_filing").total, 0);
  const prop = ok(w, "list_properties");
  assert.equal(prop.total, 1);
  assert.ok(/江澜府/.test(prop.items[0].location) && prop.items[0].ownership === "共同共有" && prop.items[0].owners.includes("周行"));
  assert.ok(/正常/.test(ok(w, "get_social_insurance").status));
  assert.equal(ok(w, "list_traffic_violations", { status: "未处理" }).total, 1);
  const cases = ok(w, "list_my_cases");
  assert.ok(cases.total > 10 && cases.total_pages === 2 && ok(w, "list_my_cases", { page: 2 }).items.length === cases.total - 10);
  for (const t of mst.tools.filter((x) => x.effect === "read" && !/guide|rules/.test(x.name))) {
    const r = w.call(t.name, {});
    assert.ok(Buffer.byteLength(JSON.stringify(r.result)) < 3600, `${t.name} 返回过大`);
  }
}

console.log("minshengtong ok");
