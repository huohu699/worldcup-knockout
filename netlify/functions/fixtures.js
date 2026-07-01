const API_BASE = "https://api.football-data.org/v4";
const COMPETITION_CODE = "WC";
const SEASON = "2026";

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, OPTIONS",
      "access-control-allow-headers": "X-Auth-Token, Content-Type",
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      pragma: "no-cache",
      expires: "0"
    },
    body: JSON.stringify(payload)
  };
}

async function fetchFootballData(path, token) {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      "X-Auth-Token": token,
      Accept: "application/json",
      "User-Agent": "worldcup-office-dashboard/1.0"
    }
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = payload.message || `football-data.org request failed, HTTP ${response.status}`;
    throw new Error(error);
  }

  return payload;
}

exports.handler = async event => {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) {
    return json(200, {
      ok: false,
      error: "线上环境没有配置 FOOTBALL_DATA_TOKEN。请在 Netlify 站点环境变量中添加它。",
      matches: [],
      teams: [],
      standings: []
    });
  }

  try {
    const [matches, teams, standings] = await Promise.all([
      fetchFootballData(`/competitions/${COMPETITION_CODE}/matches?season=${SEASON}`, token),
      fetchFootballData(`/competitions/${COMPETITION_CODE}/teams?season=${SEASON}`, token),
      fetchFootballData(`/competitions/${COMPETITION_CODE}/standings?season=${SEASON}`, token)
    ]);

    return json(200, {
      ok: true,
      matches: matches.matches || [],
      teams: teams.teams || [],
      standings: standings.standings || []
    });
  } catch (error) {
    return json(200, {
      ok: false,
      error: error.message || "football-data.org request failed.",
      matches: [],
      teams: [],
      standings: []
    });
  }
};
