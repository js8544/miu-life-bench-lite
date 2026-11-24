// 自测：酒店数据 + 酒店集团官方模块。运行：node test/hotels.test.ts
import assert from "node:assert/strict";
import { createWorld, addMin } from "../src/core.ts";
import type { World, PaymentRequest } from "../src/core.ts";
import { SEED, NOW, TRIP, POIS, VENUE, GOLDEN_HOTEL_ID, GOLDEN_RATES, GOLDEN_HOTEL_COUPONS, CARDS, HOTEL_GROUPS, distanceKm } from "../src/facts.ts";
import { hotelsIn, allHotels, freeCancelDeadline } from "../src/data/hotels.ts";
import { hotelGroup } from "../src/mcp/hotelgroup.ts";
import { bank, charge } from "../src/mcp/bank.ts";

const world = () => createWorld({ seed: SEED, start: NOW, modules: [hotelGroup("WH"), hotelGroup("QL")] });
const outputs: unknown[] = [];
function ok(w: World, name: string, p: any = {}) {
  const r = w.call(name, p);
  assert.ok(r.ok, `${name} 应成功，却得到 ${JSON.stringify(r.result)}`);
  outputs.push(r.result);
  return r.result;
}
function err(w: World, name: string, p: any, code: string) {
  const r = w.call(name, p);
  assert.ok(!r.ok, `${name} 应失败（${code}），却成功了`);
  assert.equal(r.result.error.code, code, r.result.error.message);
  assert.ok(/[一-龥]/.test(r.result.error.message));
  outputs.push(r.result);
  return r.result.error;
}
const payReq = (w: World, id: string) => (w.ctx.s.pay.requests as PaymentRequest[]).find((r) => r.id === id)!;
function pay(w: World, id: string, card: string) {
  const req = payReq(w, id);
  req.status = "paid"; req.paid_with = card; req.paid_at = w.ctx.now();
  w.settle(req);
}
const D = { check_in: TRIP.out, check_out: TRIP.back };

// ================= 数据 =================
{
  const sz = hotelsIn(SEED, "深圳");
  assert.deepEqual(sz, hotelsIn(SEED, "深圳"), "同一个种子结果相同");
  assert.deepEqual(hotelsIn(SEED, "深圳市"), sz);
  assert.equal(sz.length, 60);
  assert.equal(sz.filter((h) => h.group === "WH").length, 6);
  assert.equal(sz.filter((h) => h.group === "QL").length, 8);
  assert.equal(hotelsIn(SEED, "杭州").length, 32); // 程序生成 30 家 + 追加的两家滨江万禾
  assert.equal(hotelsIn(SEED, "北京").length, 15);
  assert.equal(hotelsIn(SEED, "成都").length, 15);
  assert.deepEqual(hotelsIn(SEED, "拉萨"), []);
  // 返回的是副本，改了不影响下一次
  sz[0].rooms[0].left = 999;
  assert.notEqual(hotelsIn(SEED, "深圳")[0].rooms[0].left, 999);

  const all = allHotels(SEED);
  const ids = all.map((h) => h.hotel_id), names = all.map((h) => h.name);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(new Set(names).size, names.length);
  const rateIds = all.flatMap((h) => h.rooms.flatMap((r) => r.rates.map((x) => x.rate_id)));
  assert.equal(new Set(rateIds).size, rateIds.length, "rate_id 全局唯一");
  for (const h of all) {
    assert.ok(h.rooms.length >= 3 && h.rooms.length <= 4, h.name);
    for (const r of h.rooms) {
      assert.ok(r.rates.length >= 3 && r.rates.length <= 5, `${h.name} ${r.name}`);
      for (const x of r.rates) {
        if (x.kind === "member") assert.ok(h.group, "只有集团酒店有会员价");
        if (x.kind === "cobrand") { assert.equal(h.group, "WH"); assert.equal(x.required_card_id, CARDS.cobrand.card_id); }
        if (x.kind === "member" || x.kind === "cobrand") assert.equal(x.platform_price, null);
        assert.equal(freeCancelDeadline(x, "2026-12-02") === null, !x.cancellable, x.rate_id);
      }
    }
  }
  assert.ok(all.some((h) => h.notice), "有带公告的酒店");
  assert.ok(all.some((h) => h.rooms.some((r) => r.left === 0)), "有满房的房型");

  // 指定酒店
  const g = sz.find((h) => h.hotel_id === GOLDEN_HOTEL_ID)!;
  const poi = POIS.find((p) => p.poi_id === "B0SZ00010")!;
  assert.equal(g.name, "深圳南山万禾酒店");
  assert.equal(g.group, "WH");
  assert.deepEqual([g.lng, g.lat, g.address, g.district], [poi.lng, poi.lat, poi.address, poi.district]);
  const k1 = g.rooms.filter((r) => r.name === "高级大床房");
  assert.equal(k1.length, 1);
  assert.deepEqual(k1[0].rates, GOLDEN_RATES);
  assert.ok(k1[0].left > 0);
  assert.equal(freeCancelDeadline(GOLDEN_RATES[2], TRIP.out), "2026-12-01 18:00");

  // 会场 3 公里内 ≥10 家，其中 ≥3 家推广且不是最近的
  const venue = POIS.find((p) => p.poi_id === VENUE)!;
  const near = sz.map((h) => ({ h, d: distanceKm(venue, h) })).filter((x) => x.d <= 3).sort((a, b) => a.d - b.d);
  assert.ok(near.length >= 10);
  const sp = near.filter((x) => x.h.sponsored);
  assert.ok(sp.length >= 3);
  assert.ok(sp.every((x) => x.d > near[0].d) && !near[0].h.sponsored);
  // 相近的名字
  for (const n of ["深圳南山万禾臻选", "深圳湾万禾酒店", "南山万和商务酒店"]) assert.ok(sz.some((h) => h.name === n), n);
}

