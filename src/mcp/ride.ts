// 快马出行（kuaima）：预估 → 下单 → 接单 → 到达 → 行程中 → 完成后收款（免密签约生效则经回声支付从银行卡扣款，否则待支付）。打车和代驾两条流程，订单用 service 区分。
// 位置解析、车程、高峰判断都来自地图模块和 facts.ts，保证两边对得上。
import { ToolError, addDays, addMin, chance, int, minutesBetween, need, paginate, pick, toMs, weekday } from "../core.ts";
import type { Ctx, Module, PaymentRequest, Tool } from "../core.ts";
import { DEFAULT_CARD, HOME, NOW, PERSONA, AIRPORT, distanceKm, rideFare } from "../facts.ts";
import { OFFICE, cityAt, driveMinutesAt, getPoi, isExtPoi, isPeak, poiDb, resolveLocation } from "./maps.ts";
import type { MapPoi } from "./maps.ts";
import { payApi } from "./pay.ts";

const APP = "kuaima";
const MERCHANT = "快马出行";

export const CAR_TYPES = ["快车", "优享", "专车", "六座"] as const;
export type CarType = (typeof CAR_TYPES)[number];
export const CAR_FACTOR: Record<CarType, number> = { 快车: 1, 优享: 1.25, 专车: 1.8, 六座: 1.5 };
export const PEAK_FARE_FACTOR = 1.3;
export const ESTIMATE_TTL_MIN = 5;
export const CANCEL_FEE = 5;
export const NO_DRIVER_PROB = 0.3;
export const NO_DRIVER_AFTER_MIN = 6;
/** 服务类型：打车（乘客坐平台的车）和代驾（司机来开乘客自己的车） */
export type Service = "打车" | "代驾";
export const DAIJIA = "代驾";
/** 代驾计价：按下单时刻分三档起步价（含 10 公里），超出部分每 5 公里加 20 元（不足 5 公里按 5 公里计） */
export const DAIJIA_BASE_KM = 10;
export const DAIJIA_STEP_KM = 5;
export const DAIJIA_STEP_FEE = 20;
export function daijiaBase(t: string) {
  const hm = t.slice(11, 16);
  return hm >= "06:00" && hm < "22:00" ? 36 : hm >= "22:00" ? 56 : 76;
}
export function daijiaFare(km: number, t: string) {
  return daijiaBase(t) + (km > DAIJIA_BASE_KM ? Math.ceil((km - DAIJIA_BASE_KM) / DAIJIA_STEP_KM) * DAIJIA_STEP_FEE : 0);
}
const DAIJIA_RULES = "起步价含 10 公里：06:00–22:00 为 36 元，22:00–24:00 为 56 元，00:00–06:00 为 76 元，以下单时刻为准；超出 10 公里后每 5 公里加收 20 元，不足 5 公里按 5 公里计。司机到达后免费等候 10 分钟，超出后每分钟 1 元。已开通免密支付的，代驾费在行程结束后自动扣款；未开通或超出免密限额的，行程结束后需在订单内手动支付。司机接单后取消，收取 5 元取消费。";
/** 场景可预置的派单结果：no_driver = 无司机接单，6 分钟后取消；accept = 一定有司机接单 */
export type ForcedDispatch = "no_driver" | "accept";
/** 场景可预置的代驾派单结果：driver_cancel = 司机接单若干分钟后取消订单；accept = 正常接单 */
export type ForcedDaijia = "driver_cancel" | "accept";
export const DRIVER_CANCEL_AFTER_MIN = 4;
export const DRIVER_CANCEL_REASON = "司机取消订单";
const SEATS: Record<CarType, number> = { 快车: 4, 优享: 4, 专车: 4, 六座: 6 };

/** 车费：rideFare(km) × 车型系数，高峰再 × 1.3，四舍五入到元 */
export function carFare(km: number, car: CarType, peak: boolean) {
  return Math.round(rideFare(km) * CAR_FACTOR[car] * (peak ? PEAK_FARE_FACTOR : 1));
}
/** 深夜：23:00–05:00 */
export function isLateNight(t: string) {
  const hm = t.slice(11, 16);
  return hm >= "23:00" || hm < "05:00";
}
/** 实时单派单结果用的随机流 key（深夜时第一个数 < 0.3 即无司机接单） */
export const dispatchKey = (order_id: string) => `${APP}:dispatch:${order_id}`;

export const STATUS = { WAITING: "等待接单", ACCEPTED: "司机已接单", ARRIVED: "司机已到达", ON_TRIP: "行程中", UNPAID: "待支付", DONE: "已完成", CANCELLED: "已取消" } as const;
const ACTIVE: string[] = [STATUS.WAITING, STATUS.ACCEPTED, STATUS.ARRIVED, STATUS.ON_TRIP];
const CANCEL_RULE = "司机接单前可免费取消。司机接单后取消，收取 5 元取消费。预约单在预约出发时间 30 分钟以前取消不收费。行程开始后不可取消。";
const PAY_RULE = "已开通免密支付的，行程结束后按实际费用自动扣款；未开通或超出免密单笔限额的，行程结束后订单为待支付，需手动完成支付。有待支付的订单时不能再次下单。";
/** 待支付的车费/取消费付款请求的有效期（过期后自动重新生成，欠费不会消失） */
export const UNPAID_TTL_MIN = 7 * 1440;

