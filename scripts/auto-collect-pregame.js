const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { parseArgs } = require("./ml-utils");
const { assertDateRange } = require("../lib/artifacts");
const { assertSupportedRuntime } = require("../lib/runtime");
const { runNodeScript } = require("./retrain-daily");
const PREFIX = "KBO-AutoCollect-";
const ROOT = path.resolve(__dirname, "..");

function dateInSeoul(now) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(now).replaceAll("-", "");
}
function planCollection(games, now = new Date()) {
  if (!Array.isArray(games) || !Number.isFinite(now.getTime())) throw new Error("Invalid official schedule/clock");
  const date = dateInSeoul(now);
  assertDateRange(date, date);
  const windows = [];
  const slots = new Set();
  const ids = new Set();
  for (const game of games) {
    if (!game || game.G_DT !== date || typeof game.G_ID !== "string" || !game.G_ID || ids.has(game.G_ID)) throw new Error("Official schedule date/identity mismatch");
    ids.add(game.G_ID);
    if (String(game.GAME_STATE_SC) !== "1" || String(game.SR_ID) !== "0"
        || !["", "정상경기"].includes(String(game.CANCEL_SC_NM || "").trim())
        || !["", "0"].includes(String(game.CANCEL_SC_ID ?? ""))) continue;
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(game.G_TM)) throw new Error(`Unannounced/invalid game time: ${game.G_ID}`);
    const starts = Date.parse(`${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${game.G_TM}:00+09:00`);
    if (starts <= now.getTime()) continue;
    const opens = starts - 30 * 60000;
    windows.push({ gameId: game.G_ID, startsAt: new Date(starts).toISOString(), opensAt: new Date(opens).toISOString() });
    for (let time = opens; time < starts; time += 5 * 60000) if (time > now.getTime()) slots.add(new Date(time).toISOString());
  }
  const due = windows.filter((window) => Date.parse(window.opensAt) <= now.getTime());
  return { date, windows, slots: [...slots].sort(), dueGameIds: due.map((window) => window.gameId) };
}
async function officialSchedule(date) {
  const response = await fetch("https://www.koreabaseball.com/ws/Main.asmx/GetKboGameList", {
    method: "POST", signal: AbortSignal.timeout(15000),
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "User-Agent": "Mozilla/5.0", "X-Requested-With": "XMLHttpRequest", Referer: "https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx" },
    body: new URLSearchParams({ leId: "1", srId: "0,1,3,4,5,6,7,8,9", date }).toString(),
  });
  if (!response.ok) throw new Error(`Official schedule HTTP ${response.status}`);
  const data = await response.json();
  if (String(data?.code) !== "100" || !Array.isArray(data.game)) throw new Error("Invalid official schedule response");
  return data.game;
}
function xml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}
function taskXml({ sid, args, triggers }) {
  return `<?xml version="1.0" encoding="UTF-16"?><Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers>${triggers}</Triggers><Principals><Principal id="Author"><UserId>${xml(sid)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT25M</ExecutionTimeLimit></Settings><Actions Context="Author"><Exec><Command>${xml(process.execPath)}</Command><Arguments>${xml(`"${__filename}" ${args}`)}</Arguments><WorkingDirectory>${xml(ROOT)}</WorkingDirectory></Exec></Actions></Task>`;
}
function command(file, args) {
  const result = spawnSync(file, args, { encoding: "utf8", windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${file} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function powershell(source) {
  return command("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(`$ErrorActionPreference='Stop'; ${source}`, "utf16le").toString("base64")]);
}
async function register(name, content) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "kbo-task-"));
  try {
    const file = path.join(directory, "task.xml");
    await fs.writeFile(file, Buffer.from(`\uFEFF${content}`, "utf16le"));
    command("schtasks.exe", ["/Create", "/TN", name, "/XML", file, "/F"]);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
async function applyPlan(plan, sid, baseUrl) {
  if (plan.slots.length > 48) throw new Error("Schedule exceeds Windows per-task trigger limit");
  const name = `${PREFIX}${plan.date}`;
  const names = JSON.parse(powershell(`ConvertTo-Json -Compress -InputObject @((Get-ScheduledTask | Where-Object { $_.TaskPath -eq '\\' -and $_.TaskName -match '^KBO-AutoCollect-[0-9]{8}$' }).TaskName)`).trim() || "[]");
  // Registration must succeed before replacing older daily plans. Never touch kbo-helper.
  if (plan.slots.length) {
    const triggers = plan.slots.map((time) => `<TimeTrigger><StartBoundary>${time}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`).join("");
    await register(name, taskXml({ sid, args: `--baseUrl="${baseUrl}"`, triggers }));
  }
  for (const old of names) if (old !== name || !plan.slots.length) command("schtasks.exe", ["/Delete", "/TN", old, "/F"]);
}
async function collectIfDue(plan, { baseUrl, clock = () => new Date(), run = runNodeScript } = {}) {
  // Recheck after schedule lookup/task registration; never launch late or too early.
  const now = clock().getTime();
  const due = plan.windows.filter((window) => Date.parse(window.opensAt) <= now && now < Date.parse(window.startsAt));
  if (!due.length) return false;
  await run("helper-pc-train-and-tune.js", ["--collectOnly=true", "--fetchResults=false", "--autoPush=false", "--pregameWindowMinutes=30", `--from=${plan.date}`, `--to=${plan.date}`, "--timeoutMs=60000", `--baseUrl=${baseUrl}`], { cwd: ROOT, timeoutMs: 25 * 60000 });
  return true;
}
async function main() {
  assertSupportedRuntime();
  const args = parseArgs(process.argv.slice(2));
  const preview = args.preview === true;
  if (!preview && process.platform !== "win32") throw new Error("Windows task registration requires Windows; use --preview to inspect official schedule");
  const url = new URL(String(args.baseUrl || "https://kbo-predictor.vercel.app"));
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || /["\r\n]/.test(url.href)) throw new Error("Invalid server URL");
  const baseUrl = url.href.replace(/\/$/, "");
  const games = await officialSchedule(dateInSeoul(new Date()));
  const plan = planCollection(games, new Date());
  if (preview) { console.log(JSON.stringify({ preview: true, ...plan }, null, 2)); return; }
  const sid = powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value").trim();
  if (!/^S-\d(?:-\d+)+$/.test(sid)) throw new Error("Could not resolve current Windows account SID");
  if (args.install === true) {
    const date = plan.date;
    const daily = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T03:00:00+09:00`;
    const triggers = `<CalendarTrigger><StartBoundary>${daily}</StartBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><LogonTrigger><Enabled>true</Enabled><UserId>${xml(sid)}</UserId></LogonTrigger>`;
    await register(`${PREFIX}Plan`, taskXml({ sid, args: `--baseUrl="${baseUrl}"`, triggers }));
  }
  await applyPlan(plan, sid, baseUrl);
  const collected = await collectIfDue(plan, { baseUrl });
  console.log(JSON.stringify({ installed: args.install === true, collected, ...plan }, null, 2));
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { planCollection, collectIfDue, taskXml };