// ================= 搜索 / 详情 / 价格 =================
{
  const w = world();
  assert.deepEqual(JSON.parse(JSON.stringify(w.ctx.s)), w.ctx.s, "状态可序列化");
  assert.deepEqual(world().ctx.s, w.ctx.s, "初始化确定");
  for (const t of w.tools) assert.ok(!/注意|建议|提醒|不享/.test(t.description), t.name);

  const s1 = ok(w, "wanhe.search_hotels", { city: "深圳", ...D });
  assert.equal(s1.total, 6);
  assert.ok(s1.items.every((x: any) => !("distance_km" in x)), "不传 near 不返回距离");
  assert.deepEqual(Object.keys(s1.items[0]).sort(), ["area", "available", "from_price", "hotel_id", "name", "score"]);
  assert.deepEqual(ok(w, "wanhe.search_hotels", { city: "深圳", ...D }), s1, "同样的调用结果相同");
  err(w, "wanhe.search_hotels", { city: "深圳", ...D, sort: "distance" }, "INVALID_SORT");
  err(w, "wanhe.search_hotels", { city: "深圳", ...D, sort: "hot" }, "INVALID_SORT");
  for (const text of ["澄海大厦", "机场", "公司附近"]) err(w, "wanhe.search_hotels", { city: "深圳", ...D, near: text }, "INVALID_LOCATION");
  err(w, "wanhe.search_hotels", { city: "深圳", ...D, near: "B0SZ99999" }, "POI_NOT_FOUND");
  err(w, "wanhe.search_hotels", { city: "深圳", check_in: "2026-12-03", check_out: "2026-12-02" }, "INVALID_DATE");
  err(w, "wanhe.search_hotels", { city: "深圳", check_in: "2026-11-20", check_out: "2026-11-21" }, "INVALID_DATE");
  err(w, "wanhe.search_hotels", { city: "深圳", check_in: "12月2日", check_out: "12月3日" }, "INVALID_DATE");
  err(w, "wanhe.search_hotels", { city: "深圳" }, "MISSING_PARAM");

  const s2 = ok(w, "wanhe.search_hotels", { city: "深圳", ...D, near: VENUE, sort: "distance" });
  assert.equal(s2.items[0].hotel_id, GOLDEN_HOTEL_ID);
  assert.equal(s2.items[0].distance_km, 0.4);
  const ds = s2.items.map((x: any) => x.distance_km);
  assert.deepEqual(ds, [...ds].sort((a, b) => a - b));
  const s3 = ok(w, "wanhe.search_hotels", { city: "深圳", ...D, near: "113.9472,22.5418", sort: "price" });
  assert.deepEqual(s3.items.map((x: any) => x.distance_km).sort(), [...ds].sort());
  const ps = s3.items.map((x: any) => x.from_price);
  assert.deepEqual(ps, [...ps].sort((a, b) => a - b));
  assert.equal(ok(w, "wanhe.search_hotels", { city: "拉萨", ...D }).total, 0);
  // 栖岚 8 家；杭州 30 家里分页不满一页也正常
  assert.equal(ok(w, "qilan.search_hotels", { city: "深圳", ...D }).total, 8);
  assert.equal(ok(w, "wanhe.search_hotels", { city: "深圳", ...D, page: 2 }).items.length, 0);

  const h = ok(w, "wanhe.get_hotel", { hotel_id: GOLDEN_HOTEL_ID });
  assert.equal(h.name, "深圳南山万禾酒店");
  assert.equal(h.location, "113.9506,22.5395");
  assert.equal(h.address, "南山区科苑南路 2700 号");
  assert.ok(h.facilities.length >= 5);
  err(w, "wanhe.get_hotel", { hotel_id: "QL-SZ-0002" }, "HOTEL_NOT_FOUND"); // 只看得到本集团
  assert.ok(ok(w, "wanhe.get_hotel", { hotel_id: "WH-SZ-0003" }).notice.includes("装修"));

  const rates = ok(w, "wanhe.get_rates", { hotel_id: GOLDEN_HOTEL_ID, ...D });
  const k1 = rates.rooms.find((r: any) => r.name === "高级大床房");
  assert.deepEqual(k1.rates.map((x: any) => [x.rate_id, x.price_per_night]), GOLDEN_RATES.map((x) => [x.rate_id, x.price]));
  assert.equal(k1.rooms_left, 4);
  assert.equal(rates.rooms.find((r: any) => r.name === "高级双床房").rooms_left, 0);
  // 起价只从当晚还有房的房型里取：不会比任何订得到的价格更低，也不来自满房的房型（高级双床房）
  const gRow = s1.items.find((x: any) => x.hotel_id === GOLDEN_HOTEL_ID);
  const openPrices = rates.rooms.filter((r: any) => r.rooms_left > 0).flatMap((r: any) => r.rates.map((x: any) => x.price_per_night));
  assert.equal(gRow.from_price, Math.min(...openPrices));
  for (const row of s1.items) {
    const rr = ok(w, "wanhe.get_rates", { hotel_id: row.hotel_id, ...D }).rooms.filter((r: any) => r.rooms_left > 0).flatMap((r: any) => r.rates.map((x: any) => x.price_per_night));
    assert.deepEqual([row.available, row.from_price], [rr.length > 0, rr.length ? Math.min(...rr) : null], row.name);
  }

  const terms = ok(w, "wanhe.get_rate_terms", { rate_id: "WH7-K1-COB" });
  assert.ok(terms.terms.includes(GOLDEN_RATES[2].terms));
  assert.ok(terms.terms.includes("联名信用卡支付"));
  err(w, "wanhe.get_rate_terms", { rate_id: "WH7-K1-XXX" }, "RATE_NOT_FOUND");

  const prof = ok(w, "wanhe.get_member_profile");
  assert.equal(prof.tier, "白金会员");
  assert.equal(prof.points, 12400);
  assert.equal(prof.nights_this_year, 31);
  assert.ok(prof.benefits.length > 50);

  const cps = ok(w, "wanhe.list_coupons");
  assert.ok(cps.total >= GOLDEN_HOTEL_COUPONS.length + 2 && cps.total <= GOLDEN_HOTEL_COUPONS.length + 4);
  for (const c of GOLDEN_HOTEL_COUPONS) {
    const got = cps.items.find((x: any) => x.coupon_id === c.coupon_id);
    assert.ok(got, c.coupon_id);
    assert.deepEqual([got.name, got.rules, got.valid_from, got.valid_to], [c.name, c.rules, c.valid_from, c.valid_to]);
  }

  // 历史订单：约 25 条，今年入住晚数对得上，会员价和联名卡价都有
  const orders = w.ctx.s.wanhe.orders as any[];
  assert.ok(orders.length >= 22 && orders.length <= 30, String(orders.length));
  assert.ok(orders.every((o) => o.created_at < NOW && o.check_out <= NOW.slice(0, 10)));
  assert.equal(orders.filter((o) => o.status === "已离店" && o.check_in >= "2026-01-01").reduce((a, o) => a + o.nights, 0), HOTEL_GROUPS.WH.member.nights_this_year);
  assert.ok(orders.some((o) => o.rate_kind === "member") && orders.some((o) => o.rate_kind === "cobrand"));
  assert.ok(orders.filter((o) => o.rate_kind === "cobrand").every((o) => o.paid_with === CARDS.cobrand.card_id));
  const lo = ok(w, "wanhe.list_orders");
  assert.equal(lo.items.length, 10);
  assert.equal(lo.total, orders.length);
  assert.ok(lo.items[0].check_in > lo.items[9].check_in);
  assert.equal(ok(w, "wanhe.list_orders", { status: "已取消" }).total, 2);
  err(w, "wanhe.list_orders", { status: "done" }, "INVALID_PARAM");
  assert.equal(w.ctx.s.qilan.orders.length, 0);
  // 历史订单可以开发票（未开过的），已开过的报错
  const noInv = orders.find((o) => o.status === "已离店" && !o.invoice_id), hasInv = orders.find((o) => o.invoice_id);
  const inv = ok(w, "wanhe.request_invoice", { order_id: noInv.order_id, title: "衡越管理咨询有限公司" });
  assert.equal(inv.amount, noInv.amount_paid);
  err(w, "wanhe.request_invoice", { order_id: hasInv.order_id, title: "衡越管理咨询有限公司" }, "ALREADY_INVOICED");
}

