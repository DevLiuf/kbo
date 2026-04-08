const statusText = document.getElementById("statusText");
const tableBody = document.getElementById("tableBody");
const metricsTableBody = document.getElementById("metricsTableBody");
const metricsSortHeaders = Array.from(document.querySelectorAll("#metricsTable th[data-sort-field]"));
const refreshButton = document.getElementById("refreshButton");
const dailyDateText = document.getElementById("dailyDateText");
const dailyPredictionsList = document.getElementById("dailyPredictionsList");
const modelStatusRow = document.getElementById("modelStatusRow");

const FIXED_EXPONENT = 1.83;
const HOME_ADVANTAGE_RATE = 0.03;
const metricsSortState = {
  field: null,
  direction: "asc",
};
let metricsRowsCache = [];
const currentLeague = "kbo";

function resolveApiUrl(exponent, league) {
  const isHttp = window.location.protocol === "http:" || window.location.protocol === "https:";
  const baseUrl = isHttp ? "" : "http://localhost:3000";
  return `${baseUrl}/api/teams/pythagorean?exponent=${exponent}&league=${league}`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
}

function formatEra(era) {
  if (!Number.isFinite(era)) {
    return "-";
  }
  return era.toFixed(2);
}

function getConfidence(diff, lineupConfirmed) {
  if (!lineupConfirmed) {
    if (diff >= 0.3) {
      return "강한 우세";
    }
    if (diff >= 0.18) {
      return "우세";
    }
    return "접전";
  }

  if (diff >= 0.33) {
    return "강한 우세";
  }
  if (diff >= 0.16) {
    return "우세";
  }
  return "접전";
}

function formatMetricValue(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(digits);
}

