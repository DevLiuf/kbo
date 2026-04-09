# KBO 피타고리안 승률 계산기

KBO 공식 기록 페이지의 팀 타자/투수 데이터를 읽어서 팀별 피타고리안 승률을 계산하는 간단한 웹 앱입니다.

추가로, 계산된 피타고리안 승률을 기반으로 게임센터 일정의 다음 경기 승률을 예측합니다.
게임센터 자동 예측에서는 경기별 예상 스코어(몇 대 몇), 예상 점수차, pre-lineup/post-lineup 모드를 함께 제공합니다.
KBO 경기 카드에서는 선발 정보와 함께 1~9번 타순 라인업(원정/홈)을 함께 표시합니다.

## 실행 방법

```bash
npm install
npm start
```

기본 `npm start`는 KBO 전용 모드로 실행됩니다.

브라우저에서 `http://localhost:3000` 접속

주의: `public/index.html` 파일을 직접 열면(`file://`) API를 호출할 수 없어 데이터 로딩에 실패합니다. 반드시 위 주소로 접속하세요.

## 데이터 소스

- 타자 팀 기록: `https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx`
- 투수 팀 기록: `https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx`

## 계산식

`승률 = RS^x / (RS^x + RA^x)`

- `RS`: 득점 (타자 팀 기록의 `R`)
- `RA`: 실점 (투수 팀 기록의 `R`)
- `x`: 지수, 기본값 `1.83`

## API

- `GET /api/teams/pythagorean?exponent=1.83`
- `exponent` 범위: `0.1` ~ `10`
- `GET /api/predictions/gameday?date=YYYYMMDD&homeAdvantage=0.03`
- `homeAdvantage`는 홈팀에 더하는 확률(기본 `0.03`, 즉 +3.0%p)
- `includeFinished=true`를 주면 종료 경기까지 포함해서 조회할 수 있습니다 (기본값 `false`: 경기예정만)
- 기본값(`includeFinished=false`)에서 해당 날짜 예정 경기가 없으면 다음 경기일로 자동 전환해 보여줍니다.
- 응답 메타: `asOfTimestamp`, `modelVersion`
- 경기별 필드: `mode`, `lineupConfirmed`, `heuristicHomeWinProbability`, `mlHomeWinProbability`, `homeWinProbability`, `predictedAwayScore`, `predictedHomeScore`, `predictedRunDiff`
- 결정 기준 필드: `decisionBasis` (`ml_centered`)
- 주요 모델 피처: `offenseDiff`, `defenseDiff`, `starterEraDiff`, `battingAvgDiff`, `hrPerGameDiff`, `whipDiff`, `bullpenDiff`, `lineupSignal`
- 라인업 확정 경기에서는 세이버 득점 보정값(`markovAwayRuns`, `markovHomeRuns`, `monteCarloAwayRuns`, `monteCarloHomeRuns`, `saberExpectedAwayRuns`, `saberExpectedHomeRuns`)이 `modelFeatures`에 포함됩니다.
- KBO 백테스트(20260331~20260407, 40경기) 기준 세이버 블렌드 기본값은 `baseline 0.7 / Markov 0.25 / MonteCarlo 0.05`, 신뢰 클램프는 `2.5`를 사용합니다.
- 게임별 자동 베팅 시그널(`추천`/`주의`/`회피`)과 사유(`bettingReason`)를 API/카드에 함께 제공합니다.
- 해석용 필드: `topContributors` (각 경기 확률에 크게 기여한 상위 피처)

현재 `예상 승리팀`과 `예상/잠정 스코어`는 ML 확률(`mlHomeWinProbability`, pre-lineup에서는 shrink 적용)을 기준으로 계산됩니다.
화면에는 `최종 결정확률`(승리팀/스코어 반영)과 `순수 모델확률(ML)`을 함께 표시합니다.

## 모델 스냅샷

- 요청 시점의 피처/예측은 `data/prediction_snapshots.ndjson`에 누적 저장됩니다.
- 이 파일을 기반으로 이후 로지스틱 회귀/XGBoost 학습 데이터셋으로 확장할 수 있습니다.

## 학습 워크플로우 (baseline logistic)

1. 경기 결과 수집

```bash
npm run ml:fetch-results -- --from=20260401 --to=20260430
```

2. 스냅샷 + 결과 조인으로 학습 예제 생성

```bash
npm run ml:build-examples
```

예제가 부족할 때는 먼저 스냅샷 백필을 수행하세요.

```bash
npm run ml:backfill-snapshots -- --from=20260401 --to=20260405 --includeFinished=true
```

전체 스냅샷을 새 피처 기준으로 다시 쌓으려면 초기화 모드를 사용하세요.

```bash
npm run ml:backfill-snapshots -- --from=20260331 --to=20260409 --includeFinished=true --baseUrl=https://kbo-predictor.vercel.app --resetSnapshots=true
```

주의: 백필은 `/api/predictions/gameday` 응답을 로컬 `data/prediction_snapshots.ndjson`에 저장합니다. `--resetSnapshots=true`를 주면 기존 파일을 비우고 다시 기록합니다.

현재 서비스는 KBO 전용입니다.

3. 로지스틱 회귀 계수 학습

```bash
npm run ml:train -- --input=data/training_examples.kbo.ndjson --output=data/model_coefficients.kbo.json --holdoutDays=3
```

4. 모델 평가

