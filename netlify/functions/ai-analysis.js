const API_BASE = "https://api.football-data.org/v4";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const cache = new Map();

const corsHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization"
};

function json(statusCode, payload) {
  return { statusCode, headers: corsHeaders, body: JSON.stringify(payload) };
}

function fail(statusCode, message, detail) {
  return json(statusCode, { ok: false, error: message, detail: detail || "" });
}

async function requestJson(url, options, label) {
  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    const err = new Error(`${label} network error`);
    err.statusCode = 502;
    err.detail = error.message;
    throw err;
  }

  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text };
  }

  if (!response.ok) {
    const message = payload.message || payload.error?.message || payload.error || `${label} failed`;
    const err = new Error(message);
    err.statusCode = response.status;
    err.detail = payload;
    throw err;
  }

  return payload;
}

function parseDeepSeekContent(content) {
  const raw = String(content || "").trim();
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    const err = new Error("DeepSeek returned invalid JSON");
    err.statusCode = 502;
    err.detail = { content: raw.slice(0, 1200), parseError: error.message };
    throw err;
  }
}

function teamName(team) {
  return team?.name || team?.shortName || team?.tla || "Unknown";
}

function playerName(player) {
  return player?.name || player?.fullName || player?.shortName || "Unknown";
}

function playerClub(player) {
  return player?.club?.name || player?.currentTeam?.name || player?.team?.name || player?.club || "Unknown";
}

function playerPosition(player) {
  return player?.position || player?.role || player?.shirtNumber || "Unknown";
}

function compactPlayer(player) {
  return { n: playerName(player), p: playerPosition(player), c: playerClub(player) };
}

function pickSide(match, side) {
  return match?.[side] || match?.lineups?.[side] || match?.lineup?.[side] || {};
}

function extractSquad(match, side) {
  const sideData = pickSide(match, side);
  const team = match?.[`${side}Team`] || sideData.team || {};
  const start =
    sideData.startingXI ||
    sideData.startingLineup ||
    sideData.lineup ||
    sideData.squad?.filter?.(player => player.role === "STARTING_LINEUP") ||
    [];
  const bench =
    sideData.substitutes ||
    sideData.bench ||
    sideData.squad?.filter?.(player => player.role === "SUBSTITUTE") ||
    [];
  return {
    id: team.id || sideData.teamId || sideData.id,
    name: teamName(team),
    lineup: start.slice(0, 11).map(compactPlayer),
    bench: bench.slice(0, 8).map(compactPlayer)
  };
}

function statNumber(value) {
  if (value === null || value === undefined) return 0;
  const n = Number(String(value).replace("%", ""));
  return Number.isFinite(n) ? n : 0;
}

function findStat(stats, names) {
  const list = Array.isArray(stats) ? stats : [];
  const hit = list.find(item => names.some(name => String(item.type || item.name || "").toLowerCase().includes(name)));
  return statNumber(hit?.value ?? hit?.home ?? hit?.away);
}

function sideStats(match, teamId) {
  const stats = match.statistics || match.stats || [];
  const sideBlock = Array.isArray(stats)
    ? stats.find(item => item.team?.id === teamId || item.teamId === teamId)?.statistics || stats
    : [];
  return {
    sot: findStat(sideBlock, ["shots on target", "射正"]),
    poss: findStat(sideBlock, ["possession", "控球"]),
    setPieceGoals: findStat(sideBlock, ["set piece", "定位球"]),
    errors: findStat(sideBlock, ["error", "失误"])
  };
}

function scoreFor(match, teamId) {
  const homeId = match.homeTeam?.id;
  const awayId = match.awayTeam?.id;
  const home = statNumber(match.score?.fullTime?.home ?? match.score?.regularTime?.home);
  const away = statNumber(match.score?.fullTime?.away ?? match.score?.regularTime?.away);
  if (teamId === homeId) return { gf: home, ga: away };
  if (teamId === awayId) return { gf: away, ga: home };
  return { gf: 0, ga: 0 };
}