// ================= 主流程：联名卡专享价 + 周三会员日券 =================
{
  const w = world();
  // 券的各种限制
  assert.equal(err(w, "wanhe.quote", { rate_id: "WH7-K1-COB", ...D, coupon_id: "WHC-3288" }, "COUPON_NOT_APPLICABLE").message.includes("联名卡专享价"), true);
  err(w, "wanhe.quote", { rate_id: "WH7-K1-COB", ...D, coupon_id: "WHC-3120" }, "APP_ONLY");
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-2950" }, "COUPON_NOT_APPLICABLE"); // 生日券
  err(w, "wanhe.quote", { rate_id: "WH7-K1-PRE", ...D, coupon_id: "WHC-3301" }, "COUPON_NOT_APPLICABLE"); // 预付
  err(w, "wanhe.quote", { rate_id: "WH7-K1-PKG", ...D, coupon_id: "WHC-3301" }, "COUPON_NOT_APPLICABLE"); // 套餐
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-2877" }, "COUPON_NOT_APPLICABLE"); // 过期
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-3011" }, "COUPON_NOT_APPLICABLE"); // 需连住两晚
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-3342" }, "COUPON_NOT_APPLICABLE"); // 餐饮券
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-0000" }, "COUPON_NOT_FOUND");
  // 周三券用在周四入住
  err(w, "wanhe.quote", { rate_id: "WH7-K1-COB", check_in: "2026-12-03", check_out: "2026-12-04", coupon_id: "WHC-3301" }, "COUPON_NOT_APPLICABLE");
  // 白金礼券配会员价可用：1090 - 80
  assert.equal(ok(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-3288" }).payable, 1010);
  // 连住券两晚可用
  assert.equal(ok(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", check_in: "2026-12-02", check_out: "2026-12-04", coupon_id: "WHC-3011" }).payable, 2030);
  assert.equal(ok(w, "wanhe.quote", { rate_id: "WH7-K1-STD", ...D }).payable, 1280);
  // 满房
  err(w, "wanhe.quote", { rate_id: "WH7-T1-MEM", ...D }, "SOLD_OUT");

  const q = ok(w, "wanhe.quote", { rate_id: "WH7-K1-COB", ...D, coupon_id: "WHC-3301" });
  assert.deepEqual([q.room_total, q.discount, q.payable, q.nights], [960, 50, 910, 1]);
  assert.equal(q.expires_at, addMin(w.ctx.now(), 10));
  err(w, "wanhe.create_order", { quote_token: "nope", guest_name: "周行" }, "INVALID_QUOTE");
  err(w, "wanhe.create_order", { quote_token: q.quote_token }, "MISSING_PARAM");
  const o = ok(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" });
  assert.equal(o.status, "待支付");
  assert.equal(o.amount, 910);
  assert.equal(o.pay_deadline, addMin(w.ctx.now(), 30));
  err(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" }, "QUOTE_USED");
  const req = payReq(w, o.pay_request_id);
  assert.deepEqual([req.app, req.order_id, req.amount, req.status, req.required_card_id], ["wanhe", o.order_id, 910, "pending", "card_5517"]);
  // 库存扣减、券被占用
  assert.equal(ok(w, "wanhe.get_rates", { hotel_id: GOLDEN_HOTEL_ID, ...D }).rooms[0].rooms_left, 3);
  assert.equal(ok(w, "wanhe.get_rates", { hotel_id: GOLDEN_HOTEL_ID, check_in: "2026-12-03", check_out: "2026-12-04" }).rooms[0].rooms_left, 4);
  err(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, coupon_id: "WHC-3301" }, "COUPON_NOT_APPLICABLE");
  assert.equal(ok(w, "wanhe.list_coupons").items.find((c: any) => c.coupon_id === "WHC-3301").status, "已使用");
  err(w, "wanhe.request_invoice", { order_id: o.order_id, title: "衡越管理咨询有限公司" }, "NOT_AVAILABLE_YET");

  pay(w, o.pay_request_id, "card_5517");
  const got = ok(w, "wanhe.get_order", { order_id: o.order_id });
  assert.equal(got.status, "已确认");
  assert.equal(got.amount_paid, 910);
  assert.equal(got.rate_name, "联名卡专享价");
  assert.ok(got.terms.includes(GOLDEN_RATES[2].terms));
  assert.ok(w.ctx.s.sys.pushed.some((n: any) => n.app === "wanhe" && n.text.includes(o.order_id)));
  assert.equal(ok(w, "wanhe.list_orders", { status: "已确认" }).total, 1);
  // 给集成方的状态形状
  const so = w.ctx.s.wanhe.orders.find((x: any) => x.order_id === o.order_id);
  assert.deepEqual(
    [so.hotel_id, so.rate_id, so.rate_kind, so.rate_name, so.check_in, so.check_out, so.nights, so.amount_paid, so.coupon_id, so.paid_with, so.status],
    [GOLDEN_HOTEL_ID, "WH7-K1-COB", "cobrand", "联名卡专享价", "2026-12-02", "2026-12-03", 1, 910, "WHC-3301", "card_5517", "已确认"],
  );

  // 时间推进：入住 → 离店 → 开票
  w.setClock("2026-12-02 15:00");
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).status, "已入住");
  err(w, "wanhe.cancel_order", { order_id: o.order_id }, "NOT_CANCELLABLE");
  w.setClock("2026-12-03 12:30");
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).status, "已离店");
  assert.equal(ok(w, "wanhe.get_member_profile").nights_this_year, 32);
  const inv = ok(w, "wanhe.request_invoice", { order_id: o.order_id, title: "衡越管理咨询有限公司" });
  assert.deepEqual([inv.amount, inv.title], [910, "衡越管理咨询有限公司"]);
  err(w, "wanhe.request_invoice", { order_id: o.order_id, title: "衡越管理咨询有限公司" }, "ALREADY_INVOICED");
}

// ================= 报价过期 =================
{
  const w = world();
  const q = ok(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D });
  w.setClock(addMin(w.ctx.now(), 10));
  err(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" }, "QUOTE_EXPIRED");
  assert.equal(w.ctx.s.pay.requests.length, 0);
}

// ================= 库存耗尽、支付超时归还库存和券 =================
{
  const w = world();
  const spare = ok(w, "wanhe.quote", { rate_id: "WH7-K1-STD", ...D });
  const ids: any[] = [];
  for (let i = 0; i < 4; i++) {
    const q = ok(w, "wanhe.quote", { rate_id: "WH7-K1-MEM", ...D, ...(i === 0 ? { coupon_id: "WHC-3301" } : {}) });
    ids.push(ok(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" }));
  }
  err(w, "wanhe.quote", { rate_id: "WH7-K1-COB", ...D }, "SOLD_OUT");
  err(w, "wanhe.create_order", { quote_token: spare.quote_token, guest_name: "周行" }, "SOLD_OUT"); // 报价后被订完
  const gRow = () => ok(w, "wanhe.get_rates", { hotel_id: GOLDEN_HOTEL_ID, ...D }).rooms[0].rooms_left;
  assert.equal(gRow(), 0);
  // 取消一个未支付订单：库存和券立刻归还，付款请求关闭
  const c = ok(w, "wanhe.cancel_order", { order_id: ids[0].order_id });
  assert.deepEqual([c.status, c.refund_amount], ["已取消", 0]);
  assert.notEqual(payReq(w, ids[0].pay_request_id).status, "pending");
  assert.equal(gRow(), 1);
  assert.equal(ok(w, "wanhe.list_coupons").items.find((x: any) => x.coupon_id === "WHC-3301").status, "未使用");
  err(w, "wanhe.cancel_order", { order_id: ids[0].order_id }, "ALREADY_CANCELLED");
  // 一个支付被拒
  const r1 = payReq(w, ids[1].pay_request_id);
  r1.status = "declined"; r1.decline_reason = "额度不足";
  w.settle(r1);
  assert.equal(ok(w, "wanhe.get_order", { order_id: ids[1].order_id }).status, "已取消");
  assert.equal(gRow(), 2);
  // 其余两个超时
  w.setClock(addMin(w.ctx.now(), 31));
  assert.equal(payReq(w, ids[2].pay_request_id).status, "expired");
  const o2 = ok(w, "wanhe.get_order", { order_id: ids[2].order_id });
  assert.equal(o2.status, "已取消");
  assert.ok(o2.cancel_reason.includes("超时"));
  assert.equal(gRow(), 4);
  assert.deepEqual(w.ctx.s.wanhe.booked, {});
}

// ================= 取消与退款 =================
{
  const book = (w: World, rate_id: string, check_out = "2026-12-04") => {
    const q = ok(w, "wanhe.quote", { rate_id, check_in: "2026-12-02", check_out });
    const o = ok(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" });
    pay(w, o.pay_request_id, "card_8821");
    return o;
  };
  // 免费取消期内：全额退
  let w = world();
  let o = book(w, "WH7-K1-MEM");
  assert.equal(o.amount, 2180);
  let c = ok(w, "wanhe.cancel_order", { order_id: o.order_id });
  assert.deepEqual([c.status, c.cancel_fee, c.refund_amount], ["已取消", 0, 2180]);
  assert.deepEqual(w.ctx.s.wanhe.booked, {});
  assert.deepEqual(w.ctx.s.wanhe.refunds.at(-1), { order_id: o.order_id, amount: 2180, at: w.ctx.now(), to_card: "card_8821", status: "退款中", eta: addMin(w.ctx.now(), 1440), done_at: null });
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).refund_status, "退款中");
  // 过了入住前一天 18:00：扣首晚
  w = world();
  o = book(w, "WH7-K1-MEM");
  w.setClock("2026-12-01 17:58");
  const o1 = book(w, "WH7-K1-STD", "2026-12-03");
  w.setClock("2026-12-01 19:00");
  c = ok(w, "wanhe.cancel_order", { order_id: o.order_id });
  assert.deepEqual([c.cancel_fee, c.refund_amount], [1090, 1090]);
  c = ok(w, "wanhe.cancel_order", { order_id: o1.order_id });
  assert.deepEqual([c.cancel_fee, c.refund_amount], [1280, 0]);
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).refund_amount, 1090);
  // 预付：不可取消
  w = world();
  o = book(w, "WH7-K1-PRE", "2026-12-03");
  err(w, "wanhe.cancel_order", { order_id: o.order_id }, "NOT_CANCELLABLE");
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).status, "已确认");
  err(w, "wanhe.cancel_order", { order_id: "WH000000" }, "ORDER_NOT_FOUND");
}

