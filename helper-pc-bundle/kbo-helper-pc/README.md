# KBO 승부 예측

KBO 공식 팀 기록, 선발투수, 라인업을 읽어 경기 승률과 예상 스코어를 제공하는 웹앱입니다. 미니PC helper는 경기 전 예측을 보관하고, 결과 수집·모델 학습·세이버 튜닝·배포 확인을 담당합니다.

`추천/주의/회피`는 **승부 우세 신호**입니다. 실제 시장배당 대비 기대수익이나 베팅 수익을 보장하지 않습니다.

## 실행 환경

- Node.js **20.18.1 이상**. 지원 중인 LTS 버전 사용을 권장합니다.
- 웹앱은 Git 체크아웃에서 실행합니다. helper 압축본은 미니PC 배치용이며 웹 서버 실행용이 아닙니다.

```bash
npm ci
npm start
```

브라우저에서 `http://localhost:3000`에 접속합니다. HTML 파일을 직접 열면 API를 사용할 수 없습니다.

## 예측의 의미

- 팀 피타고리안 승률: `RS^1.83 / (RS^1.83 + RA^1.83)`.
- ML은 팀 공격·수비, 선발, 라인업의 **반올림하지 않은 피처**를 사용합니다.
- 라인업 확정 후 판단확률은 ML 보정 확률입니다. 강한 우세라는 이유로 90%·92%로 올리지 않습니다.
- 라인업 확정 전에는 모델의 `preLineupShrink`로 50% 쪽에 수축한 판단확률과 순수 ML 확률을 함께 표시합니다.
- 예상 승리팀은 판단확률이 높은 팀입니다. 정확히 동률이면 홈팀을 선택합니다.
- 예상 스코어는 승리팀 방향을 반영한 대표 스코어이며, 기대 득점 평균과 동일하지 않습니다.
- Markov·Monte Carlo 득점 보정은 라인업이 준비된 경기에서 적용합니다. 튜닝과 서버가 같은 계산식을 사용합니다.
- 기존 모델은 보존하지만, 독립 검증 메타데이터가 없는 모델은 화면에 `검증 미확인 모델`로 표시합니다. 기존 튜닝을 새 검증 결과로 간주하지 않습니다.

## 경기 전 아카이브: 학습의 전제

유효한 스냅샷은 피처 스키마 2, 예정 경기 상태, 서울시간 경기일, 실제 경기 시작 시각, 그리고 **시작보다 엄격히 앞선 수집 시각**을 가져야 합니다. 학습과 평가에는 경기별 마지막 유효 스냅샷을 사용합니다. 피처는 서버 추론에 사용한 값 그대로 보관합니다.

과거 날짜를 현재 누적 기록으로 다시 계산한 응답, 경기 중·종료 후 응답, 시각을 검증할 수 없는 구형 스냅샷은 학습에 사용하지 않습니다. 백필은 오늘 이후의 실제 경기 전 데이터만 수집하며 과거 예측을 만들어내지 않습니다.

웹 API 조회는 아카이브에 쓰지 않습니다. 수집기는 경기·라인업 모드·스키마별 최신 유효 스냅샷을 보관하고, 기존 데이터는 삭제하지 않습니다. 기존 `--resetSnapshots` 옵션도 아카이브를 비우지 않습니다.

**업데이트 직후 표본 부족으로 학습이 실패할 수 있습니다.** 기존 데이터의 시각·스키마를 임의로 새 버전으로 바꾸지 마세요. 실제 경기 전 데이터를 먼저 축적해야 합니다. 표본 부족은 정상 모델을 유지하는 실패 상태이지 학습 성공이 아닙니다.

## 미니PC 운영

### 1. 경기 전 수집

미니PC의 작업 스케줄러에서 경기 시작 전 시간대에 10분 간격으로 실행합니다. 주말·평일 시작 시각이 다르므로 실제 경기 시간을 포함하는 수집 시간대를 설정합니다.

```bash
node scripts/helper-pc-train-and-tune.js --collectOnly=true --fetchResults=false --baseUrl=https://kbo-predictor.vercel.app
```

수집 전용 실행은 모델 학습·튜닝·push를 하지 않습니다. 예정 경기가 없거나 이미 시작한 경기만 있으면 새 학습 스냅샷은 생기지 않습니다.

### 2. 경기 종료 후 학습·튜닝

```bash
npm run ml:helper-pc -- --autoPush=true --baseUrl=https://kbo-predictor.vercel.app
```

`from` 기본값은 해당 연도 3월 31일입니다. 실제 개막일이 다르면 `--from=YYYYMMDD` 또는 `KBO_OPENING_DAY`로 지정합니다. `to` 기본값은 서울시간 오늘입니다.