function formatCompactDate(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "-";
  }

  if (/^\d{8}$/.test(text)) {
    return `${text.slice(0, 4)}.${text.slice(4, 6)}.${text.slice(6, 8)}`;
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}.${m}.${d}`;
}

function renderModelStatus(payload) {
  if (!modelStatusRow) {
    return;
  }

  const mlLatest = formatCompactDate(payload?.modelLatestGameDate);
  const mlRange = payload?.modelTrainingRange?.from && payload?.modelTrainingRange?.to
    ? `${formatCompactDate(payload.modelTrainingRange.from)}~${formatCompactDate(payload.modelTrainingRange.to)}`
    : "-";
  const saberRange = payload?.saberTuningRange?.from && payload?.saberTuningRange?.to
    ? `${formatCompactDate(payload.saberTuningRange.from)}~${formatCompactDate(payload.saberTuningRange.to)}`
    : "-";

  modelStatusRow.innerHTML = `
    <span class="model-status-pill ml"><span class="model-status-label">ML 학습 경기일</span><span class="model-status-value">${mlLatest}</span><span class="model-status-range">(${mlRange})</span></span>
    <span class="model-status-pill saber"><span class="model-status-label">세이버 튜닝 경기일</span><span class="model-status-value">${saberRange}</span></span>
  `;
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getLineupOrderValue(entry, fallbackOrder) {
  const candidates = [
    entry?.battingOrder,
    entry?.order,
    entry?.turn,
    entry?.seq,
    entry?.slot,
  ];

  for (const value of candidates) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) {
      return num;
    }
  }

  return fallbackOrder;
}

function getLineupPlayerName(entry) {
  const candidates = [
    entry?.playerName,
    entry?.name,
    entry?.displayName,
    entry?.hName,
    entry?.pName,
    entry?.text,
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function getLineupPosition(entry) {
  const candidates = [
    entry?.position,
    entry?.pos,
  ];

  for (const value of candidates) {
    const text = String(value || "").trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function normalizeLineup(lineup) {
  if (!Array.isArray(lineup) || lineup.length === 0) {
    return [];
  }

  return lineup
    .map((entry, index) => ({
      order: getLineupOrderValue(entry, index + 1),
      name: getLineupPlayerName(entry),
      position: getLineupPosition(entry),
      ops: Number.isFinite(Number(entry?.ops)) ? Number(entry.ops) : null,
      obp: Number.isFinite(Number(entry?.obp)) ? Number(entry.obp) : null,
      slg: Number.isFinite(Number(entry?.slg)) ? Number(entry.slg) : null,
    }))
    .filter((entry) => entry.name)
    .sort((a, b) => a.order - b.order)
    .slice(0, 9);
}

function renderLineupColumn(lineup, sideLabel) {
  const safeSideLabel = escapeHtml(sideLabel);

  if (!Array.isArray(lineup) || lineup.length === 0) {
    return `<div class="lineup-col"><p class="lineup-side">${safeSideLabel}</p><p class="lineup-empty">라인업 미발표</p></div>`;
  }

  const rows = lineup
    .map((entry) => {
      const safeName = escapeHtml(entry.name);
      const safePosition = escapeHtml(entry.position);
      const positionChip = safePosition
        ? `<span class="lineup-position">${safePosition}</span>`
        : "";
      const opsChip = Number.isFinite(entry.ops)
        ? `<span class="lineup-metric">OPS ${entry.ops.toFixed(3)}</span>`
        : "";

      return `<li><span class="lineup-order">${entry.order}</span><span class="lineup-name-wrap"><span class="lineup-name">${safeName}</span>${positionChip}${opsChip}</span></li>`;
    })
    .join("");

  return `<div class="lineup-col"><p class="lineup-side">${safeSideLabel}</p><ol class="lineup-list">${rows}</ol></div>`;
}

function renderKboLineupBlock(game) {
  const awayLineup = normalizeLineup(game.awayLineup);
  const homeLineup = normalizeLineup(game.homeLineup);
  const hasLineup = awayLineup.length > 0 || homeLineup.length > 0;
  let readinessText = "라인업 수집 대기";
  let helperText = "경기 시작 전에는 라인업이 비어 있을 수 있습니다.";

  if (hasLineup) {
    readinessText = game.lineupConfirmed ? "라인업 확정" : "라인업 수집 완료";
    helperText = "";
  } else if (game.lineupDataReady) {
    readinessText = "라인업 미발표";
    helperText = "현재 제공된 타순 데이터가 없습니다.";
  }

  if (!hasLineup) {
    return `<div class="daily-lineup"><p class="lineup-head">타순 라인업 · ${readinessText}</p><p class="lineup-empty">${helperText}</p></div>`;
  }

  return `<div class="daily-lineup"><p class="lineup-head">타순 라인업 · ${readinessText}</p><div class="lineup-grid">${renderLineupColumn(awayLineup, `${game.awayTeam} (원정)`)}${renderLineupColumn(homeLineup, `${game.homeTeam} (홈)`)}</div></div>`;
}

function getHeadToHeadEdge(awayValue, homeValue, lowerIsBetter) {
  if (!Number.isFinite(awayValue) || !Number.isFinite(homeValue)) {
    return "비교 불가";
  }

  const delta = homeValue - awayValue;
  if (Math.abs(delta) < 1e-9) {
    return "동률";
  }

  if (lowerIsBetter) {
    return delta < 0 ? "홈 우세" : "원정 우세";
  }

  return delta > 0 ? "홈 우세" : "원정 우세";
}

function renderHeadToHeadMetrics(game) {
  if (!game.modelFeatures) {
    return "";
  }

  const metrics = [
    {
      label: "팀 득점 (R/G)",
      away: game.modelFeatures.awayOffenseRpg,
      home: game.modelFeatures.homeOffenseRpg,
      lowerIsBetter: false,
      digits: 1,
    },
    {
      label: "팀 실점 (R/G)",
      away: game.modelFeatures.awayDefenseRpg,
      home: game.modelFeatures.homeDefenseRpg,
      lowerIsBetter: true,
      digits: 1,
    },
    {
      label: "팀 타율 (AVG)",
      away: game.modelFeatures.awayBattingAvg,
      home: game.modelFeatures.homeBattingAvg,
      lowerIsBetter: false,
      digits: 3,
    },
    {
      label: "팀 홈런 (HR/G)",
      away: game.modelFeatures.awayHrPerGame,
      home: game.modelFeatures.homeHrPerGame,
      lowerIsBetter: false,
      digits: 1,
    },
    {
      label: "라인업 OPS (Avg)",
      away: game.modelFeatures.awayLineupOpsAvg,
      home: game.modelFeatures.homeLineupOpsAvg,
      lowerIsBetter: false,
      digits: 3,
    },
    {
      label: "팀 WHIP",
      away: game.modelFeatures.awayTeamWhip,
      home: game.modelFeatures.homeTeamWhip,
      lowerIsBetter: true,
      digits: 3,
    },
    {
      label: "불펜 기여 (SV+HLD/G)",
      away: game.modelFeatures.awayBullpenUsagePerGame,
      home: game.modelFeatures.homeBullpenUsagePerGame,
      lowerIsBetter: false,
      digits: 1,
    },
    {
      label: "불펜 제구 (K/BB)",
      away: game.modelFeatures.awayKbbRatio,
      home: game.modelFeatures.homeKbbRatio,
      lowerIsBetter: false,
      digits: 1,
    },
    {
      label: "선발 ERA",
      away: game.awayStarterEra,
      home: game.homeStarterEra,
      lowerIsBetter: true,
      digits: 2,
    },
    {
      label: "모델 기대 득점",
      away: game.expectedAwayRuns,
      home: game.expectedHomeRuns,
      lowerIsBetter: false,
      digits: 1,
    },
  ];

  if (Number.isFinite(game.modelFeatures.saberExpectedAwayRuns) && Number.isFinite(game.modelFeatures.saberExpectedHomeRuns)) {
    metrics.push({
      label: "세이버 기대 득점 (MK+MC)",
      away: game.modelFeatures.saberExpectedAwayRuns,
      home: game.modelFeatures.saberExpectedHomeRuns,
      lowerIsBetter: false,
      digits: 2,
    });
  }

  if (Number.isFinite(game.modelFeatures.markovAwayRuns) && Number.isFinite(game.modelFeatures.markovHomeRuns)) {
    metrics.push({
      label: "Markov 이론 득점",
      away: game.modelFeatures.markovAwayRuns,
      home: game.modelFeatures.markovHomeRuns,
      lowerIsBetter: false,
      digits: 2,
    });
  }

  if (Number.isFinite(game.modelFeatures.monteCarloAwayRuns) && Number.isFinite(game.modelFeatures.monteCarloHomeRuns)) {
    metrics.push({
      label: "MonteCarlo 평균 득점",
      away: game.modelFeatures.monteCarloAwayRuns,
      home: game.modelFeatures.monteCarloHomeRuns,
      lowerIsBetter: false,
      digits: 2,
    });
  }

  const rows = metrics.map((metric) => {
    const edge = getHeadToHeadEdge(metric.away, metric.home, metric.lowerIsBetter);
    const edgeClass = edge === "홈 우세"
      ? "home"
      : edge === "원정 우세"
        ? "away"
        : "draw";

    return `<tr>
      <td class="h2h-label">${metric.label}</td>
      <td>${formatMetricValue(metric.away, metric.digits)}</td>
      <td>${formatMetricValue(metric.home, metric.digits)}</td>
      <td><span class="h2h-edge ${edgeClass}">${edge}</span></td>
    </tr>`;
  }).join("");

  return `<div class="daily-h2h"><p>팀 지표 비교 <span class="h2h-legend">(실점/WHIP/선발ERA는 낮을수록 우세)</span></p><table><thead><tr><th>지표</th><th>원정</th><th>홈</th><th>우세</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function makeCell(value) {
  const td = document.createElement("td");
  td.textContent = value;
  return td;
}