```bash
npm run ml:eval -- --input=data/training_examples.kbo.ndjson --model=data/model_coefficients.kbo.json
```

5. 일일 자동 재학습(새벽 1회)

```bash
npm run ml:retrain-kbo
```

기본값:
- KBO는 개막일(`YYYY0331`, 또는 `KBO_OPENING_DAY=YYYYMMDD` 지정값)부터 오늘(`YYYYMMDD`)까지 결과 재수집
- `holdoutDays=3`
- KBO API 호출 실패 시 `fetch-results` 3회 재시도(기본 7초 간격)
- 학습 예제가 너무 적으면(`minExamples=30`) 재학습 중단(기존 모델 유지)
- 리그 선택 인자는 더 이상 사용하지 않습니다(KBO 전용)

옵션 예시:

```bash
npm run ml:retrain-daily -- --from=20260331 --to=20260405 --holdoutDays=3 --retryCount=4 --retryDelayMs=10000 --minExamples=40
```

실행 상태는 `data/daily_retrain_status.kbo.json`에 저장됩니다.
기존 모델이 있으면 학습 전 `data/model_coefficients.kbo.backup.json`으로 백업합니다.

학습 결과는 `data/model_coefficients.kbo.json`에 저장되고, 서버는 KBO 모델만 로드해 추론에 반영합니다.
학습 시 마지막 N일을 검증 세트로 고정(time-split)하며, 검증 구간 logits에 대해 Platt calibration(`plattA`, `plattB`)을 학습해 확률 보정을 적용합니다.

### ML 학습 vs 세이버 보정 튜닝

- `ML`은 **학습(training)** 대상입니다. 경기 결과가 반영된 `training_examples.kbo.ndjson`로 계수(`model_coefficients.kbo.json`)를 다시 학습합니다.
- 세이버 보정은 **튜닝(tuning)** 대상입니다. Markov/MonteCarlo 계산은 예측 시점마다 실행되고, 블렌드 가중치/클램프(예: `0.7/0.25/0.05`, `2.5`)를 백테스트로 조정합니다.
- 운영 원칙: 라인업 갱신 시에는 재학습이 아니라 **재예측(inference)** 을 수행하고, ML 학습은 일일 배치(`ml:retrain-kbo`)로 반영합니다.

### 보조 PC 원클릭 실행

보조 PC에서 ML 학습 + 세이버 튜닝을 한 번에 실행:

Windows에서는 `quick-train-tune.bat`를 더블클릭하면 바로 실행됩니다.
- 기본값: `--from=20260331 --baseUrl=https://kbo-predictor.vercel.app`
- 커스텀 실행 예시(CMD): `quick-train-tune.bat --from=20260331 --to=20260409 --baseUrl=https://kbo-predictor.vercel.app`
- 필수: Node.js LTS(권장 v18+) 설치 후 `node -v`가 동작해야 합니다.
- 최신 BAT는 `node` PATH가 없어도 기본 설치 경로(`C:\Program Files\nodejs\node.exe`)를 자동 탐색합니다.
- 기본 BAT 실행은 `--autoPush=true`로 동작합니다(학습/튜닝 성공 후 `git add/commit/push` 자동 시도).
- 단, 현재 폴더가 Git 저장소가 아니면 자동 푸시는 건너뜁니다(`autoPush: skipped`, reason 표시).

```bash
npm run ml:helper-pc -- --from=20260331 --to=20260408 --baseUrl=https://kbo-predictor.vercel.app
```

실행 후 산출물:
- `data/model_coefficients.kbo.json`
- `data/saber_tuning_status.kbo.json`

웹 배포 반영(보조 PC에서):

```bash
git add data/model_coefficients.kbo.json data/saber_tuning_status.kbo.json
git commit -m "Update ML model and saber tuning outputs"
git push
```

## 배팅태그 수익성 백테스트

- 목적: 카드의 `추천/주의/회피` 태그가 실제 수익(ROI) 관점에서 유효한지 검증합니다.
- 출력: 경기별 CSV + 요약 JSON(`overall`, `byTag`, `strategies`)을 `data/backtests`에 저장합니다.

```bash
npm run ml:export-betting-profit -- --from=20260331 --to=20260407 --baseUrl=http://localhost:3000
```

옵션 예시(가정 배당/스테이크 변경):

```bash
npm run ml:export-betting-profit -- --from=20260331 --to=20260407 --recommendOdds=1.95 --cautionOdds=1.90 --recommendStake=1 --cautionStake=0.5
```

서버는 KBO 원본 요청에 타임아웃을 적용하고, 팀 수가 비정상일 경우(형식 변경 추정) `502` 에러를 반환합니다.

## cron (새벽 1회) 예시

macOS/Linux에서 크론 편집:

```bash
crontab -e
```

매일 실행 예시(Asia/Seoul):

```cron
CRON_TZ=Asia/Seoul
10 4 * * * cd /Users/liuf/kbo && mkdir -p /Users/liuf/kbo/logs && /usr/bin/env npm run ml:retrain-kbo >> /Users/liuf/kbo/logs/daily-retrain-kbo.log 2>&1
```

권장:
- 서버가 꺼져 있어도 동작하도록 `scripts/retrain-daily.js` 단독 파이프라인으로 운영
- 로그 파일(`logs/daily-retrain.log`)과 `data/daily_retrain_status.json`을 함께 확인
- 실패가 반복되면 `data/model_coefficients.backup.json` 기준으로 모델 롤백 가능