interface Driver { name: string; plate: string; car: string; phone_tail: string; rating: number }
export interface RideOrder {
  order_id: string;
  estimate_id: string | null;
  status: string;
  /** 服务类型：打车 / 代驾 */
  service: Service;
  /** 车型；代驾订单为 "代驾" */
  car_type: CarType | "代驾";
  scheduled: boolean;
  origin_poi_id: string | null;
  origin_name: string;
  origin_location: string;
  destination_poi_id: string | null;
  destination_name: string;
  destination_location: string;
  distance_km: number;
  duration_min: number;
  /** 下单时的预估价（券前） */
  est_fare: number;
  coupon_id: string | null;
  discount: number;
  /** 实付车费（完成后才有） */
  fare: number | null;
  cancel_fee: number;
  created_at: string;
  depart_at: string;
  accepted_at: string | null;
  arrived_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  pickup_note: string | null;
  driver: Driver | null;
  pay_request_id: string | null;
  paid_with: string | null;
  invoice_id: string | null;
  /** 内部：推进计划，不对外返回 */
  _plan: { accept_at: string; arrive_at: string; start_at: string; complete_at: string; no_driver_at: string | null; driver: Driver; driver_cancel_at?: string } | null;
}
interface RideCoupon {
  coupon_id: string;
  name: string;
  discount: string;
  valid_from: string;
  valid_to: string;
  rules: string;
  used_order: string | null;
  _limit: { kind: "pct" | "minus"; rate?: number; cap?: number; threshold?: number; amount?: number; car_types?: CarType[]; airport?: boolean; hours?: [string, string]; weekdays?: string[]; app_only?: boolean };
}

const st = (ctx: Ctx) => ctx.s[APP] as {
  estimates: Record<string, any>; orders: RideOrder[]; coupons: RideCoupon[]; invoices: any[]; saved_places: { label: string; poi_id: string }[];
  /** 场景预置：接下来若干个实时打车单的派单结果，按下单先后依次取用；用完后恢复随机派单 */
  dispatch_queue: ForcedDispatch[];
  /** 场景预置：接下来若干个代驾单的派单结果，按下单先后依次取用；没有预置时都正常接单 */
  daijia_queue?: ForcedDaijia[];
};

// ---------- 司机 ----------
const SURNAMES = ["王", "李", "张", "刘", "陈", "杨", "黄", "赵", "吴", "周", "徐", "孙", "马", "朱", "胡", "郭", "何", "林", "罗", "梁"];
const CARS: Record<CarType, string[]> = {
  快车: ["白色·启程 E5", "银色·翎风 A3", "白色·远帆 Q2", "灰色·启程 E3"],
  优享: ["白色·远帆 S5", "黑色·翎风 A6", "银色·启程 E7"],
  专车: ["黑色·远帆 S7", "黑色·云骁 L9", "黑色·翎风 A8"],
  六座: ["白色·云骁 M6", "灰色·远帆 V7", "黑色·启程 M5"],
};
const PLATE_CH = "ABCDEFGHJKLMNPQRSTUVWXYZ0123456789";
function makeDaijiaDriver(r: () => number): Driver {
  return { name: `${pick(r, SURNAMES)}师傅`, plate: "", car: `代驾司机·驾龄 ${int(r, 6, 22)} 年`, phone_tail: String(int(r, 1000, 9999)), rating: Math.round((4.8 + r() * 0.2) * 100) / 100 };
}
function makeDriver(r: () => number, city: string | null, car: CarType): Driver {
  const prefix = city === "深圳" ? "粤B" : city === "北京" ? "京A" : city === "成都" ? "川A" : "浙A";
  let tail = pick(r, ["D", "F", "A"]);
  for (let i = 0; i < 5; i++) tail += PLATE_CH[Math.floor(r() * PLATE_CH.length)];
  return { name: `${pick(r, SURNAMES)}师傅`, plate: `${prefix}·${tail}`, car: pick(r, CARS[car]), phone_tail: String(int(r, 1000, 9999)), rating: Math.round((4.7 + r() * 0.3) * 100) / 100 };
}

// ---------- 券 ----------
function initCoupons(): RideCoupon[] {
  const tomorrow = addDays(NOW, 1);
  return [
    { coupon_id: "KMC-5101", name: "7 折出行券", discount: "7 折，最高抵 15 元", valid_from: addDays(NOW, -6), valid_to: tomorrow, used_order: null,
      rules: "限快车、优享车型使用，按车费 7 折计算，单笔最高抵扣 15 元。有效期以行程出发时间为准，预约单按预约出发时间计算。每单限用一张，不找零、不兑现。",
      _limit: { kind: "pct", rate: 0.7, cap: 15, car_types: ["快车", "优享"] } },
    { coupon_id: "KMC-5102", name: "机场专享券", discount: "满 60 减 12", valid_from: "2026-11-15", valid_to: "2026-12-31", used_order: null,
      rules: "起点或终点为机场的订单可用（以平台识别的上下车点为准），车费满 60 元减 12 元。限快车、优享、专车车型。有效期以行程出发时间为准。每单限用一张。",
      _limit: { kind: "minus", threshold: 60, amount: 12, airport: true, car_types: ["快车", "优享", "专车"] } },
    { coupon_id: "KMC-4820", name: "夜间出行券", discount: "满 30 减 8", valid_from: "2026-11-01", valid_to: "2026-12-31", used_order: null,
      rules: "限出发时间在 22:00 至次日 05:00 之间的订单使用，车费满 30 元减 8 元。全部车型可用。每单限用一张。",
      _limit: { kind: "minus", threshold: 30, amount: 8, hours: ["22:00", "05:00"] } },
    { coupon_id: "KMC-4410", name: "双十一出行立减券", discount: "立减 10 元", valid_from: "2026-11-01", valid_to: "2026-11-20", used_order: null,
      rules: "车费满 10 元可用，全部车型可用。每单限用一张。",
      _limit: { kind: "minus", threshold: 10, amount: 10 } },
    { coupon_id: "KMC-5033", name: "专车体验券", discount: "满 80 减 25", valid_from: "2026-11-10", valid_to: "2026-12-15", used_order: null,
      rules: "仅限专车车型使用，车费满 80 元减 25 元。有效期以行程出发时间为准。每单限用一张。",
      _limit: { kind: "minus", threshold: 80, amount: 25, car_types: ["专车"] } },
    { coupon_id: "KMC-5140", name: "周末出行券", discount: "满 20 减 5", valid_from: "2026-11-20", valid_to: "2026-12-20", used_order: null,
      rules: "限出发时间在周六、周日的订单使用，车费满 20 元减 5 元。限快车车型。每单限用一张。",
      _limit: { kind: "minus", threshold: 20, amount: 5, weekdays: ["六", "日"], car_types: ["快车"] } },
    { coupon_id: "KMC-5166", name: "App 专享立减券", discount: "立减 6 元", valid_from: "2026-11-25", valid_to: "2026-12-25", used_order: null,
      rules: "仅限在快马出行 App 内下单时使用，其他渠道（含小程序、第三方助手）不可用。车费满 15 元可用，全部车型可用。",
      _limit: { kind: "minus", threshold: 15, amount: 6, app_only: true } },
  ];
}
const nearAirport = (ctx: Ctx, pt: { lng: number; lat: number }) => poiDb(ctx).some((p) => p.kind === "机场" && distanceKm(p, pt) <= 1.5);

