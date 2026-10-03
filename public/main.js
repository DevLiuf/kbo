const statusText = document.getElementById("statusText");
const tableBody = document.getElementById("tableBody");
const metricsTableBody = document.getElementById("metricsTableBody");
const metricsSortHeaders = Array.from(document.querySelectorAll("#metricsTable th[data-sort-field]"));
const refreshButton = document.getElementById("refreshButton");
const dailyDateText = document.getElementById("dailyDateText");
const dailyPredictionsList = document.getElementById("dailyPredictionsList");
const dailySummaryList = document.getElementById("dailySummaryList");
const modelStatusRow = document.getElementById("modelStatusRow");

const FIXED_EXPONENT = 1.83;
const metricsSortState = {
  field: null,
  direction: "asc",
};
let metricsRowsCache = [];
const currentLeague = "kbo";
let html2CanvasLoaderPromise = null;

function ensureHtml2CanvasLoaded() {
  if (typeof window.html2canvas === "function") {
    return Promise.resolve(window.html2canvas);
  }

  if (html2CanvasLoaderPromise) {
    return html2CanvasLoaderPromise;
  }

  html2CanvasLoaderPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js";
    script.async = true;
    script.onload = () => {
      if (typeof window.html2canvas === "function") {
        resolve(window.html2canvas);
      } else {
        reject(new Error("html2canvas load failed"));
      }
    };
    script.onerror = () => {
      reject(new Error("Failed to load html2canvas"));
    };
    document.head.appendChild(script);
  });

  return html2CanvasLoaderPromise;
}

function sanitizeFileNamePart(value) {
  return String(value || "")
    .trim()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/[^0-9A-Za-z가-힣_-]/g, "");
}

function buildPredictionCardFileName(card) {
  const date = sanitizeFileNamePart(card?.dataset?.gameDate) || "date";
  const awayTeam = sanitizeFileNamePart(card?.dataset?.awayTeam) || "away";
  const homeTeam = sanitizeFileNamePart(card?.dataset?.homeTeam) || "home";
  const time = sanitizeFileNamePart(card?.dataset?.gameTime) || "time";
  return `kbo-prediction-${date}-${time}-${awayTeam}-vs-${homeTeam}.png`;
}