처리 순서:

1. 오늘 이후 유효 경기 전 스냅샷 수집. 과거 범위는 기존 아카이브를 사용합니다.
2. 신규 결과와 최근 정정 구간 수집. 기본 `correctionDays=3`, 경기 키로 기존 결과와 병합합니다.
3. 무승부·결과 미완료·누락 점수를 제외해 원래 피처로 학습 예제를 생성합니다.
4. 날짜순 학습 / 확률 보정 / 최종 평가 구간으로 나누어 학습합니다.
5. 보관된 경기 전 득점 입력으로 세이버를 튜닝하고, 뒤쪽 별도 날짜에서 평가합니다.
6. 검증된 산출물을 교체한 후 선택적으로 push하고, 배포된 파일 해시를 확인합니다.

직접 재학습 기본값은 `minExamples=30`, `holdoutDays=3`, `calibrationDays=1`입니다. 학습·보정·평가 구간은 겹치지 않아야 하며 보정 구간에는 양쪽 승리 라벨과 최소 3개 표본이 필요합니다. 세이버 최소 유효 표본은 20개이고 적어도 두 경기일이 필요합니다.

승패 모델은 무승부를 제외한 경기의 이진 승패를 예측합니다. 득점 튜닝·MAE에서는 무승부 경기도 평가할 수 있습니다.

### 안전장치와 실패 확인

- HTTP·JSON·수집 실패, 표본 부족, 잘못된 날짜·피처, 비정상 지표는 종료 코드 1입니다.
- 독립 승패 평가의 Log loss는 `ln(2)`, Brier는 `0.25` 이하이어야 합니다. 세이버 검증 MAE는 기본 설정보다 나빠서는 안 됩니다.
- 새 모델과 튜닝은 임시 위치에서 검증한 뒤 교체합니다. 검증 실패 시 기존 활성 모델·튜닝을 보존합니다.
- 성공적으로 수집한 아카이브와 결과는 이후 학습 실패에도 남겨 다음 실행에 사용할 수 있습니다.
- helper 동시 실행은 배타 잠금으로 차단합니다. 실행 중에는 미니PC의 코드·데이터를 덮어쓰지 마세요.
- 자동 push는 Git 저장소 안에서만 가능합니다. 다른 작업이 이미 stage되어 있으면 중단합니다. 자동 rebase는 하지 않습니다.
- push 후 `/api/model/status`의 모델 버전·모델 파일 SHA-256·세이버 설정 SHA-256이 일치해야 `verified`입니다.
- 배포 확인은 기본 8회, 간격 15초입니다. `--verifyAttempts`, `--verifyDelayMs`, `--timeoutMs`로 조정합니다. `--verifyDeployment=false`면 `pushed_unverified`이며 배포 확인 성공이 아닙니다.
- push/배포 확인 실패는 비정상 종료하고 이유를 남깁니다. 이미 push된 변경을 자동으로 되돌리지는 않습니다.

상태 파일:

- `data/helper_status.kbo.json`: 단계, 실패 원인, 코드 버전, 모델·설정 해시, 배포 상태.
- `data/daily_retrain_status.kbo.json`: 학습 표본과 독립 평가 구간·지표.
- `data/saber_tuning_status.kbo.json`: 튜닝·검증 표본과 구간, MAE, 최적 설정.

주요 배포 상태는 `not_deployed`, `pushed`, `pushed_unverified`, `verified`, `failed`입니다. `ok: true`만 보고 웹 반영까지 완료됐다고 판단하지 마세요.

### Windows 실행과 압축본 갱신

`quick-train-tune.bat`는 Node를 탐색하고 실행 폴더를 선택합니다. Git 체크아웃 모드에서는 기본 자동 push를 사용하고, 단독 압축본은 배포 없이 로컬 산출물을 생성합니다. 수집 전용 인자를 넘길 수도 있습니다.

```bat
quick-train-tune.bat --collectOnly=true --fetchResults=false --baseUrl=https://kbo-predictor.vercel.app
```

압축본은 루트 소스에서 자동 생성합니다. 루트·미니PC 코드를 별도로 수정하지 않습니다.

```bash
npm run helper:bundle
```

생성물은 `helper-pc-bundle/kbo-helper-pc.zip`이며 파일별 해시는 `bundle-manifest.json`에 기록합니다. 생성에는 `zip` 명령이 필요합니다. 압축본에 운영 데이터는 포함하지 않으므로 **미니PC의 기존 `data` 폴더를 보존하면서** 코드를 갱신합니다. 서버를 먼저 새 API로 배포한 후 미니PC 수집기를 갱신하세요.

## 로컬 학습·평가 명령