/** 校验券并返回抵扣金额；不适用时抛错 */
function couponDiscount(ctx: Ctx, c: RideCoupon, e: any, car: CarType, price: number, depart_at: string): number {
  const no = (why: string) => new ToolError("COUPON_NOT_APPLICABLE", why);
  const L = c._limit;
  if (c.used_order) throw no("该券已使用");
  if (L.app_only) throw new ToolError("APP_ONLY", "该券仅限在快马出行 App 内使用");
  const day = depart_at.slice(0, 10);
  if (day < c.valid_from) throw no("出发时间早于该券的生效日期");
  if (day > c.valid_to) throw no("出发时间已超过该券的有效期");
  if (L.car_types && !L.car_types.includes(car)) throw no(`该券不适用于${car}车型`);
  if (L.airport && !nearAirport(ctx, e.origin) && !nearAirport(ctx, e.destination)) throw no("该券仅限起点或终点为机场的订单");
  if (L.hours) {
    const hm = depart_at.slice(11, 16);
    const [from, to] = L.hours;
    const ok = from <= to ? hm >= from && hm < to : hm >= from || hm < to;
    if (!ok) throw no("出发时间不在该券的可用时段内");
  }
  if (L.weekdays && !L.weekdays.includes(weekday(depart_at))) throw no("出发日期不在该券的可用日期内");
  if (L.kind === "pct") return Math.min(L.cap ?? Infinity, Math.round(price * (1 - (L.rate ?? 1))));
  if (price < (L.threshold ?? 0)) throw no(`车费未满 ${L.threshold} 元`);
  return Math.min(price, L.amount ?? 0);
}