async function downloadPredictionCardImage(cardElement, triggerButton) {
  if (!cardElement || !triggerButton) {
    return;
  }

  const originalLabel = triggerButton.textContent;
  triggerButton.disabled = true;
  triggerButton.textContent = "저장중...";

  try {
    const html2canvas = await ensureHtml2CanvasLoaded();
    cardElement.classList.add("capture-mode");
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const canvas = await html2canvas(cardElement, {
      scale: 2,
      useCORS: true,
      backgroundColor: null,
      width: cardElement.offsetWidth,
      height: cardElement.offsetHeight,
      windowWidth: Math.max(window.innerWidth, cardElement.offsetWidth),
      ignoreElements: (element) => element.classList?.contains("capture-exclude"),
    });

    const link = document.createElement("a");
    link.download = buildPredictionCardFileName(cardElement);
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (error) {
    alert(`이미지 저장 실패: ${error.message}`);
  } finally {
    cardElement.classList.remove("capture-mode");
    triggerButton.disabled = false;
    triggerButton.textContent = originalLabel;
  }
}

function resolveApiUrl(exponent, league) {
  const isHttp = window.location.protocol === "http:" || window.location.protocol === "https:";
  const baseUrl = isHttp ? "" : "http://localhost:3000";
  return `${baseUrl}/api/teams/pythagorean?exponent=${exponent}&league=${league}`;
}

function formatPercent(value) {
  return `${(value * 100).toFixed(1)}%`;
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
  if (!modelStatusRow) return;
  const range = (value) => value?.from && value?.to
    ? `${formatCompactDate(value.from)}~${formatCompactDate(value.to)}` : "-";
  const ready = payload?.status === "ready";
  modelStatusRow.innerHTML = `
    <span class="model-status-pill app"><span class="model-status-label">웹 버전</span><span class="model-status-value">${escapeHtml(payload?.appVersion || "-")}</span></span>
    <span class="model-status-pill model"><span class="model-status-label">확정 라인업 득점 모델</span><span class="model-status-value">${ready ? "예측 준비 완료" : "예측 제공 불가"}</span><span class="model-status-range">${escapeHtml(payload?.modelType || "-")} · 스키마 ${escapeHtml(payload?.featureSchemaVersion ?? "-")}</span>${!ready && payload?.unavailableReason ? `<span class="model-status-range">${escapeHtml(payload.unavailableReason)}</span>` : ""}</span>
    <span class="model-status-pill validation"><span class="model-status-label">학습 · 독립 검증</span><span class="model-status-value">${payload?.modelValidationIndependent === true ? "독립 검증 확인" : "독립 검증 미확인"}</span><span class="model-status-range">최근 학습 ${formatCompactDate(payload?.modelTrainedAt)} · 학습 ${range(payload?.modelTrainingRange)} · 검증 ${range(payload?.modelValidationRange)}</span></span>
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
      ops: entry?.ops !== null && entry?.ops !== "" && Number.isFinite(Number(entry?.ops))
        ? Number(entry.ops) : null,
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

function renderKboLineupBlock(game, leadingBlock = "") {
  const awayLineup = normalizeLineup(game.awayLineup);
  const homeLineup = normalizeLineup(game.homeLineup);
  const hasLineup = awayLineup.length > 0 || homeLineup.length > 0;
  const awaitingLineup = game.unavailableCode === "LINEUP_UNCONFIRMED";
  const readinessText = game.lineupConfirmed ? "라인업 확정" : awaitingLineup ? "라인업 확정 대기" : "확정 라인업 기록 없음";
  const helperText = awaitingLineup
    ? "공식 타순이 확정되기 전에는 수치 예측을 제공하지 않습니다."
    : "이 경기의 검증된 경기 전 라인업 기록을 제공할 수 없습니다.";

  if (!hasLineup) {
    return `<div class="daily-lineup">${leadingBlock}<p class="lineup-head">타순 라인업 · ${readinessText}</p><p class="lineup-empty">${helperText}</p></div>`;
  }

  return `<div class="daily-lineup">${leadingBlock}<p class="lineup-head">타순 라인업 · ${readinessText}</p><div class="lineup-grid">${renderLineupColumn(awayLineup, `${game.awayTeam} (원정)`)}${renderLineupColumn(homeLineup, `${game.homeTeam} (홈)`)}</div></div>`;
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
  const inputs = game.modelInputs;
  const diagnostics = inputs?.diagnostics || game.diagnostics;
  if (!diagnostics?.away || !diagnostics?.home) return "";
  const { away, home } = diagnostics;
  const metrics = [
    { label: "확정 라인업 OPS", away: away.lineupOps, home: home.lineupOps, digits: 3 },
    { label: "선발 FIP", away: away.starter?.fip, home: home.starter?.fip, digits: 2, lowerIsBetter: true },
    { label: "선발 예상 이닝", away: away.starter?.expectedInnings, home: home.starter?.expectedInnings, digits: 2, compare: false },
    { label: "실제 구원투수 불펜 FIP", away: away.bullpen?.fip, home: home.bullpen?.fip, digits: 2, lowerIsBetter: true },
    { label: "불펜 최근 3일 투구수", away: away.bullpen?.pitches3d, home: home.bullpen?.pitches3d, digits: 0, compare: false },
    { label: "모델 기대 득점", away: game.expectedAwayRuns, home: game.expectedHomeRuns, digits: 2 },
  ];
  const rows = metrics.map((metric) => {
    const edge = metric.compare === false ? "관측값" : getHeadToHeadEdge(metric.away, metric.home, metric.lowerIsBetter);
    const edgeClass = edge === "홈 우세" ? "home" : edge === "원정 우세" ? "away" : "draw";
    return `<tr><td class="h2h-label">${metric.label}</td><td>${formatMetricValue(metric.away, metric.digits)}</td><td>${formatMetricValue(metric.home, metric.digits)}</td><td><span class="h2h-edge ${edgeClass}">${edge}</span></td></tr>`;
  }).join("");
  const windowLabel = (side) => side.bullpen?.window
    ? `${formatCompactDate(side.bullpen.window.from)}~${formatCompactDate(side.bullpen.window.to)} · 관측 ${side.bullpen.games ?? "-"}경기` : "관측 기간 미제공";
  return `<div class="daily-h2h"><p>확정 라인업 · 투수 지표 <span class="h2h-legend">(FIP는 낮을수록 유리)</span></p><p class="h2h-legend">불펜 관측 기간: 원정 ${escapeHtml(windowLabel(away))} / 홈 ${escapeHtml(windowLabel(home))}</p><table><thead><tr><th>지표</th><th>원정</th><th>홈</th><th>비교</th></tr></thead><tbody>${rows}</tbody></table></div>`;
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

function isPredictionReady(game) {
  return game.status === "ready" && game.lineupConfirmed === true
    && ["awayWinProbability", "homeWinProbability", "tieAfterNineProbability",
      "expectedAwayRuns", "expectedHomeRuns", "predictedAwayScore", "predictedHomeScore"]
      .every((key) => Number.isFinite(game[key]));
}

function predictionReadinessLabel(game) {
  return game.unavailableCode === "LINEUP_UNCONFIRMED" ? "라인업 확정 대기" : "예측 제공 불가";
}

function renderProbabilityBlock(game) {
  return `<p class="daily-prob-label">9이닝 승부 결정 시 승리 확률</p>
    <div class="daily-prob-row"><span>${escapeHtml(game.awayTeam)}(원정) ${formatPercent(game.awayWinProbability)}</span><span>${escapeHtml(game.homeTeam)}(홈) ${formatPercent(game.homeWinProbability)}</span></div>
    <div class="daily-prob-bar" aria-hidden="true"><div class="daily-prob-away" style="width:${game.awayWinProbability * 100}%"></div><div class="daily-prob-home" style="width:${game.homeWinProbability * 100}%"></div></div>`;
}

function renderDailySummary(predictions) {
  if (!dailySummaryList) return;
  dailySummaryList.innerHTML = (Array.isArray(predictions) ? predictions : []).map((game) => {
    const ready = isPredictionReady(game);
    return `<article class="daily-summary-item">
      <div class="summary-status"><span class="daily-mode ${ready ? "post" : "pending"}">${ready ? "확정 라인업" : predictionReadinessLabel(game)}</span></div>
      <div class="summary-team summary-away"><span class="summary-team-name">${escapeHtml(game.awayTeam)}</span><span class="summary-team-side">원정</span></div>
      <div class="summary-prob">${ready ? renderProbabilityBlock(game) : `<p class="daily-unavailable-reason">${escapeHtml(game.unavailableReason || "공식 라인업 또는 검증된 모델 데이터가 준비되지 않았습니다.")}</p>`}</div>
      <div class="summary-team summary-home"><span class="summary-team-name">${escapeHtml(game.homeTeam)}</span><span class="summary-team-side">홈</span></div>
    </article>`;
  }).join("");
}

function renderStarterBlock(game) {
  const name = (starter) => typeof starter === "object" && starter
    ? starter.name || starter.playerName || "미발표" : starter || "미발표";
  const diagnostics = game.modelInputs?.diagnostics || game.diagnostics;
  const side = (key, label) => {
    const starter = diagnostics?.[key]?.starter;
    return `<div class="starter-col${key === "home" ? " right" : ""}"><p class="starter-role">${label} 선발</p><p class="starter-name">${escapeHtml(name(game[`${key}Starter`] || starter))}</p>${starter ? `<p class="starter-metric">FIP ${formatMetricValue(starter.fip, 2)}</p><p class="starter-metric">예상 이닝 ${formatMetricValue(starter.expectedInnings, 2)}</p>` : ""}</div>`;
  };
  return `<div class="daily-starters-grid">${side("away", "원정")}<div class="starter-vs">VS</div>${side("home", "홈")}</div>`;
}

function renderDailyPredictions(payload) {
  dailyDateText.textContent = `${payload.dateText || payload.date || "-"} · 확정 라인업 전용 · ${payload.modelVersion || "검증 모델 대기"}`;
  dailyPredictionsList.innerHTML = "";
  renderDailySummary(payload.predictions);
  if (!Array.isArray(payload.predictions) || payload.predictions.length === 0) {
    dailyPredictionsList.innerHTML = '<p class="daily-empty">해당 날짜에 예정된 경기가 없습니다.</p>';
    return;
  }
  payload.predictions.forEach((game) => {
    const ready = isPredictionReady(game);
    const away = escapeHtml(game.awayTeam);
    const home = escapeHtml(game.homeTeam);
    const hasActual = game.gameState === "3" && Number.isFinite(game.actualAwayScore) && Number.isFinite(game.actualHomeScore);
    const actual = hasActual ? `<div class="daily-actual">실제 결과: ${away} ${game.actualAwayScore} : ${game.actualHomeScore} ${home}</div>` : "";
    const archived = ready && game.predictionSource === "archived_pregame";
    const hit = archived && hasActual && typeof game.predictionHit === "boolean"
      ? `<span class="daily-hit-badge ${game.predictionHit ? "hit" : "miss"}">${game.predictionHit ? "예측 적중" : "예측 빗나감"} · 경기 전 보관 예측</span>` : "";
    let forecast = "";
    if (ready) {
      const diff = game.expectedHomeRuns - game.expectedAwayRuns;
      const edge = Math.abs(diff) < 1e-9 ? "양 팀 기대 득점 동일"
        : `${diff > 0 ? home : away} 기대 득점 ${Math.abs(diff).toFixed(2)}점 우세`;
      forecast = `${renderProbabilityBlock(game)}
        <div class="daily-model-meta"><div class="meta-row"><span class="meta-tag">기대 득점</span><span>원정 ${game.expectedAwayRuns.toFixed(2)} / 홈 ${game.expectedHomeRuns.toFixed(2)}</span></div>
        <div class="meta-row"><span class="meta-tag alt">9이닝 동점 확률</span><span>${formatPercent(game.tieAfterNineProbability)}</span></div></div>
        <div class="daily-scoreline">대표 스코어: ${away} ${game.predictedAwayScore} : ${game.predictedHomeScore} ${home}</div>
        <div class="daily-gap">${edge}</div>
        <p class="daily-note">대표 스코어는 득점 분포의 최빈 조합으로 동점일 수 있습니다. 승리 확률은 9이닝 동점을 제외한 조건부 확률이며, 9이닝 동점 확률은 연장 이후 최종 무승부 확률이 아닙니다.</p>
        ${renderHeadToHeadMetrics(game)}`;
    } else {
      forecast = `<div class="daily-unavailable" role="status"><strong>${predictionReadinessLabel(game)}</strong><p>${escapeHtml(game.unavailableReason || "공식 라인업 또는 검증된 모델 데이터가 준비되지 않아 예측을 제공할 수 없습니다.")}</p></div>`;
    }
    const item = document.createElement("article");
    item.className = `daily-item${ready ? "" : " unavailable"}`;
    item.dataset.gameDate = String(game.gameDate || payload.date || "");
    item.dataset.gameTime = String(game.gameTime || "");
    item.dataset.awayTeam = String(game.awayTeam || "");
    item.dataset.homeTeam = String(game.homeTeam || "");
    item.innerHTML = `
      <div class="daily-top"><span class="daily-time">${escapeHtml(game.gameTime || "")}</span><span class="daily-stadium">${escapeHtml(game.stadium || "")}</span>
      <span class="daily-mode ${ready ? "post" : "pending"}">${ready ? "확정 라인업" : predictionReadinessLabel(game)}</span>
      <button type="button" class="daily-download-btn capture-exclude" aria-label="경기 카드 이미지 저장">카드 저장</button></div>
      <div class="daily-card-body"><div class="daily-card-main">
      <div class="daily-matchup"><div class="team-side away-side"><span class="team-chip away">원정</span><span class="team-name-main">${away}</span></div><span class="matchup-vs">VS</span><div class="team-side home-side"><span class="team-name-main">${home}</span><span class="team-chip home">홈</span></div></div>
      ${forecast}<div class="daily-card-footer">${actual}${hit}</div></div>
      <div class="daily-card-details">${renderKboLineupBlock(game, renderStarterBlock(game))}</div></div>`;
    dailyPredictionsList.appendChild(item);
  });
}

async function loadDailyPredictions() {
  dailyPredictionsList.innerHTML = '<p class="daily-empty">게임센터 일정 기반 자동 예측을 계산 중...</p>';
  renderDailySummary([]);

  try {
    const response = await fetch(
      "/api/predictions/gameday",
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();
    renderDailyPredictions(payload);
    return payload;
  } catch (error) {
    dailyPredictionsList.innerHTML = `<p class="daily-empty">자동 예측 로드 실패: ${error.message}</p>`;
    renderDailySummary([]);
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
    await Promise.all([
      loadDailyPredictions(),
      (async () => {
        try {
          const modelResponse = await fetch("/api/model/status");
          if (!modelResponse.ok) throw new Error(`HTTP ${modelResponse.status}`);
          renderModelStatus(await modelResponse.json());
        } catch (error) {
          renderModelStatus({ status: "unavailable", unavailableReason: `모델 상태 조회 실패: ${error.message}` });
        }
      })(),
    ]);

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
      renderDailySummary([]);
    statusText.textContent = `데이터 로드 실패: ${error.message}. npm start 실행 후 http://localhost:3000 으로 접속해 주세요.`;
  }
}

refreshButton.addEventListener("click", loadData);
dailyPredictionsList.addEventListener("click", (event) => {
  const downloadButton = event.target.closest(".daily-download-btn");
  if (!downloadButton) {
    return;
  }

  const cardElement = downloadButton.closest(".daily-item");
  downloadPredictionCardImage(cardElement, downloadButton);
});
setupMetricsSortHeaders();
loadData();
