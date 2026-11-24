// 航班库存：固定时刻表（由 seed 决定）+ 按日期浮动的价格和余票。纯函数，不读写世界状态。
import { mulberry, int, toMs } from "../core/core.ts";
import { AIRPORT, GOLDEN_FLIGHTS, POIS, TRIP } from "./facts.ts";
import type { Cabin, Flight } from "./facts.ts";

type Air = Flight["airline"];

/** 本数据文件新增的两个机场（facts.POIS 里没有），地图模块如需可引用 */
export const EXTRA_AIRPORTS = [
  { poi_id: "B0BJ00001", name: "北京燕都国际机场", city: "北京", district: "顺义区", address: "顺义区航安路 6 号", lng: 116.5871, lat: 40.0725, kind: "机场" as const },
  { poi_id: "B0CD00001", name: "成都锦川国际机场", city: "成都", district: "双流区", address: "双流区临空大道 88 号", lng: 103.9562, lat: 30.5703, kind: "机场" as const },
];
const BJ = "B0BJ00001";
const CD = "B0CD00001";

/** 机场 poi_id → 名称、城市 */
export const AIRPORT_INFO: Record<string, { name: string; city: string }> = {};
for (const p of [...POIS, ...EXTRA_AIRPORTS]) if (p.kind === "机场") AIRPORT_INFO[p.poi_id] = { name: p.name, city: p.city };
export const FLIGHT_CITIES = ["杭州", "深圳", "北京", "成都"];
export const airportName = (poi_id: string) => AIRPORT_INFO[poi_id]?.name ?? poi_id;
export const airportCity = (poi_id: string) => AIRPORT_INFO[poi_id]?.city ?? "";