function formatNumber(value, digits) {
  if (!Number.isFinite(value)) {
    return "-";
  }
  return value.toFixed(digits);
}

function getMetricsFieldValue(row, field) {
  switch (field) {
    case "team":
      return String(row.team || "");
    case "games":
      return Number(row.games) || 0;
    case "offenseRpg":
      return row.games > 0 ? row.runsScored / row.games : 0;
    case "defenseRpg":
      return row.games > 0 ? row.runsAllowed / row.games : 0;
    case "battingAvg":
      return Number(row.battingAvg) || 0;
    case "hrPerGame":
      return Number(row.hrPerGame) || 0;
    case "teamEra":
      return Number(row.teamEra) || 0;
    case "teamWhip":
      return Number(row.teamWhip) || 0;
    case "bullpenUsagePerGame":
      return Number(row.bullpenUsagePerGame) || 0;
    case "kbbRatio":
      return Number(row.kbbRatio) || 0;
    default:
      return 0;
  }
}

function getSortedMetricsRows(rows) {
  const sorted = [...rows];
  if (!metricsSortState.field) {
    return sorted;
  }

  const { field, direction } = metricsSortState;
  const sign = direction === "asc" ? 1 : -1;

  sorted.sort((a, b) => {
    const av = getMetricsFieldValue(a, field);
    const bv = getMetricsFieldValue(b, field);

    if (typeof av === "string" || typeof bv === "string") {
      return String(av).localeCompare(String(bv), "ko") * sign;
    }

    return (Number(av) - Number(bv)) * sign;
  });

  return sorted;
}

