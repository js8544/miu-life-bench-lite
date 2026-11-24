// 裁判和用户模拟器共用的模型调用。两者都只做一件事：给一段系统提示词和一条用户消息，要回一个 JSON 对象。
// 走哪条通道由配置决定，评测逻辑不关心：
//
//   openai   任何兼容 OpenAI chat completions 的接口（默认）。要 baseUrl 和 apiKey。
//   codex    本机 codex 命令行，用它自己的登录，不需要 API key。
//   command  任意命令：从标准输入读 {"model","system","user"}，把模型的回答打到标准输出。
//            用来接别的命令行工具或自己的网关。
//
// 配置来源（后面的盖前面的）：项目根目录的 pa.config.json → 环境变量。
//   pa.config.json  {"llm":"openai|codex|command","baseUrl":"","apiKeyEnv":"OPENAI_API_KEY","codex":"","command":"","effort":"low","parallel":6,"judge":"","sim":""}
//   环境变量        PA_LLM、PA_LLM_BASE_URL、PA_LLM_API_KEY（没有就用 OPENAI_API_KEY）、PA_CODEX、PA_LLM_CMD、PA_LLM_EFFORT、PA_LLM_PARALLEL、PA_JUDGE、PA_SIM
// 密钥只从环境变量读，不写进配置文件。
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";

interface Config { llm?: string; baseUrl?: string; apiKeyEnv?: string; codex?: string; command?: string; effort?: string; parallel?: number; judge?: string; sim?: string }
let file: Config = {};
try { file = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "..", "pa.config.json"), "utf8")); } catch {}
const env = process.env;

const KIND = (env.PA_LLM || file.llm || "openai").toLowerCase();
const BASE_URL = (env.PA_LLM_BASE_URL || file.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
const API_KEY = env.PA_LLM_API_KEY || env[file.apiKeyEnv || "OPENAI_API_KEY"] || "";
const CODEX = env.PA_CODEX || file.codex || "codex";
const COMMAND = env.PA_LLM_CMD || file.command || "";
// 思考强度。有的接口不认这个参数：设成空字符串就不传。
const EFFORT = env.PA_LLM_EFFORT ?? file.effort ?? "low";
const MAX_PARALLEL = Number(env.PA_LLM_PARALLEL || file.parallel || 6);

/** 裁判和用户模拟器默认用的模型。换模型会让新旧分数不可比，见 README。 */
export const DEFAULT_JUDGE = env.PA_JUDGE || file.judge || "gpt-6.2-sol";
export const DEFAULT_SIM = env.PA_SIM || file.sim || "gpt-6.2-sol";

let running = 0; const waiting: (() => void)[] = [];
async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}
type Reply = { text?: string; error?: string };

async function viaOpenAI(model: string, system: string, user: string): Promise<Reply> {
  if (!API_KEY) return { error: "没有 API key：设置 PA_LLM_API_KEY（或 OPENAI_API_KEY），或者把 PA_LLM 换成 codex / command" };
  const body: any = { model, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: user }] };
  if (EFFORT) body.reasoning_effort = EFFORT;
  const j: any = await fetch(`${BASE_URL}/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) })
    .then((r) => r.json()).catch((e) => ({ error: { message: `网络错误：${e?.cause?.code ?? e?.message ?? e}` } }));
  if (j.error) return { error: String(j.error.message ?? j.error) };
  const text = j.choices?.[0]?.message?.content;
  return typeof text === "string" && text.trim() ? { text } : { error: "返回里没有内容" };
}

/** 起一个子进程，把 input 写进标准输入；done 决定从哪里取回答 */
function run(cmd: string, args: string[], input: string, done: (stdout: string) => string | undefined, shell = false): Promise<Reply> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], shell });
    let out = "", err = ""; p.stdout.on("data", (d) => { out += d; }); p.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => p.kill("SIGKILL"), 180_000);
    p.on("error", (e) => { clearTimeout(timer); resolve({ error: `起不来 ${cmd}：${e.message}` }); });
    p.on("close", (code) => {
      clearTimeout(timer);
      const text = done(out);
      resolve(text && text.trim() ? { text } : { error: `${path.basename(cmd)} 退出码 ${code}：${err.trim().split("\n").slice(-3).join(" | ")}` });
    });
    p.stdin.on("error", () => {}); p.stdin.end(input);
  });
}

// codex：不读用户配置、不存会话、只读沙箱、空目录，系统提示词换成我们自己的，
// 这样模型看到的只有“系统提示词 + 一条用户消息”，和直接调接口一样。
async function viaCodex(model: string, system: string, user: string): Promise<Reply> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pa-llm-"));
  const sys = path.join(dir, "system.md"), out = path.join(dir, "out.txt");
  fs.writeFileSync(sys, system + "\n\n只输出要求的 JSON，不要调用任何工具，不要输出别的内容。");
  const args = ["exec", "--ignore-user-config", "--ephemeral", "--skip-git-repo-check", "-s", "read-only", "-C", dir, "-m", model, "-c", `model_instructions_file=${JSON.stringify(sys)}`, "-o", out];
  if (EFFORT) args.push("-c", `model_reasoning_effort=${JSON.stringify(EFFORT)}`);
  const r = await run(CODEX, [...args, "-"], user, () => { try { return fs.readFileSync(out, "utf8"); } catch { return undefined; } });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

async function viaCommand(model: string, system: string, user: string): Promise<Reply> {
  if (!COMMAND) return { error: "PA_LLM=command 需要设置 PA_LLM_CMD" };
  return run(COMMAND, [], JSON.stringify({ model, system, user }), (s) => s, true);
}

const CHANNEL: Record<string, (m: string, s: string, u: string) => Promise<Reply>> = { openai: viaOpenAI, codex: viaCodex, command: viaCommand };

/** 问一次，返回解析好的 JSON 对象。连不上、超时、返回的不是合法 JSON 都算一次失败，一共试 7 次。 */
export async function chatJSON(model: string, system: string, user: string, who = "模型"): Promise<any> {
  const call = CHANNEL[KIND];
  if (!call) throw new Error(`PA_LLM 只能是 openai、codex、command，现在是 ${KIND}`);
  for (let i = 0; ; i++) {
    const r = await slot(() => call(model, system, user));
    if (r.text) {
      const s = r.text.trim().replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
      try { return JSON.parse(s); } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch {} } r.error = "返回的不是 JSON"; }
    }
    if (i >= 6 || /没有 API key|需要设置 PA_LLM_CMD/.test(r.error ?? "")) throw new Error(`${who}出错：${r.error}`);
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
}