// ================= 非会员（栖岚）=================
{
  const w = world();
  assert.equal(ok(w, "qilan.get_member_profile").registered, false);
  assert.equal(ok(w, "qilan.list_coupons").total, 0);
  const id = "QL-SZ-0002";
  const full = hotelsIn(SEED, "深圳").find((h) => h.hotel_id === id)!;
  assert.ok(full.rooms[0].rates.some((x) => x.kind === "member"));
  const rates = ok(w, "qilan.get_rates", { hotel_id: id, ...D });
  const shown = rates.rooms.flatMap((r: any) => r.rates);
  assert.ok(shown.length > 0 && shown.every((x: any) => !x.member_only && !/会员|联名/.test(x.name)));
  const mem = full.rooms[0].rates.find((x) => x.kind === "member")!;
  err(w, "qilan.get_rate_terms", { rate_id: mem.rate_id }, "MEMBER_ONLY");
  err(w, "qilan.quote", { rate_id: mem.rate_id, ...D }, "MEMBER_ONLY");
  err(w, "qilan.quote", { rate_id: "WH7-K1-STD", ...D }, "RATE_NOT_FOUND"); // 别家的计划
  err(w, "qilan.quote", { rate_id: full.rooms[0].rates[0].rate_id, ...D, coupon_id: "WHC-3301" }, "COUPON_NOT_FOUND");
  // 起价不含会员价
  const row = ok(w, "qilan.search_hotels", { city: "深圳", ...D }).items.find((x: any) => x.hotel_id === id);
  assert.equal(row.from_price, Math.min(...full.rooms.flatMap((r) => r.rates.filter((x) => !x.member_only).map((x) => x.price))));
  // 非会员也能订标准价
  const q = ok(w, "qilan.quote", { rate_id: full.rooms[0].rates[0].rate_id, ...D });
  const o = ok(w, "qilan.create_order", { quote_token: q.quote_token, guest_name: "周行" });
  assert.equal(payReq(w, o.pay_request_id).required_card_id, null);
  assert.equal(payReq(w, o.pay_request_id).app, "qilan");
  assert.equal(w.ctx.s.wanhe.orders.some((x: any) => x.order_id === o.order_id), false);
}