경기 전 아카이브가 축적된 뒤 실행합니다. 날짜는 보유 데이터 범위에 맞춥니다.

```bash
npm run ml:fetch-results -- --from=20260401 --to=20260430
npm run ml:build-examples -- --from=20260401 --to=20260430
npm run ml:train -- --holdoutDays=3 --calibrationDays=1
npm run ml:eval
npm run ml:tune-saber -- --from=20260401 --to=20260430
```

학습·평가 기본 파일은 KBO 전용 파일입니다. `ml:eval`은 모델의 최종 평가 구간만 사용합니다. 각 명령에서 `--input`, `--output`, `--snapshots`, `--results`, `--model` 등 해당 명령의 파일 인자를 지정할 수 있습니다. `--fetchResults=false`를 사용한 helper는 저장된 결과만 이용합니다.

## 오프라인 백테스트

백테스트는 저장된 경기 전 예측과 종료 결과를 조인합니다. 과거 경기 API를 다시 호출해 오늘의 기록으로 평가하지 않습니다. 제거된 `--baseUrl` 옵션은 명시적 오류를 반환합니다.

```bash
npm run ml:export-backtest -- --from=20260401 --to=20260430
npm run ml:export-betting-profit -- --from=20260401 --to=20260430 --recommendOdds=1.95 --cautionOdds=1.90
npm run ml:tune-confidence -- --from=20260401 --to=20260430
npm run ml:walk-forward -- --from=20260415 --to=20260430 --trainFrom=20260401
```

- 내보내기에는 `--snapshots`, `--results`, `--outDir`로 로컬 입력·출력 위치를 지정할 수 있습니다.
- 승패 정확도에서 무승부는 제외하고 득점 MAE에는 포함합니다. 가정 배당 수익 시뮬레이션은 무승부를 원금 환급으로 처리하고 `voidCount`를 별도 집계합니다.
- 수익 시뮬레이션은 **사용자가 지정한 가정 배당**의 결과일 뿐 실제 시장 수익성 검증이 아닙니다.
- 신뢰도 튜닝은 뒤쪽 날짜를 별도 검증합니다. 하루만 있으면 독립 검증 없음으로 표시합니다.
- walk-forward는 이전 날짜의 유효 학습 예제로 임시 모델을 학습하고 다음 날짜를 평가하는 오프라인 ML 평가입니다. 활성 서비스 모델을 교체하지 않습니다. `--input` 또는 `--snapshots/--results`를 지정할 수 있습니다.

## API

- `GET /api/teams/pythagorean?exponent=1.83`: KBO 10개 팀 기록과 피타고리안 승률. 지수 범위 `0.1~10`.
- `GET /api/predictions/gameday?date=YYYYMMDD&homeAdvantage=0.03&includeFinished=false`: 경기 예측. 홈 어드밴티지 범위 `-0.2~0.2`.
- `GET /api/model/status`: 외부 KBO 조회 없이 실제 로드된 모델·적용 설정·파일 해시 확인. `Cache-Control: no-store`.

예측 응답은 `featureSchemaVersion`, `modelHash`, `modelValidationIndependent`, `saberSettings`, `saberSettingsHash`, `saberSettingsSource`, `signalKind: matchup_strength`를 제공합니다. 경기별 `features`는 반올림하지 않은 ML 입력, `scoreModelInputs`는 세이버 보정 전 baseline과 Markov·Monte Carlo 입력입니다. `gameStartsAt`, `asOfTimestamp`, `trainingEligible`로 경기 전 데이터 여부를 확인할 수 있습니다.

`includeFinished=true`의 과거 경기 응답은 현재 기록 기반 참고 재계산이며 사전 예측 성능의 증거가 아닙니다. 학습·백테스트는 로컬 아카이브만 사용합니다.

공식 데이터: [KBO 팀 타자](https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx), [팀 투수](https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx), [게임센터](https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx).

## 검증

```bash
npm test
```

회귀 테스트는 경기 전 시점 경계, 원래 피처 보존, 무승부, 독립 보정·평가, 실패 시 산출물 보존, 오프라인 평가, 모델·설정 해시를 확인합니다. 테스트는 임시 데이터와 로컬 HTTP fixture를 사용하며 실제 운영 학습·push를 하지 않습니다.

## 1.2.0 변경

강제 확률·홈 우선 판정 제거, 스키마 2 경기 전 아카이브, 정밀 피처 학습, 무승부 처리, 독립 검증, 공통 세이버 계산과 실제 튜닝 적용, 배치 실패 차단·증분 수집·배포 해시 확인, 동일 소스 helper bundle로 전환했습니다. 기존 운영 모델·데이터를 자동 삭제하거나 검증된 새 데이터로 위장하지 않습니다.