function updateMetricsSortHeaderState() {
  metricsSortHeaders.forEach((header) => {
    const field = header.dataset.sortField;
    const isActive = field === metricsSortState.field;
    header.dataset.sortDir = isActive ? metricsSortState.direction : "none";
  });
}

function setupMetricsSortHeaders() {
  metricsSortHeaders.forEach((header) => {
    header.classList.add("sortable");
    header.addEventListener("click", () => {
      const field = header.dataset.sortField;
      if (!field) {
        return;
      }

      if (metricsSortState.field === field) {
        metricsSortState.direction = metricsSortState.direction === "asc" ? "desc" : "asc";
      } else {
        metricsSortState.field = field;
        metricsSortState.direction = field === "team" ? "asc" : "desc";
      }

      updateMetricsSortHeaderState();
      renderMetricsRows(metricsRowsCache);
    });
  });
  updateMetricsSortHeaderState();
}

function renderRows(rows) {
  tableBody.innerHTML = "";

  rows.forEach((row, index) => {
    const tr = document.createElement("tr");
    tr.appendChild(makeCell(index + 1));
    tr.appendChild(makeCell(row.team));
    tr.appendChild(makeCell(row.games));
    tr.appendChild(makeCell(row.runsScored));
    tr.appendChild(makeCell(row.runsAllowed));
    tr.appendChild(makeCell(row.pythagoreanWinPct.toFixed(3)));
    tableBody.appendChild(tr);
  });
}

function renderMetricsRows(rows) {
  if (!metricsTableBody) {
    return;
  }

  metricsRowsCache = Array.isArray(rows) ? [...rows] : [];
  metricsTableBody.innerHTML = "";

  const sortedRows = getSortedMetricsRows(metricsRowsCache);

  sortedRows.forEach((row) => {
    const tr = document.createElement("tr");
    const offenseRpg = row.games > 0 ? row.runsScored / row.games : null;
    const defenseRpg = row.games > 0 ? row.runsAllowed / row.games : null;

    tr.appendChild(makeCell(row.team));
    tr.appendChild(makeCell(row.games));
    tr.appendChild(makeCell(formatNumber(offenseRpg, 1)));
    tr.appendChild(makeCell(formatNumber(defenseRpg, 1)));
    tr.appendChild(makeCell(formatNumber(row.battingAvg, 3)));
    tr.appendChild(makeCell(formatNumber(row.hrPerGame, 1)));
    tr.appendChild(makeCell(formatNumber(row.teamEra, 2)));
    tr.appendChild(makeCell(formatNumber(row.teamWhip, 3)));
    tr.appendChild(makeCell(formatNumber(row.bullpenUsagePerGame, 2)));
    tr.appendChild(makeCell(formatNumber(row.kbbRatio, 2)));

    metricsTableBody.appendChild(tr);
  });
}