// ---------- 历史订单 ----------
function initHistory(ctx: Ctx): RideOrder[] {
  const r = ctx.rng(`${APP}:history`);
  // 只用基础 POI（不含酒店库存并入的 H- 点），历史订单不随酒店数据和模块安装顺序变化
  const db = poiDb(ctx).filter((p) => !p.parent && !p.poi_id.startsWith("H-") && !isExtPoi(p));
  const hz = db.filter((p) => p.city === "杭州" && p.kind !== "机场" && p.poi_id !== HOME && p.poi_id !== OFFICE && !p.type.includes("地铁站") && distanceKm(p, getPoi(ctx, HOME)!) <= 25);
  const szCore = db.filter((p) => p.city === "深圳" && (p.kind === "写字楼" || p.kind === "酒店" || p.kind === "餐厅") && ["南山区", "福田区"].includes(p.district));
  const home = getPoi(ctx, HOME)!, office = getPoi(ctx, OFFICE)!, east = getPoi(ctx, AIRPORT.HGH_EAST)!, szx = getPoi(ctx, AIRPORT.SZX)!;
  const leisure = hz.filter((p) => p.kind === "餐厅" || p.type.startsWith("购物"));
  const hm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const rows: { at: string; a: MapPoi; b: MapPoi }[] = [];
  let guard = 0;
  while (rows.length < 60 && guard++ < 2000) {
    const day = addDays(NOW, -int(r, 1, 120));
    const x = r();
    let a: MapPoi, b: MapPoi, time: string;
    if (x < 0.18) { a = home; b = office; time = hm(int(r, 7, 9), int(r, 0, 59)); }
    else if (x < 0.36) { a = office; b = home; time = hm(int(r, 18, 22), int(r, 0, 59)); }
    else if (x < 0.43) { a = home; b = east; time = hm(int(r, 5, 16), int(r, 0, 59)); }
    else if (x < 0.5) { a = east; b = home; time = hm(int(r, 13, 23), int(r, 0, 59)); }
    else if (x < 0.6 && szCore.length >= 2) {
      const p1 = pick(r, szCore), p2 = pick(r, szCore);
      const y = r();
      if (y < 0.35) { a = szx; b = p1; } else if (y < 0.7) { a = p1; b = szx; } else { a = p1; b = p2; }
      time = hm(int(r, 8, 21), int(r, 0, 59));
    } else if (x < 0.82) {
      const p = pick(r, leisure.length ? leisure : hz);
      if (chance(r, 0.5)) { a = chance(r, 0.6) ? home : office; b = p; time = hm(int(r, 11, 19), int(r, 0, 59)); }
      else { a = p; b = home; time = hm(int(r, 13, 23), int(r, 0, 59)); }
    } else {
      const p = pick(r, hz);
      if (chance(r, 0.5)) { a = office; b = p; time = hm(int(r, 9, 17), int(r, 0, 59)); }
      else { a = p; b = chance(r, 0.5) ? office : home; time = hm(int(r, 10, 23), int(r, 0, 59)); }
    }
    const km = distanceKm(a, b);
    if (a.poi_id === b.poi_id || km < 1 || km > 80) continue;
    rows.push({ at: `${day} ${time}`, a, b });
  }
  rows.sort((m, n) => (m.at < n.at ? -1 : m.at > n.at ? 1 : 0));
  return rows.map(({ at, a, b }, i) => {
    const car: CarType = (() => { const x = r(); return x < 0.7 ? "快车" : x < 0.9 ? "优享" : x < 0.97 ? "专车" : "六座"; })();
    const km = distanceKm(a, b);
    const duration = driveMinutesAt(km, at);
    const est = carFare(km, car, isPeak(at));
    const accepted = addMin(at, int(r, 1, 4));
    const arrived = addMin(accepted, int(r, 2, 8));
    const started = addMin(arrived, int(r, 1, 2));
    const completed = addMin(started, duration);
    const driver = makeDriver(r, a.city, car);
    const x = r();
    const o: RideOrder = {
      order_id: ctx.id("KM"), estimate_id: null, status: STATUS.DONE, service: "打车", car_type: car, scheduled: false,
      origin_poi_id: a.poi_id, origin_name: a.name, origin_location: `${a.lng},${a.lat}`,
      destination_poi_id: b.poi_id, destination_name: b.name, destination_location: `${b.lng},${b.lat}`,
      distance_km: km, duration_min: duration, est_fare: est, coupon_id: null, discount: 0, fare: est, cancel_fee: 0,
      created_at: at, depart_at: at, accepted_at: accepted, arrived_at: arrived, started_at: started, completed_at: completed,
      cancelled_at: null, cancel_reason: null, pickup_note: null, driver, pay_request_id: null, paid_with: DEFAULT_CARD, invoice_id: null, _plan: null,
    };
    if (x < 0.04) {
      const noDriver = isLateNight(at) || chance(r, 0.3);
      Object.assign(o, { status: STATUS.CANCELLED, fare: null, accepted_at: null, arrived_at: null, started_at: null, completed_at: null, driver: null, paid_with: null,
        cancelled_at: addMin(at, noDriver ? NO_DRIVER_AFTER_MIN : int(r, 1, 3)), cancel_reason: noDriver ? "无司机接单，已取消" : "乘客取消" });
    } else if (x < 0.07) {
      Object.assign(o, { status: STATUS.CANCELLED, fare: null, arrived_at: null, started_at: null, completed_at: null, cancel_fee: CANCEL_FEE,
        cancelled_at: addMin(accepted, int(r, 1, 4)), cancel_reason: "乘客取消" });
    } else {
      if (x < 0.22) { o.coupon_id = `KMC-${int(r, 3100, 4399)}`; o.discount = Math.min(est - 1, pick(r, [3, 5, 5, 6, 8, 10])); o.fare = est - o.discount; }
      if (i % 9 === 4) o.invoice_id = `KMI${int(r, 10000000, 99999999)}`;
    }
    return o;
  });
}

// ---------- 状态推进 ----------
/** 行程结束（或产生取消费）后的收款：免密签约生效且在限额内 → 经回声支付免密从银行卡扣款；否则生成待支付的付款请求。返回是否已付清。 */
function collect(ctx: Ctx, o: RideOrder, amount: number, merchant: string): boolean {
  const contract = ctx.s.pay?.contracts && payApi.autoCharge ? payApi.freePay(ctx, APP) : null;
  if (contract && amount <= Number(contract.limit)) {
    const res = payApi.autoCharge(ctx, { app: APP, order_id: o.order_id, merchant, amount });
    if (res.ok) {
      o.pay_request_id = res.pay_request_id ?? null;
      o.paid_with = res.paid_with ?? contract.method;
      return true;
    }
  }
  const req = ctx.createPaymentRequest({ app: APP, order_id: o.order_id, merchant, amount, expires_in_min: UNPAID_TTL_MIN });
  o.pay_request_id = req.id;
  o.paid_with = null;
  return false;
}
/** 有没有还没付的钱（车费、代驾费或取消费） */
const unpaid = (o: RideOrder) => !!o.pay_request_id && !o.paid_with;
const lastDigits = (card_id: string | null) => String(card_id ?? "").replace(/\D/g, "").slice(-4);
function releaseCoupon(ctx: Ctx, o: RideOrder) {
  if (!o.coupon_id) return;
  const c = st(ctx).coupons.find((x) => x.coupon_id === o.coupon_id);
  if (c && c.used_order === o.order_id) c.used_order = null;
}
function advance(ctx: Ctx) {
  const s = st(ctx);
  if (!s) return;
  const now = ctx.now();
  for (const o of s.orders) {
    const plan = o._plan;
    if (!plan) continue;
    for (let step = 0; step < 5; step++) {
      if (o.status === STATUS.WAITING) {
        if (plan.no_driver_at) {
          if (now < plan.no_driver_at) break;
          o.status = STATUS.CANCELLED;
          o.cancelled_at = plan.no_driver_at;
          o.cancel_reason = "无司机接单，已取消";
          o._plan = null;
          releaseCoupon(ctx, o);
          ctx.push({ app: APP, title: "订单已取消", text: `附近暂无司机接单，${o.origin_name}到${o.destination_name}的订单已取消。` });
          break;
        }
        if (now < plan.accept_at) break;
        o.status = STATUS.ACCEPTED;
        o.accepted_at = plan.accept_at;
        o.driver = plan.driver;
        if (o.service === DAIJIA) ctx.push({ app: APP, title: "代驾司机已接单", text: `${plan.driver.name}已接单，正在前往${o.origin_name}，尾号 ${plan.driver.phone_tail}。` });
        else ctx.push({ app: APP, title: "司机已接单", text: o.scheduled ? `${plan.driver.name}已接预约单，${plan.driver.car}，${plan.driver.plate}，将于 ${o.depart_at.slice(5)} 前到达上车点。` : `${plan.driver.name}正在赶来，${plan.driver.car}，${plan.driver.plate}。` });
      } else if (o.status === STATUS.ACCEPTED) {
        if (plan.driver_cancel_at) {
          if (now < plan.driver_cancel_at) break;
          o.status = STATUS.CANCELLED;
          o.cancelled_at = plan.driver_cancel_at;
          o.cancel_reason = DRIVER_CANCEL_REASON;
          o._plan = null;
          ctx.push({ app: APP, title: "订单已取消", text: `${plan.driver.name}取消了${o.origin_name}到${o.destination_name}的${o.service === DAIJIA ? "代驾" : ""}订单，本单不收取费用。如仍需服务请重新呼叫。` });
          break;
        }
        if (now < plan.arrive_at) break;
        o.status = STATUS.ARRIVED;
        o.arrived_at = plan.arrive_at;
        ctx.push({ app: APP, title: "司机已到达", text: o.service === DAIJIA ? `代驾司机${plan.driver.name}已到达${o.origin_name}，尾号 ${plan.driver.phone_tail}。` : `${plan.driver.name}已到达上车点（${o.origin_name}），${plan.driver.plate}，尾号 ${plan.driver.phone_tail}。` });
      } else if (o.status === STATUS.ARRIVED) {
        if (now < plan.start_at) break;
        o.status = STATUS.ON_TRIP;
        o.started_at = plan.start_at;
      } else if (o.status === STATUS.ON_TRIP) {
        if (now < plan.complete_at) break;
        o.completed_at = plan.complete_at;
        o.fare = Math.max(0, o.est_fare - o.discount);
        o._plan = null;
        const what = o.service === DAIJIA ? "代驾费" : "车费";
        const paid = o.fare > 0 ? collect(ctx, o, o.fare, o.service === DAIJIA ? `${MERCHANT}（代驾）` : MERCHANT) : true;
        o.status = paid ? STATUS.DONE : STATUS.UNPAID;
        if (paid) ctx.push({ app: APP, title: "行程已结束", text: o.fare > 0 ? `已到达${o.destination_name}，${what} ${o.fare} 元已通过免密支付扣款（尾号 ${lastDigits(o.paid_with)}）。` : `已到达${o.destination_name}，本单无需支付。` });
        else ctx.push({ app: APP, title: "行程已结束，待支付", text: `已到达${o.destination_name}，${what} ${o.fare} 元待支付，请在订单内完成支付。` });
        break;
      } else break;
    }
  }
}