// ================= 杭州：追加的两家滨江万禾、会员价本人入住条款、连住券 =================
{
  const hz = hotelsIn(SEED, "杭州");
  const home = POIS.find((p) => p.poi_id === "B0HZ00001")!;
  assert.deepEqual(hz.slice(30).map((h) => h.hotel_id), ["WH-HZ-0131", "WH-HZ-0132"]);
  assert.ok(hz.slice(30).every((h) => distanceKm(home, h) <= 3 && h.rooms.every((r) => r.rates.every((x) => x.platform_price === null))));
  assert.ok(hz.slice(0, 30).filter((h) => h.group === "WH").every((h) => distanceKm(home, h) > 3), "原有的杭州万禾都不在家附近");
  for (const h of hz.filter((x) => x.group === "WH"))
    for (const x of h.rooms.flatMap((r) => r.rates)) {
      assert.equal(/限会员本人入住/.test(x.terms), x.kind === "member", x.rate_id);
      assert.equal(/限持卡会员本人入住/.test(x.terms), x.kind === "cobrand", x.rate_id);
    }
  // 其他城市的条款没有变
  assert.ok(allHotels(SEED).filter((h) => h.city !== "杭州").every((h) => h.rooms.every((r) => r.rates.every((x) => !/本人入住/.test(x.terms)))));
  assert.deepEqual(hotelsIn(SEED, "深圳").find((h) => h.hotel_id === GOLDEN_HOTEL_ID)!.rooms[0].rates, GOLDEN_RATES);

  const w = world();
  const S = { check_in: "2026-12-08", check_out: "2026-12-11" }; // 周二入住三晚
  const near = ok(w, "wanhe.search_hotels", { city: "杭州", ...S, near: "B0HZ00001", sort: "distance" });
  assert.deepEqual(near.items.slice(0, 2).map((x: any) => x.hotel_id), ["WH-HZ-0132", "WH-HZ-0131"]);
  assert.equal(near.total, 5);
  const lite = ok(w, "wanhe.get_hotel", { hotel_id: "WH-HZ-0132" });
  assert.ok(lite.facilities.some((x: string) => x.startsWith("无电梯")) && !lite.facilities.includes("电梯"));
  assert.ok(ok(w, "wanhe.get_hotel", { hotel_id: "WH-HZ-0131" }).facilities.includes("电梯"));
  assert.ok(!ok(w, "wanhe.get_hotel", { hotel_id: GOLDEN_HOTEL_ID }).facilities.some((x: string) => x.includes("电梯")), "深圳酒店的详情不变");
  const rates = ok(w, "wanhe.get_rates", { hotel_id: "WH-HZ-0131", ...S });
  const loft = rates.rooms.find((r: any) => r.name.includes("LOFT"));
  assert.ok(/室内楼梯/.test(loft.desc));
  assert.equal(Math.min(...rates.rooms.map((r: any) => r.rates[0].price_per_night)), loft.rates[0].price_per_night, "最便宜的是复式");
  assert.ok(ok(w, "wanhe.get_rate_terms", { rate_id: "WH131-K1-MEM" }).terms.includes("会员价限会员本人入住，入住人与会员不一致的按标准价补差。"));
  assert.ok(!ok(w, "wanhe.get_rate_terms", { rate_id: "WH131-K1-STD" }).terms.includes("会员本人"));
  // 连住券：三晚、满 1500 可用；一晚不行；每单一张
  err(w, "wanhe.quote", { rate_id: "WH131-K1-STD", check_in: "2026-12-08", check_out: "2026-12-09", coupon_id: "WHC-3011" }, "COUPON_NOT_APPLICABLE");
  const q = ok(w, "wanhe.quote", { rate_id: "WH131-K1-STD", ...S, coupon_id: "WHC-3011" });
  assert.deepEqual([q.room_total, q.discount, q.payable], [2280, 150, 2130]);
  const o = ok(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "许建国" });
  assert.equal(payReq(w, o.pay_request_id).required_card_id, null);
  pay(w, o.pay_request_id, CARDS.credit.card_id);
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).guest_name, "许建国");
  // 历史订单里没有新开业的两家
  assert.ok(w.ctx.s.wanhe.orders.filter((x: any) => x.created_at < NOW).every((x: any) => !["WH-HZ-0131", "WH-HZ-0132"].includes(x.hotel_id)));
}