function renderDailyPredictions(payload) {
  const modeSummary = Array.isArray(payload.predictions)
    ? payload.predictions.every((g) => g.mode === "post_lineup")
      ? "post-lineup"
      : "mixed/pre-lineup"
    : "-";
  const fallbackLabel = payload.fallbackUsed
    ? ` · 다음 경기일 자동전환(+${payload.fallbackDepth || 1})`
    : "";
  dailyDateText.textContent = `${payload.dateText || payload.date} · ${payload.modelVersion || "model-unknown"} · ${modeSummary}${fallbackLabel}`;
  dailyPredictionsList.innerHTML = "";

  if (!Array.isArray(payload.predictions) || payload.predictions.length === 0) {
    dailyPredictionsList.innerHTML = '<p class="daily-empty">해당 날짜에 예측 가능한 경기가 없습니다.</p>';
    return;
  }

  payload.predictions.forEach((game) => {
    const isPreLineup = game.confidenceLevel === "pre_lineup";
    const awayStarterDisplay = String(game.awayStarter || "").trim();
    const homeStarterDisplay = String(game.homeStarter || "").trim();
    const hasAnyStarterName = Boolean(awayStarterDisplay || homeStarterDisplay);
    const showStarterLine = hasAnyStarterName || currentLeague === "kbo";
    const awayStarterName = awayStarterDisplay || "미발표";
    const homeStarterName = homeStarterDisplay || "미발표";
    const awayProb = formatPercent(game.awayWinProbability);
    const homeProb = formatPercent(game.homeWinProbability);
    const mlHomeProb = formatPercent(
      Number.isFinite(game.mlHomeWinProbability)
        ? game.mlHomeWinProbability
        : game.homeWinProbability,
    );
    const mlAwayProb = formatPercent(
      Number.isFinite(game.mlAwayWinProbability)
        ? game.mlAwayWinProbability
        : game.awayWinProbability,
    );
    const awayProbWidth = (game.awayWinProbability * 100).toFixed(1);
    const homeProbWidth = (game.homeWinProbability * 100).toFixed(1);
    const confidence = getConfidence(
      Math.abs(game.homeWinProbability - game.awayWinProbability),
      game.lineupConfirmed,
    );
    const bettingTag = String(game.bettingTag || "주의").trim() || "주의";
    const bettingReason = String(game.bettingReason || "").trim();
    const bettingTagClass = bettingTag === "추천"
      ? "recommend"
      : bettingTag === "회피"
        ? "avoid"
        : "caution";
    const saberApplied = game.modelFeatures?.saberApplied === true;
    const totalOver85Text = Number.isFinite(game.modelFeatures?.monteCarloTotalOver85Prob)
      ? formatPercent(game.modelFeatures.monteCarloTotalOver85Prob)
      : null;
    const awayScoreOneText = Number.isFinite(game.modelFeatures?.awayScoreAtLeastOneProb)
      ? formatPercent(game.modelFeatures.awayScoreAtLeastOneProb)
      : null;
    const homeScoreOneText = Number.isFinite(game.modelFeatures?.homeScoreAtLeastOneProb)
      ? formatPercent(game.modelFeatures.homeScoreAtLeastOneProb)
      : null;
    const saberExtraMetaRows = [
      totalOver85Text
        ? `<div class="meta-row"><span class="meta-tag alt">총점 O8.5 확률(MC)</span><span>${totalOver85Text}</span></div>`
        : "",
      awayScoreOneText && homeScoreOneText
        ? `<div class="meta-row"><span class="meta-tag alt">1점 이상 득점확률(MC)</span><span>원정 ${awayScoreOneText} / 홈 ${homeScoreOneText}</span></div>`
        : "",
    ].filter(Boolean).join("");
    const hasActualResult =
      Number.isFinite(game.actualAwayScore)
      && Number.isFinite(game.actualHomeScore)
      && game.gameState === "3";

    const actualResultBlock = hasActualResult
      ? `<div class="daily-actual">실제 결과: ${game.awayTeam} ${game.actualAwayScore} : ${game.actualHomeScore} ${game.homeTeam}</div>`
      : "";

    let hitBadge = "";
    if (hasActualResult && game.predictionHit === true) {
      hitBadge = '<span class="daily-hit-badge hit">예측 적중</span>';
    } else if (hasActualResult && game.predictionHit === false) {
      hitBadge = '<span class="daily-hit-badge miss">예측 빗나감</span>';
    }

    const starterLine = showStarterLine
      ? `
      <div class="daily-starters-grid">
        <div class="starter-col">
          <p class="starter-role">원정 선발</p>
          <p class="starter-name">${awayStarterName}</p>
          <p class="starter-era">ERA ${formatEra(game.awayStarterEra)}</p>
        </div>
        <div class="starter-vs">VS</div>
        <div class="starter-col right">
          <p class="starter-role">홈 선발</p>
          <p class="starter-name">${homeStarterName}</p>
          <p class="starter-era">ERA ${formatEra(game.homeStarterEra)}</p>
        </div>
      </div>`
      : "";

    const item = document.createElement("article");
    item.className = "daily-item";
    const headToHeadBlock = renderHeadToHeadMetrics(game);
    const kboLineupBlock = renderKboLineupBlock(game);
    item.innerHTML = `
      <div class="daily-top">
        <span class="daily-time">${game.gameTime}</span>
        <span class="daily-stadium">${game.stadium}</span>
        <span class="daily-bet-badge ${bettingTagClass}">${bettingTag}</span>
        <span class="daily-mode ${isPreLineup ? "pre" : "post"}">${isPreLineup ? "PRE" : "POST"}</span>
        <span class="daily-saber-badge ${saberApplied ? "on" : "off"}">${saberApplied ? "세이버 보정 적용" : "세이버 보정 대기"}</span>
      </div>
      <div class="daily-matchup">
        <div class="team-side away-side">
          <span class="team-chip away">원정</span>
          <span class="team-name-main">${game.awayTeam}</span>
        </div>
        <span class="matchup-vs">VS</span>
        <div class="team-side home-side">
          <span class="team-name-main">${game.homeTeam}</span>
          <span class="team-chip home">홈</span>
        </div>
      </div>
      ${starterLine}
      ${kboLineupBlock}
      <div class="daily-prob-row">
        <span>${game.awayTeam}(원정) ${awayProb}</span>
        <span>${game.homeTeam}(홈) ${homeProb}</span>
      </div>
      <div class="daily-model-meta">
        <div class="meta-row"><span class="meta-tag">최종 결정확률</span><span>원정 ${awayProb} / 홈 ${homeProb}</span></div>
        <div class="meta-row"><span class="meta-tag alt">순수 ML확률</span><span>원정 ${mlAwayProb} / 홈 ${mlHomeProb}</span></div>
        ${saberExtraMetaRows}
      </div>
      <div class="daily-prob-bar">
        <div class="daily-prob-away" style="width:${awayProbWidth}%"></div>
        <div class="daily-prob-home" style="width:${homeProbWidth}%"></div>
      </div>
      <div class="daily-scoreline">${isPreLineup ? "잠정 스코어" : "예상 스코어"}: ${game.awayTeam} ${game.predictedAwayScore} : ${game.predictedHomeScore} ${game.homeTeam}</div>
      <div class="daily-gap">예상 점수차: ${game.predictedWinner} ${game.predictedRunDiff?.toFixed(1) ?? "-"}점 우세</div>
      ${bettingReason ? `<div class="daily-bet-reason">베팅 시그널: ${bettingReason}</div>` : ""}
      ${actualResultBlock}
      ${headToHeadBlock}
      <div class="daily-winner">예상 승리팀: <strong>${game.predictedWinner}</strong> <span class="confidence">(${confidence})</span> ${hitBadge}</div>
      ${isPreLineup ? `<div class="daily-note">${game.predictionNote || "라인업 발표 전 예측입니다."}</div>` : ""}
    `;
    dailyPredictionsList.appendChild(item);
  });
}