// ---------- 对外视图 ----------
const brief = (o: RideOrder) => ({
  order_id: o.order_id, status: o.status, service: o.service, car_type: o.car_type, order_type: o.scheduled ? "预约" : "实时",
  origin_name: o.origin_name, destination_name: o.destination_name, depart_at: o.depart_at,
  fare: o.fare ?? (o.status === STATUS.CANCELLED ? o.cancel_fee : null),
  ...(unpaid(o) ? { pay_status: "待支付" } : {}),
});
function view(ctx: Ctx, o: RideOrder) {
  const { _plan, scheduled, ...rest } = o;
  const out: Record<string, unknown> = { ...rest, order_type: scheduled ? "预约" : "实时" };
  // 接单后又要取消的司机没有在往上车点走：预计到达时间不降反升
  if (_plan && o.status === STATUS.ACCEPTED) out.pickup_eta_min = Math.max(0, minutesBetween(ctx.now(), _plan.arrive_at)) + (_plan.driver_cancel_at && o.accepted_at ? 2 * Math.max(0, minutesBetween(o.accepted_at, ctx.now())) : 0);
  if (_plan && o.status === STATUS.ON_TRIP) out.eta_arrive_at = _plan.complete_at;
  out.pay_status = o.paid_with ? "已支付" : o.pay_request_id ? "待支付" : null;
  if (unpaid(o)) out.amount_due = o.status === STATUS.CANCELLED ? o.cancel_fee : o.fare;
  out.cancel_rule = CANCEL_RULE;
  out.pay_rule = PAY_RULE;
  if (o.service === DAIJIA) out.fee_rules = DAIJIA_RULES;
  return out;
}
const findOrder = (ctx: Ctx, id: unknown) => {
  const o = st(ctx).orders.find((x) => x.order_id === String(id ?? "").trim());
  if (!o) throw new ToolError("ORDER_NOT_FOUND", "没有找到这个订单");
  return o;
};
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;
const place = (l: { lng: number; lat: number; name: string; poi_id: string | null }) => ({ poi_id: l.poi_id, name: l.name, location: `${l.lng},${l.lat}` });