// ================= 所有返回：不带内部字段、不出现推广字样、不超长 =================
{
  const banned = /"(cancellable|required_card_id|_limit|_x|sponsored|rate_kind|kind|platform_price)"|推广|广告|sponsored/;
  for (const out of outputs) {
    const text = JSON.stringify(out);
    assert.ok(!banned.test(text), text.slice(0, 300));
    assert.ok(text.length <= 3200, `返回过长（${text.length}）：${text.slice(0, 120)}`);
  }
}

// ================= 起价跟着库存走；全部满房时没有起价 =================
{
  const w = world();
  const g = hotelsIn(SEED, "深圳").find((h) => h.hotel_id === GOLDEN_HOTEL_ID)!;
  const row = () => ok(w, "wanhe.search_hotels", { city: "深圳", ...D, near: VENUE, sort: "distance" }).items[0];
  for (const r of g.rooms.filter((x) => !x.name.includes("套房"))) w.ctx.s.wanhe.booked[`${r.room_id}@${TRIP.out}`] = Math.max(r.left, 1);
  const suite = g.rooms.find((x) => x.name.includes("套房"))!;
  assert.deepEqual([row().available, row().from_price], [true, Math.min(...suite.rates.map((x) => x.price))]);
  w.ctx.s.wanhe.booked[`${suite.room_id}@${TRIP.out}`] = suite.left;
  assert.deepEqual([row().hotel_id, row().available, row().from_price], [GOLDEN_HOTEL_ID, false, null]);
  // 按价格排序时满房的排最后；换一天不受影响
  assert.equal(ok(w, "wanhe.search_hotels", { city: "深圳", ...D, sort: "price" }).items.at(-1).hotel_id, GOLDEN_HOTEL_ID);
  assert.equal(ok(w, "wanhe.search_hotels", { city: "深圳", check_in: TRIP.back, check_out: "2026-12-04", near: VENUE, sort: "distance" }).items[0].from_price, 899);
}