function summarizeRecent(matches, teamId) {
  return (matches || []).slice(0, 3).map(match => {
    const score = scoreFor(match, teamId);
    const stats = sideStats(match, teamId);
    return {
      v: `${teamName(match.homeTeam)}-${teamName(match.awayTeam)}`,
      gf: score.gf,
      ga: score.ga,
      sot: stats.sot,
      poss: stats.poss,
      set: stats.setPieceGoals,
      err: stats.errors
    };
  });
}

function prompt({ home, away, homeRecent, awayRecent }) {
  const hl = JSON.stringify({ s: home.lineup, b: home.bench.slice(0, 3) });
  const al = JSON.stringify({ s: away.lineup, b: away.bench.slice(0, 3) });
  const hr = JSON.stringify(homeRecent);
  const ar = JSON.stringify(awayRecent);
  return `2026世界杯量化分析
主队:${home.name} 客队:${away.name}
主队阵容:${hl}
主队近3场:${hr}
客队阵容:${al}
客队近3场:${ar}
严格输出JSON，字段：
lineup:{home:[],away:[]} 首发11+3关键替补，标俱乐部、位置
score:{home:[],away:[]} 首发10分制，含伤病分级、体能、黄牌风险
matchup:"" 全线对位分析，指出绝对碾压线
review:{home:"",away:""} 近3场复盘+持续弱点
total:{home:0,away:0} 权重：健康25%/战绩25%/对位20%/身价经验15%/战意交手15%
conclusion:"" 胜负判定+4个大胜支撑点+崩盘原因+净胜球区间+比赛节奏
disclaimer:"仅赛事技术分析，不代表投注建议"
输出紧凑，无多余文字。`;
}

async function deepSeekAnalysis(content, apiKey) {
  const payload = await requestJson(
    DEEPSEEK_URL,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.3,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "你是世界杯赛事量化分析引擎，只输出合法紧凑JSON。" },
          { role: "user", content }
        ]
      })
    },
    "DeepSeek request"
  );
  const contentText = payload.choices?.[0]?.message?.content;
  if (!contentText) {
    const err = new Error("DeepSeek response missing content");
    err.statusCode = 502;
    err.detail = payload;
    throw err;
  }
  return parseDeepSeekContent(contentText);
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  try {
    const matchId = event.queryStringParameters?.matchId;
    if (!matchId) return fail(400, "missing matchId");

    const cached = cache.get(matchId);
    if (cached && cached.expires > Date.now()) return json(200, cached.data);

    const footballKey = process.env.FOOTBALL_DATA_KEY || process.env.FOOTBALL_DATA_TOKEN;
    const deepSeekKey = process.env.DEEPSEEK_KEY;
    if (!footballKey) return fail(500, "missing FOOTBALL_DATA_KEY");
    if (!deepSeekKey) return fail(500, "missing DEEPSEEK_KEY");

    const footballHeaders = { "X-Auth-Token": footballKey, Accept: "application/json" };
    const matchPayload = await requestJson(
      `${API_BASE}/matches/${encodeURIComponent(matchId)}`,
      { headers: footballHeaders },
      "match detail"
    );
    const match = matchPayload.match || matchPayload;
    const home = extractSquad(match, "home");
    const away = extractSquad(match, "away");
    if (!home.id || !away.id) return fail(502, "match team id missing", { home, away });

    const [homeMatches, awayMatches] = await Promise.all([
      requestJson(`${API_BASE}/teams/${home.id}/matches?status=FINISHED&limit=3`, { headers: footballHeaders }, "home recent matches"),
      requestJson(`${API_BASE}/teams/${away.id}/matches?status=FINISHED&limit=3`, { headers: footballHeaders }, "away recent matches")
    ]);

    const analysis = await deepSeekAnalysis(
      prompt({
        home,
        away,
        homeRecent: summarizeRecent(homeMatches.matches, home.id),
        awayRecent: summarizeRecent(awayMatches.matches, away.id)
      }),
      deepSeekKey
    );

    cache.set(matchId, { expires: Date.now() + CACHE_TTL, data: analysis });
    return json(200, analysis);
  } catch (error) {
    console.error("ai-analysis failed", error);
    return fail(error.statusCode || 500, error.message || "analysis failed", error.detail || "");
  }
};