const tools: Tool[] = [
  {
    name: `${APP}.estimate`,
    description: "预估一段行程各车型的价格和接驾时间，返回预估单号。",
    params: { origin: "string，上车点：poi_id 或 \"经度,纬度\"", destination: "string，目的地：poi_id 或 \"经度,纬度\"", "depart_at?": "string，出发时刻 YYYY-MM-DD HH:MM，默认现在" },
    effect: "read",
    run(ctx, p) {
      need(p, "origin", "destination");
      const a = resolveLocation(ctx, p.origin), b = resolveLocation(ctx, p.destination);
      const now = ctx.now();
      let depart_at = now, scheduled = false;
      if (p.depart_at !== undefined && p.depart_at !== null && p.depart_at !== "") {
        const t = String(p.depart_at).trim();
        if (!TIME.test(t) || Number.isNaN(toMs(t))) throw new ToolError("INVALID_PARAM", "时刻格式应为 YYYY-MM-DD HH:MM");
        const ahead = minutesBetween(now, t);
        if (ahead < -1) throw new ToolError("INVALID_PARAM", "出发时间不能早于当前时间");
        if (ahead > 30) { scheduled = true; depart_at = t; }
      }
      const km = distanceKm(a, b);
      if (km < 0.3) throw new ToolError("TOO_CLOSE", "起点和终点距离过近");
      const ca = cityAt(ctx, a), cb = cityAt(ctx, b);
      if (!ca || !cb || ca !== cb || km > 150) throw new ToolError("OUT_OF_SERVICE_AREA", "起点或终点不在同一服务城市内");
      const estimate_id = ctx.id("EST");
      const r = ctx.rng(`${APP}:estimate:${estimate_id}`);
      const peak = isPeak(depart_at);
      const late = isLateNight(depart_at) ? 3 : 0;
      const eta: Record<CarType, number> = { 快车: int(r, 2, 6) + late, 优享: int(r, 3, 7) + late, 专车: int(r, 4, 9) + late, 六座: int(r, 5, 12) + late };
      const options = CAR_TYPES.map((car) => ({ car_type: car, seats: SEATS[car], price: carFare(km, car, peak), pickup_eta_min: scheduled ? null : eta[car] }));
      const e = {
        estimate_id, created_at: now, expires_at: addMin(now, ESTIMATE_TTL_MIN), scheduled, depart_at, city: ca,
        origin: a, destination: b, distance_km: km, duration_min: driveMinutesAt(km, depart_at), peak, options, eta, order_id: null as string | null,
      };
      st(ctx).estimates[estimate_id] = e;
      return {
        estimate_id, expires_at: e.expires_at, order_type: scheduled ? "预约" : "实时", depart_at,
        origin: place(a), destination: place(b), distance_km: km, duration_min: e.duration_min, peak_pricing: peak, options,
      };
    },
  },
  {
    name: `${APP}.create_order`,
    description: "按预估单号和所选车型叫车，可选用一张优惠券。",
    params: { estimate_id: "string，预估单号", car_type: "string，车型：快车 / 优享 / 专车 / 六座", "coupon_id?": "string，优惠券 ID", "pickup_note?": "string，给司机的上车备注" },
    effect: "write",
    run(ctx, p) {
      need(p, "estimate_id", "car_type");
      const s = st(ctx);
      const e = s.estimates[String(p.estimate_id).trim()];
      if (!e || e.service === DAIJIA) throw new ToolError("ESTIMATE_NOT_FOUND", "预估单号不存在");
      const now = ctx.now();
      if (now >= e.expires_at) throw new ToolError("QUOTE_EXPIRED", "预估已过期，请重新预估");
      if (e.order_id) throw new ToolError("ESTIMATE_USED", "该预估单号已用于下单");
      const car = String(p.car_type).trim() as CarType;
      if (!CAR_TYPES.includes(car)) throw new ToolError("INVALID_PARAM", "car_type 应为 快车、优享、专车、六座 之一");
      if (s.orders.some(unpaid)) throw new ToolError("UNPAID_ORDER", "有待支付的订单，请先完成支付后再叫车");
      if (!e.scheduled && s.orders.some((o) => o.service !== DAIJIA && !o.scheduled && ACTIVE.includes(o.status))) throw new ToolError("ORDER_IN_PROGRESS", "有进行中的订单，暂时无法再次叫车");
      const depart_at: string = e.scheduled ? e.depart_at : now;
      if (e.scheduled && minutesBetween(now, depart_at) <= 30) throw new ToolError("QUOTE_EXPIRED", "预约出发时间已不足 30 分钟，请重新预估");
      const price: number = e.options.find((x: any) => x.car_type === car).price;
      let coupon: RideCoupon | null = null, discount = 0;
      if (p.coupon_id !== undefined && p.coupon_id !== null && p.coupon_id !== "") {
        coupon = s.coupons.find((c) => c.coupon_id === String(p.coupon_id).trim()) ?? null;
        if (!coupon) throw new ToolError("COUPON_NOT_FOUND", "没有找到这张优惠券");
        discount = couponDiscount(ctx, coupon, e, car, price, depart_at);
      }
      const order_id = ctx.id("KM");
      const r = ctx.rng(dispatchKey(order_id));
      const roll = r();
      const accept_at = addMin(now, int(r, 1, 4));
      const driver = makeDriver(r, e.city, car);
      const forced = e.scheduled ? undefined : s.dispatch_queue?.shift();
      const no_driver = forced ? forced === "no_driver" : !e.scheduled && isLateNight(now) && roll < NO_DRIVER_PROB;
      const arrive_at = e.scheduled ? addMin(depart_at, -3) : addMin(accept_at, e.eta[car]);
      const start_at = e.scheduled ? depart_at : addMin(arrive_at, int(r, 1, 2));
      const o: RideOrder = {
        order_id, estimate_id: e.estimate_id, status: STATUS.WAITING, service: "打车", car_type: car, scheduled: e.scheduled,
        origin_poi_id: e.origin.poi_id, origin_name: e.origin.name, origin_location: `${e.origin.lng},${e.origin.lat}`,
        destination_poi_id: e.destination.poi_id, destination_name: e.destination.name, destination_location: `${e.destination.lng},${e.destination.lat}`,
        distance_km: e.distance_km, duration_min: e.duration_min, est_fare: price, coupon_id: coupon?.coupon_id ?? null, discount, fare: null, cancel_fee: 0,
        created_at: now, depart_at, accepted_at: null, arrived_at: null, started_at: null, completed_at: null, cancelled_at: null, cancel_reason: null,
        pickup_note: p.pickup_note ? String(p.pickup_note).slice(0, 100) : null, driver: null, pay_request_id: null, paid_with: null, invoice_id: null,
        _plan: { accept_at, arrive_at, start_at, complete_at: addMin(start_at, e.duration_min), no_driver_at: no_driver ? addMin(now, NO_DRIVER_AFTER_MIN) : null, driver },
      };
      s.orders.push(o);
      e.order_id = order_id;
      if (coupon) coupon.used_order = order_id;
      return { order_id, status: o.status, order_type: o.scheduled ? "预约" : "实时", car_type: car, depart_at, origin_name: o.origin_name, destination_name: o.destination_name, est_fare: price, discount, est_pay: Math.max(0, price - discount) };
    },
  },
  {
    name: `${APP}.estimate_daijia`,
    description: "预估代驾服务的费用和司机到达时间，返回预估单号。代驾司机到达后驾驶乘客的车前往目的地。",
    params: { origin: "string，车辆所在位置：poi_id 或 \"经度,纬度\"", destination: "string，目的地：poi_id 或 \"经度,纬度\"" },
    effect: "read",
    run(ctx, p) {
      need(p, "origin", "destination");
      const a = resolveLocation(ctx, p.origin), b = resolveLocation(ctx, p.destination);
      const now = ctx.now();
      const km = distanceKm(a, b);
      if (km < 0.3) throw new ToolError("TOO_CLOSE", "起点和终点距离过近");
      const ca = cityAt(ctx, a), cb = cityAt(ctx, b);
      if (!ca || !cb || ca !== cb || km > 80) throw new ToolError("OUT_OF_SERVICE_AREA", "起点或终点不在代驾服务范围内");
      const estimate_id = ctx.id("DJE");
      const r = ctx.rng(`${APP}:estimate:${estimate_id}`);
      const price = daijiaFare(km, now);
      const eta = int(r, 6, 14);
      const e = {
        estimate_id, service: DAIJIA, created_at: now, expires_at: addMin(now, ESTIMATE_TTL_MIN), scheduled: false, depart_at: now, city: ca,
        origin: a, destination: b, distance_km: km, duration_min: driveMinutesAt(km, now), price, eta, order_id: null as string | null,
      };
      st(ctx).estimates[estimate_id] = e;
      return {
        estimate_id, expires_at: e.expires_at, service: DAIJIA, origin: place(a), destination: place(b), distance_km: km, duration_min: e.duration_min,
        price, driver_eta_min: eta, fee_rules: DAIJIA_RULES,
      };
    },
  },
  {
    name: `${APP}.create_daijia_order`,
    description: "按预估单号呼叫代驾司机。",
    params: { estimate_id: "string，代驾预估单号", "note?": "string，给代驾司机的备注，如车辆停放位置、车牌" },
    effect: "write",
    run(ctx, p) {
      need(p, "estimate_id");
      const s = st(ctx);
      const e = s.estimates[String(p.estimate_id).trim()];
      if (!e || e.service !== DAIJIA) throw new ToolError("ESTIMATE_NOT_FOUND", "预估单号不存在");
      const now = ctx.now();
      if (now >= e.expires_at) throw new ToolError("QUOTE_EXPIRED", "预估已过期，请重新预估");
      if (e.order_id) throw new ToolError("ESTIMATE_USED", "该预估单号已用于下单");
      if (s.orders.some(unpaid)) throw new ToolError("UNPAID_ORDER", "有待支付的订单，请先完成支付后再呼叫");
      if (s.orders.some((o) => o.service === DAIJIA && ACTIVE.includes(o.status))) throw new ToolError("ORDER_IN_PROGRESS", "有进行中的代驾订单，暂时无法再次呼叫");
      const order_id = ctx.id("DJ");
      const r = ctx.rng(dispatchKey(order_id));
      const accept_at = addMin(now, int(r, 1, 3));
      const driver = makeDaijiaDriver(r);
      const arrive_at = addMin(accept_at, e.eta);
      const start_at = addMin(arrive_at, int(r, 2, 4));
      const o: RideOrder = {
        order_id, estimate_id: e.estimate_id, status: STATUS.WAITING, service: DAIJIA, car_type: DAIJIA, scheduled: false,
        origin_poi_id: e.origin.poi_id, origin_name: e.origin.name, origin_location: `${e.origin.lng},${e.origin.lat}`,
        destination_poi_id: e.destination.poi_id, destination_name: e.destination.name, destination_location: `${e.destination.lng},${e.destination.lat}`,
        distance_km: e.distance_km, duration_min: e.duration_min, est_fare: e.price, coupon_id: null, discount: 0, fare: null, cancel_fee: 0,
        created_at: now, depart_at: now, accepted_at: null, arrived_at: null, started_at: null, completed_at: null, cancelled_at: null, cancel_reason: null,
        pickup_note: p.note ? String(p.note).slice(0, 100) : null, driver: null, pay_request_id: null, paid_with: null, invoice_id: null,
        _plan: { accept_at, arrive_at, start_at, complete_at: addMin(start_at, e.duration_min), no_driver_at: null, driver },
      };
      if (s.daijia_queue?.shift() === "driver_cancel") o._plan!.driver_cancel_at = addMin(accept_at, DRIVER_CANCEL_AFTER_MIN);
      s.orders.push(o);
      e.order_id = order_id;
      return { order_id, status: o.status, service: DAIJIA, origin_name: o.origin_name, destination_name: o.destination_name, est_fare: e.price, driver_eta_min: e.eta };
    },
  },
  {
    name: `${APP}.get_order`,
    description: "查询订单详情和当前状态。",
    params: { order_id: "string，订单号" },
    effect: "read",
    run(ctx, p) {
      need(p, "order_id");
      return view(ctx, findOrder(ctx, p.order_id));
    },
  },
  {
    name: `${APP}.cancel_order`,
    description: "取消订单。",
    params: { order_id: "string，订单号" },
    effect: "write",
    run(ctx, p) {
      need(p, "order_id");
      const o = findOrder(ctx, p.order_id);
      if (o.status === STATUS.ON_TRIP) throw new ToolError("NOT_CANCELLABLE", "行程已开始，无法取消");
      if (o.status === STATUS.DONE || o.status === STATUS.CANCELLED || o.status === STATUS.UNPAID) throw new ToolError("INVALID_STATUS", o.status === STATUS.UNPAID ? "行程已结束，无法取消" : `订单${o.status}，无法取消`);
      const now = ctx.now();
      const accepted = o.status !== STATUS.WAITING;
      const fee = accepted && !(o.scheduled && minutesBetween(now, o.depart_at) > 30) ? CANCEL_FEE : 0;
      o.status = STATUS.CANCELLED;
      o.cancelled_at = now;
      o.cancel_reason = "乘客取消";
      o.cancel_fee = fee;
      o._plan = null;
      releaseCoupon(ctx, o);
      const paid = fee > 0 ? collect(ctx, o, fee, `${MERCHANT}（${o.service === DAIJIA ? "代驾" : ""}取消费）`) : true;
      return { order_id: o.order_id, status: o.status, cancel_fee: fee, pay_request_id: o.pay_request_id, ...(fee > 0 ? { pay_status: paid ? "已支付" : "待支付" } : {}) };
    },
  },
  {
    name: `${APP}.list_orders`,
    description: "查看我的订单（含打车和代驾），按时间由近到远排列。",
    params: { "status?": "string，按状态筛选：等待接单 / 司机已接单 / 司机已到达 / 行程中 / 待支付 / 已完成 / 已取消", "page?": "number，页码，默认 1" },
    effect: "read",
    run(ctx, p) {
      let list = [...st(ctx).orders];
      if (p.status !== undefined && p.status !== null && p.status !== "") {
        const want = String(p.status).trim();
        if (!(Object.values(STATUS) as string[]).includes(want)) throw new ToolError("INVALID_PARAM", "status 取值无效");
        list = list.filter((o) => o.status === want);
      }
      list.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.order_id < b.order_id ? 1 : -1));
      return paginate(list.map(brief), p.page);
    },
  },
  {
    name: `${APP}.list_coupons`,
    description: "查看券包里的优惠券。",
    params: {},
    effect: "read",
    run(ctx) {
      return { coupons: st(ctx).coupons.map((c) => ({ coupon_id: c.coupon_id, name: c.name, discount: c.discount, valid_from: c.valid_from, valid_to: c.valid_to, rules: c.rules, status: c.used_order ? "已使用" : "未使用" })) };
    },
  },
  {
    name: `${APP}.list_saved_places`,
    description: "查看收藏的常用地址。",
    params: {},
    effect: "read",
    run(ctx) {
      return {
        places: st(ctx).saved_places.map((x) => {
          const poi = getPoi(ctx, x.poi_id);
          return { label: x.label, poi_id: x.poi_id, name: poi?.name ?? null, address: poi ? `${poi.city}市${poi.address}` : null };
        }),
      };
    },
  },
  {
    name: `${APP}.request_invoice`,
    description: "为已完成的订单申请电子发票（行程单随发票一并提供）。",
    params: { order_id: "string，订单号", "title?": "string，发票抬头，默认为个人" },
    effect: "write",
    run(ctx, p) {
      need(p, "order_id");
      const o = findOrder(ctx, p.order_id);
      if (o.status !== STATUS.DONE) throw new ToolError("NOT_AVAILABLE_YET", "订单完成后才能开具发票");
      if (o.invoice_id) throw new ToolError("ALREADY_INVOICED", "该订单已开具发票");
      if (!o.fare) throw new ToolError("NOT_INVOICEABLE", "该订单没有可开票金额");
      const title = p.title ? String(p.title).trim().slice(0, 60) : `个人（${PERSONA.name}）`;
      const inv = { invoice_id: ctx.id("KMI"), order_id: o.order_id, title, amount: o.fare, item: "客运服务费", issued_at: ctx.now(), with_itinerary: true };
      st(ctx).invoices.push(inv);
      o.invoice_id = inv.invoice_id;
      ctx.push({ app: APP, title: "电子发票已开具", text: `订单 ${o.order_id} 的电子发票和行程单已开具，抬头：${title}，金额 ${o.fare} 元。` });
      return inv;
    },
  },
];