const STOP_CITIES = ["南昌", "长沙", "赣州", "厦门", "武汉"];
const AIRCRAFT = ["空客 A320neo", "空客 A321", "波音 737-800", "空客 A330-300", "国产 C919"];

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
const r10 = (x: number) => Math.round(x / 10) * 10;
const toMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
const hm = (m: number) => `${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

/** 经停航班的经停城市（由航班号决定） */
export const stopCity = (flight_no: string) => STOP_CITIES[hash("stop" + flight_no) % STOP_CITIES.length];
export const aircraftOf = (flight_no: string) => AIRCRAFT[hash("ac" + flight_no) % AIRCRAFT.length];
/** 飞行总时长（分钟），到达时刻早于起飞时刻的视为次日到达 */
export const durationMin = (f: { dep: string; arr: string }) => (toMin(f.arr) - toMin(f.dep) + 1440) % 1440;
/** 计划起飞、到达的完整时刻 */
export function schedule(f: { date: string; dep: string; arr: string }) {
  const dep_at = `${f.date} ${f.dep}`;
  const ms = toMs(dep_at) + durationMin(f) * 60000;
  return { dep_at, arr_at: new Date(ms).toISOString().slice(0, 16).replace("T", " ") };
}

interface Slot {
  no: string;
  airline: Air;
  from: string;
  to: string;
  dep: number;
  dur: number;
  stops: 0 | 1;
  op?: string;
  std: number;
  special: number;
}

const tableCache = new Map<number, Slot[]>();

function timetable(seed: number): Slot[] {
  const hit = tableCache.get(seed);
  if (hit) return hit;
  const r = mulberry(hash(`${seed}:timetable`));
  const slots: Slot[] = [];
  const used = new Set(GOLDEN_FLIGHTS.map((g) => g.flight_no));
  const seq: Record<string, number> = {};
  const nextNo = (prefix: string, start: number, step: number) => {
    const k = prefix + start + ":" + step;
    let n = seq[k] ?? start;
    while (used.has(prefix + n)) n += step;
    seq[k] = n + step;
    used.add(prefix + n);
    return prefix + n;
  };
  const hzAirport = () => (r() < 0.72 ? AIRPORT.HGH_EAST : AIRPORT.HGH_WEST);
  const spread = (k: number, lo: number, hi: number) =>
    Array.from({ length: k }, (_, i) => Math.round((lo + ((i + 0.5) * (hi - lo)) / k + int(r, -25, 25)) / 5) * 5);

  // ---- 杭州 ↔ 深圳：每个方向约 40 班 ----
  for (const dir of ["out", "back"] as const) {
    const golden = GOLDEN_FLIGHTS.filter((g) => (dir === "out" ? g.to_airport === AIRPORT.SZX : g.from_airport === AIRPORT.SZX));
    for (const g of golden)
      slots.push({ no: g.flight_no, airline: g.airline, from: g.from_airport, to: g.to_airport, dep: toMin(g.dep), dur: durationMin(g), stops: 0, std: g.cabins[1].price, special: g.cabins[0].price });
    const numbering: Record<Air, [number, number]> = dir === "out" ? { DY: [2307, 2], BC: [5502, 2], HX: [8101, 2] } : { DY: [2302, 2], BC: [5521, 2], HX: [8102, 2] };
    // 定价：早到的直飞是商务时段，价高；晚到的、经停的便宜。
    const price = (air: Air, dep: number, dur: number, stops: 0 | 1): [number, number] => {
      let std: number;
      if (dir === "out") {
        const early = dep + dur <= 14 * 60 + 30;
        if (early) std = (air === "DY" ? 1050 : 950) + 10 * int(r, 0, 42);
        else std = stops ? 640 + 10 * int(r, 0, 14) : 620 + 10 * int(r, 0, 38);
      } else {
        std = stops ? 820 + 10 * int(r, 0, 8) : (air === "DY" ? 1010 : 840) + 10 * int(r, 0, 41);
      }
      const ratio = stops ? 0.5 + r() * 0.12 : 0.78 + r() * 0.06;
      return [std, r10(std * ratio)];
    };
    const add = (air: Air, dep: number, stops: 0 | 1) => {
      const base = dir === "out" ? int(r, 26, 28) * 5 : int(r, 25, 27) * 5;
      const dur = base + (stops ? int(r, 24, 36) * 5 : 0);
      const [std, special] = price(air, dep, dur, stops);
      const s: Slot = { no: nextNo(air, numbering[air][0], numbering[air][1]), airline: air, from: dir === "out" ? hzAirport() : AIRPORT.SZX, to: dir === "out" ? AIRPORT.SZX : hzAirport(), dep, dur, stops, std, special };
      slots.push(s);
      return s;
    };
    const directs: Record<Air, number> = dir === "out" ? { DY: 8, BC: 7, HX: 8 } : { DY: 10, BC: 8, HX: 8 };
    const stopsN: Record<Air, number> = { DY: 1, BC: 2, HX: 2 };
    const hxDirect: Slot[] = [];
    for (const air of ["DY", "BC", "HX"] as const) {
      for (const dep of spread(directs[air], 6 * 60 + 30, 22 * 60 + 15)) {
        const s = add(air, dep, 0);
        if (air === "HX") hxDirect.push(s);
      }
      add(air, Math.round(int(r, 22 * 60 + 45, 23 * 60 + 55) / 5) * 5, 0); // 红眼
      for (const dep of spread(stopsN[air], 10 * 60 + 40, 21 * 60)) add(air, dep, 1);
    }
    // 共享航班：东曜、北辰挂号销售瀚星实际承运的航班
    const shares: [Air, string, number][] = [["DY", "DY", 6701], ["DY", "DY", 6701], ["BC", "BC", 3901]];
    shares.forEach(([air, prefix, start], i) => {
      const op = hxDirect[(1 + i * 3) % hxDirect.length];
      const floor = dir === "out" ? (op.dep + op.dur <= 14 * 60 + 30 ? (air === "DY" ? 1050 : 950) : 0) : air === "DY" ? 1010 : 840;
      const std = Math.max(op.std + 10 * int(r, 2, 5), floor);
      slots.push({ no: nextNo(prefix, start, 1), airline: air, from: op.from, to: op.to, dep: op.dep, dur: op.dur, stops: 0, op: op.no, std, special: r10(std * 0.82) });
    });
  }

  // ---- 杭州/深圳 ↔ 北京、成都：每个方向 8 班 ----
  const others: [string, string, number, number, number][] = [
    ["杭州", BJ, 135, 900, 1500],
    ["杭州", CD, 180, 800, 1400],
    [AIRPORT.SZX, BJ, 200, 1100, 1900],
    [AIRPORT.SZX, CD, 155, 800, 1300],
  ];
  const otherNo: Record<Air, [string, number]> = { DY: ["DY", 2601], BC: ["BC", 5801], HX: ["HX", 8501] };
  for (const [a, b, baseDur, lo, hi] of others)
    for (const rev of [false, true]) {
      const airs: Air[] = ["DY", "BC", "HX", "DY", "BC", "DY", "HX", "BC"];
      spread(8, 6 * 60 + 40, 21 * 60 + 40).forEach((dep, i) => {
        const end = a === "杭州" ? hzAirport() : a;
        const dur = baseDur + int(r, -1, 2) * 5;
        const std = r10(lo + r() * (hi - lo));
        slots.push({ no: nextNo(otherNo[airs[i]][0], otherNo[airs[i]][1], 1), airline: airs[i], from: rev ? b : end, to: rev ? end : b, dep, dur, stops: 0, std, special: r10(std * (0.76 + r() * 0.08)) });
      });
    }
  tableCache.set(seed, slots);
  return slots;
}

const TPL = GOLDEN_FLIGHTS[0].cabins;
const SUFFIX = ["T", "Y", "B", "J"];
function makeCabins(no: string, special: number, std: number, seats: number[]): Cabin[] {
  const prices = [special, std, Math.round(std * 1.5), Math.round(std * 3.2)];
  return TPL.map((t, i) => ({ cabin_id: `${no}-${SUFFIX[i]}`, name: t.name, price: prices[i], seats_left: seats[i], change_summary: t.change_summary, terms: t.terms, changeable: t.changeable, refundable: t.refundable }));
}

const dayCache = new Map<string, Flight[]>();
const goldenAt = new Map(GOLDEN_FLIGHTS.map((g) => [`${g.date} ${g.flight_no}`, g]));

/** 某一天的全部航班（全部航司、全部航线）。同一 seed、同一天结果相同；返回的是副本，可以随意改。 */
export function flightsOn(seed: number, date: string): Flight[] {
  const key = `${seed}:${date}`;
  let day = dayCache.get(key);
  if (!day) {
    const factor = date === TRIP.out || date === TRIP.back ? 1 : 0.94 + mulberry(hash(`${seed}:factor:${date}`))() * 0.12;
    day = timetable(seed).map((s) => {
      const g = goldenAt.get(`${date} ${s.no}`);
      if (g) return structuredClone(g);
      const r = mulberry(hash(`${seed}:${date}:${s.no}`));
      const seats = [r() < 0.2 ? 0 : int(r, 1, 7), int(r, 1, 14), int(r, 3, 16), r() < 0.15 ? 0 : int(r, 1, 8)];
      const f: Flight = { flight_no: s.no, airline: s.airline, date, from_airport: s.from, to_airport: s.to, dep: hm(s.dep), arr: hm(s.dep + s.dur), stops: s.stops, cabins: makeCabins(s.no, r10(s.special * factor), r10(s.std * factor), seats) };
      if (s.op) f.operated_by = s.op;
      return f;
    });
    dayCache.set(key, day);
  }
  return structuredClone(day);
}

/** 按航班号取某天的一个航班 */
export function findFlight(seed: number, date: string, flight_no: string): Flight | undefined {
  return flightsOn(seed, date).find((f) => f.flight_no === flight_no);
}