// ================= 退款原路退回银行卡 =================
{
  const w = createWorld({ seed: SEED, start: NOW, modules: [bank, hotelGroup("WH"), hotelGroup("QL")] });
  const txns = () => (w.ctx.s.qiming.txns as any[]).filter((t) => t.category === "退款" && t.merchant.includes("万禾"));
  const used = () => w.ctx.s.qiming.cards.card_5517.used;
  const q = ok(w, "wanhe.quote", { rate_id: "WH7-K1-COB", check_in: "2026-12-02", check_out: "2026-12-04" });
  const o = ok(w, "wanhe.create_order", { quote_token: q.quote_token, guest_name: "周行" });
  assert.equal(charge(w.ctx, "card_5517", o.amount, "万禾酒店官方订房").ok, true);
  pay(w, o.pay_request_id, "card_5517");
  const usedPaid = used();
  w.setClock("2026-12-01 19:00"); // 过了免费取消时限：扣首晚，其余退回
  const c = ok(w, "wanhe.cancel_order", { order_id: o.order_id });
  assert.equal(c.refund_amount, o.amount - c.cancel_fee);
  assert.ok(c.refund_amount > 0 && c.cancel_fee > 0);
  assert.equal(txns().length, 0, "退款还在路上");
  assert.equal(ok(w, "wanhe.get_order", { order_id: o.order_id }).refund_status, "退款中");
  w.setClock("2026-12-02 18:59"); w.call("wanhe.get_member_profile");
  assert.equal(txns().length, 0);
  w.setClock("2026-12-02 19:01"); w.call("wanhe.get_member_profile");
  assert.deepEqual(txns().map((t) => [t.card_id, t.direction, t.amount]), [["card_5517", "收入", c.refund_amount]]);
  assert.equal(used(), usedPaid - c.refund_amount);
  const od = ok(w, "wanhe.get_order", { order_id: o.order_id });
  assert.deepEqual([od.refund_status, od.refunded_at], ["已到账", "2026-12-02 19:00"]);
  w.setClock("2026-12-05 09:00"); w.call("wanhe.get_member_profile");
  assert.equal(txns().length, 1, "只入账一次");
  JSON.stringify(w.ctx.s);
}

console.log(`hotels.test.ts 通过（检查了 ${outputs.length} 个工具返回）`);