async function loadDailyPredictions() {
  dailyPredictionsList.innerHTML = '<p class="daily-empty">게임센터 일정 기반 자동 예측을 계산 중...</p>';

  try {
    const response = await fetch(
      `/api/predictions/gameday?homeAdvantage=${HOME_ADVANTAGE_RATE.toFixed(3)}`,
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderDailyPredictions(payload);
    return payload;
  } catch (error) {
    dailyPredictionsList.innerHTML = `<p class="daily-empty">자동 예측 로드 실패: ${error.message}</p>`;
    return null;
  }
}

async function loadData() {
  const leagueLabel = "KBO";
  statusText.textContent = `${leagueLabel} 데이터를 불러오는 중...`;

  try {
    const response = await fetch(resolveApiUrl(FIXED_EXPONENT, "kbo"));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderRows(payload.rows);
    renderMetricsRows(payload.rows);
    const dailyPayload = await loadDailyPredictions();
    renderModelStatus(dailyPayload);

    const updatedTime = new Date(payload.updatedAt).toLocaleString("ko-KR", {
      hour12: false,
    });
    statusText.textContent = `${leagueLabel} 총 ${payload.teamCount}개 팀 / ${updatedTime} 업데이트`;
  } catch (error) {
    tableBody.innerHTML = "";
    if (metricsTableBody) {
      metricsTableBody.innerHTML = "";
    }
    metricsRowsCache = [];
    dailyDateText.textContent = "-";
    if (modelStatusRow) {
      modelStatusRow.innerHTML = "";
    }
    dailyPredictionsList.innerHTML = '<p class="daily-empty">게임센터 자동 예측을 불러오지 못했습니다.</p>';
    statusText.textContent = `데이터 로드 실패: ${error.message}. npm start 실행 후 http://localhost:3000 으로 접속해 주세요.`;
  }
}

refreshButton.addEventListener("click", loadData);
setupMetricsSortHeaders();
loadData();
