const API_BASE = "https://api.football-data.org/v4";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const CACHE_TTL = 12 * 60 * 60 * 1000;
const REQUEST_TIMEOUT = 25000;
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

function ok(payload) {
  return json(200, payload);
}

function errorJson(statusCode, code, message, detail) {
  return json(statusCode, {
    ok: false,
    code,
    error: message,
    detail: detail || null
  });
}

function makeError(code, message, statusCode = 500, detail = null) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.detail = detail;
  return error;
}

async function withTimeout(label, task, timeoutMs = REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await task(controller.signal);
  } catch (error) {
    if (error.name === "AbortError") {
      throw makeError("REQUEST_TIMEOUT", `${label} request timeout`, 500, { timeoutMs });
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson(url, options, label) {
  return withTimeout(label, async signal => {
    let response;
    try {
      response = await fetch(url, { ...options, signal });
    } catch (error) {
      throw makeError("NETWORK_ERROR", `${label} network error`, 500, error.message);
    }

    const text = await response.text();
    let payload = {};
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      payload = { raw: text.slice(0, 1200) };
    }

    if (!response.ok) {
      throw makeError(
        "UPSTREAM_HTTP_ERROR",
        payload.message || payload.error?.message || payload.error || `${label} failed`,
        500,
        { status: response.status, payload }
      );
    }

    return payload;
  });
}

function safeParseDeepSeekContent(content) {
  const raw = String(content || "").trim();
  const cleaned = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (error) {
    throw makeError("DEEPSEEK_JSON_PARSE_ERROR", "DeepSeek returned invalid JSON", 500, {
      parseError: error.message,
      content: raw.slice(0, 1200)
    });
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

function buildPrompt({ home, away, homeRecent, awayRecent }) {
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

async function deepSeekAnalysis(prompt, apiKey) {
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
          { role: "user", content: prompt }
        ]
      })
    },
    "DeepSeek"
  );

  // DeepSeek 200 但结构异常时，也返回函数错误 JSON，避免运行时抛出 502。
  const content = payload.choices?.[0]?.message?.content;
  if (!content) {
    throw makeError("DEEPSEEK_EMPTY_CONTENT", "DeepSeek response missing choices[0].message.content", 500, payload);
  }

  return safeParseDeepSeekContent(content);
}

async function buildAnalysis(matchId, footballKey, deepSeekKey) {
  const footballHeaders = { "X-Auth-Token": footballKey, Accept: "application/json" };

  const matchPayload = await requestJson(
    `${API_BASE}/matches/${encodeURIComponent(matchId)}`,
    { headers: footballHeaders },
    "football-data match detail"
  );
  const match = matchPayload.match || matchPayload;
  const home = extractSquad(match, "home");
  const away = extractSquad(match, "away");

  if (!home.id || !away.id) {
    throw makeError("TEAM_ID_MISSING", "match team id missing", 500, { home, away });
  }

  const [homeMatches, awayMatches] = await Promise.all([
    requestJson(`${API_BASE}/teams/${home.id}/matches?status=FINISHED&limit=3`, { headers: footballHeaders }, "football-data home recent matches"),
    requestJson(`${API_BASE}/teams/${away.id}/matches?status=FINISHED&limit=3`, { headers: footballHeaders }, "football-data away recent matches")
  ]);

  return deepSeekAnalysis(
    buildPrompt({
      home,
      away,
      homeRecent: summarizeRecent(homeMatches.matches, home.id),
      awayRecent: summarizeRecent(awayMatches.matches, away.id)
    }),
    deepSeekKey
  );
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };

  try {
    const matchId = event.queryStringParameters?.matchId;
    const footballKey = process.env.FOOTBALL_DATA_KEY || process.env.FOOTBALL_DATA_TOKEN;
    const deepSeekKey = process.env.DEEPSEEK_KEY;

    // 入口参数与环境变量校验，缺失返回 400，不进入上游请求。
    if (!matchId) return errorJson(400, "MISSING_MATCH_ID", "missing matchId");
    if (!footballKey) return errorJson(400, "MISSING_FOOTBALL_DATA_KEY", "missing FOOTBALL_DATA_KEY");
    if (!deepSeekKey) return errorJson(400, "MISSING_DEEPSEEK_KEY", "missing DEEPSEEK_KEY");

    const cached = cache.get(matchId);
    if (cached && cached.expires > Date.now()) return ok(cached.data);

    const analysis = await buildAnalysis(matchId, footballKey, deepSeekKey);
    cache.set(matchId, { expires: Date.now() + CACHE_TTL, data: analysis });
    return ok(analysis);
  } catch (error) {
    console.error("ai-analysis failed", error);
    return errorJson(
      500,
      error.code || "AI_ANALYSIS_FAILED",
      error.message || "ai-analysis failed",
      error.detail || null
    );
  }
};
