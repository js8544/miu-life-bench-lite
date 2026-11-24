// 航迹（行程管家）：汇总用户名下各渠道已出票的航班行程，并提供航班动态查询。
import { ToolError, need, paginate } from "../core.ts";
import type { Ctx, Module } from "../core.ts";
import { AIRLINES, SEED } from "../facts.ts";
import { aircraftOf, airportCity, airportName, flightsOn, stopCity } from "../data/flights.ts";
import { AIRLINE_APPS, flightDynamics } from "./airline.ts";

// 旅行平台模块可能还没装：有就读它导出的机票订单，没有就跳过
let yuntuFlightOrders: ((ctx: Ctx) => any[]) | null = null;
try {
  const m: any = await import("./yuntu.ts");
  if (typeof m.yuntuFlightOrders === "function") yuntuFlightOrders = m.yuntuFlightOrders;
} catch {
  yuntuFlightOrders = null;
}

function mulHash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

interface Trip {
  source: string;
  order_id: string;
  flight_no: string;
  date: string;
  passenger: string;
  cabin: string;
}

function collect(ctx: Ctx): Trip[] {
  const out: Trip[] = [];
  for (const code of ["DY", "BC", "HX"] as const) {
    const orders = ctx.s[AIRLINE_APPS[code]]?.orders;
    if (!Array.isArray(orders)) continue;
    for (const o of orders) if (o.status === "已出票") out.push({ source: `${AIRLINES[code].name}官方渠道`, order_id: o.order_id, flight_no: o.flight_no, date: o.date, passenger: o.passenger_name, cabin: o.cabin_name });
  }
  if (ctx.s.yuntu) {
    let list: any[] = [];
    try {
      list = (yuntuFlightOrders ? yuntuFlightOrders(ctx) : ctx.s.yuntu.orders) ?? [];
    } catch {
      list = [];
    }
    for (const o of Array.isArray(list) ? list : [])
      if (o && typeof o.flight_no === "string" && typeof o.date === "string" && String(o.status ?? "").includes("已出票"))
        out.push({ source: "云途旅行", order_id: String(o.order_id ?? ""), flight_no: o.flight_no, date: o.date, passenger: String(o.passenger_name ?? o.passenger ?? ""), cabin: String(o.cabin_name ?? o.cabin ?? "") });
  }
  return out.sort((a, b) => (a.date + a.flight_no).localeCompare(b.date + b.flight_no));
}

function statusOf(ctx: Ctx, flight_no: string, date: string) {
  const f = flightsOn(SEED, date).find((x) => x.flight_no === flight_no);
  if (!f) return null;
  const dyn = flightDynamics(ctx, f);
  return { f, dyn };
}

export const hangji: Module = {
  app: "hangji",
  title: "航迹行程管家",
  init(ctx) {
    ctx.s.hangji = { followed: [] };
  },
  tools: [
    {
      name: "hangji.list_trips",
      description: "列出当前用户名下已出票的航班行程及其动态。",
      params: { "page?": "页码，从 1 开始，每页 10 条" },
      effect: "read",
      run(ctx, p) {
        const pg = paginate(collect(ctx), p.page);
        return {
          ...pg,
          items: pg.items.map((t) => {
            const st = statusOf(ctx, t.flight_no, t.date);
            const base: any = { source: t.source, order_id: t.order_id, flight_no: t.flight_no, date: t.date, passenger: t.passenger, cabin: t.cabin };
            if (!st) return { ...base, status: "暂无动态" };
            return { ...base, from_airport: airportName(st.f.from_airport), to_airport: airportName(st.f.to_airport), scheduled_dep: st.dyn.scheduled_dep, scheduled_arr: st.dyn.scheduled_arr, status: st.dyn.status, delay_minutes: st.dyn.delay_minutes, est_dep: st.dyn.est_dep, est_arr: st.dyn.est_arr };
          }),
        };
      },
    },
    {
      name: "hangji.get_flight_status",
      description: "查询某个航班某天的实时动态。",
      params: { flight_no: "字符串，航班号", date: "日期 YYYY-MM-DD" },
      effect: "read",
      run(ctx, p) {
        need(p, "flight_no", "date");
        const date = String(p.date);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z"))) throw new ToolError("INVALID_DATE", "日期格式应为 YYYY-MM-DD");
        const st = statusOf(ctx, String(p.flight_no).toUpperCase(), date);
        if (!st) throw new ToolError("FLIGHT_NOT_FOUND", `${date} 没有航班 ${p.flight_no}`);
        const { f, dyn } = st;
        const h = mulHash(`${f.operated_by ?? f.flight_no}:${date}`);
        const out: any = {
          flight_no: f.flight_no, airline: AIRLINES[f.airline].name, date,
          from_airport: { poi_id: f.from_airport, name: airportName(f.from_airport), city: airportCity(f.from_airport) },
          to_airport: { poi_id: f.to_airport, name: airportName(f.to_airport), city: airportCity(f.to_airport) },
          stops: f.stops,
        };
        if (f.stops) out.stop_city = stopCity(f.flight_no);
        if (f.operated_by) out.operated_by = `${AIRLINES[f.operated_by.slice(0, 2) as "DY" | "BC" | "HX"].name} ${f.operated_by}`;
        Object.assign(out, {
          aircraft: aircraftOf(f.operated_by ?? f.flight_no), status: dyn.status, delay_minutes: dyn.delay_minutes,
          scheduled_dep: dyn.scheduled_dep, scheduled_arr: dyn.scheduled_arr, est_dep: dyn.est_dep, est_arr: dyn.est_arr,
          checkin_counter: `${"ABCDEFGH"[h % 8]} 岛`, gate: `${"ABC"[(h >>> 3) % 3]}${10 + ((h >>> 5) % 40)}`, baggage_belt: String(1 + ((h >>> 11) % 12)),
          checkin_closes: "起飞前 45 分钟",
        });
        return out;
      },
    },
  ],
};

export default hangji;