export const ride: Module = {
  app: APP,
  title: "快马出行",
  init(ctx) {
    ctx.s[APP] = {
      estimates: {},
      orders: initHistory(ctx),
      coupons: initCoupons(),
      invoices: [],
      saved_places: [{ label: "家", poi_id: HOME }, { label: "公司", poi_id: OFFICE }],
      dispatch_queue: [],
    };
  },
  tools,
  tick: advance,
  onPayment(ctx, req) {
    // 待支付的车费/取消费：用户在回声支付确认后才算付清；请求过期则重新生成一笔，欠费仍在
    const o = st(ctx)?.orders.find((x) => x.order_id === req.order_id);
    if (!o || o.pay_request_id !== req.id || o.paid_with) return;
    if (req.status === "paid") {
      o.paid_with = req.paid_with ?? DEFAULT_CARD;
      if (o.status === STATUS.UNPAID) o.status = STATUS.DONE;
      ctx.push({ app: APP, title: "支付成功", text: `订单 ${o.order_id} 已支付 ${req.amount} 元。` });
    } else if (req.status === "expired" || req.status === "declined") {
      const again = ctx.createPaymentRequest({ app: APP, order_id: o.order_id, merchant: req.merchant, amount: req.amount, expires_in_min: UNPAID_TTL_MIN });
      o.pay_request_id = again.id;
    }
  },
};

export default ride;
