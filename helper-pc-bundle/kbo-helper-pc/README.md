# KBO 확정 라인업 승부 예측

KBO 공식 기록을 읽어 **양 팀 타순 확정 후에만** 기대 득점과 승리 확률을 계산하는 웹앱입니다. 미니PC helper는 경기 전 입력 보관, 경기 결과 수집, 득점 모델 학습·독립 검증과 선택적 배포를 담당합니다.

**새 모델은 실제 경기 전 입력이 축적되고 독립 검증에 통과하기 전까지 예측을 제공하지 않습니다.** 기존 승패 모델·세이버 튜닝 파일로 대체하거나 임의의 승률을 표시하지 않습니다.

## 실행

- Node.js **20.18.1 이상**, 지원 중인 LTS 권장.
- 웹앱은 Git 체크아웃에서 실행합니다. 미니PC 압축본은 배치 전용이며 웹 서버를 포함하지 않습니다.

```bash
npm ci
npm start
```

브라우저에서 `http://localhost:3000`에 접속합니다. HTML 파일을 직접 열면 API를 사용할 수 없습니다.

### 2.1.0 경기 전 자동 예약

Windows에서 공식 경기 시작 시각에 맞춰 30분 전부터 5분 간격으로 수집 작업을 자동 등록합니다. 하루 종일 반복하지 않으며 기존 02시 학습 작업은 변경하지 않습니다. 설치 명령과 로그인 조건은 아래 경기 전 수집 절을 참고하세요.

### 2.0.1 의존성 보안 수정

간접 의존성을 `body-parser 2.3.0`, `qs 6.16.0`, `undici 7.30.0`으로 갱신했습니다. Git 코드를 갱신한 뒤 `npm ci`로 동일한 잠금파일을 설치하세요. `whatwg-encoding`의 deprecated 안내는 설치 실패나 취약점 진단과 별개이며 남아 있을 수 있습니다. `npm audit`로 현재 취약점을 확인하고, 미니PC에서 임의로 `npm audit fix --force`를 실행하지 마세요.

## 예측 모델과 화면의 의미

모델 타입은 `confirmed-lineup-poisson-v1`, 입력 스키마는 **3**입니다. 원정·홈 득점 평균을 같은 계수의 Poisson 회귀로 학습합니다.

```text
log(기대 득점) = log(리그 팀 경기당 득점) + 절편
              + β타선 × log(확정 타선 OPS / 리그 OPS)
              + β투구 × log(상대 예상 투구 FIP / 리그 ERA)
              + β불펜 × 상대 불펜 최근 투구량
              + β구장 × log(최근 구장 득점 환경)
              + β홈 × 홈 여부
```

- 타격·투구·불펜 소모·구장 계수는 음수가 되지 않도록 학습합니다. 홈 계수는 절댓값 `0.3` 이내로 제한합니다.
- 타선의 `OPS = OBP + SLG`는 실제 `AB/H/TB/BB/HBP/SF` 기록으로 계산합니다. 타자별 리그 평균 100 PA 사전값으로 소표본을 수축한 뒤 1~9번에 `[9,8,7,6,5,4,3,2,1]` 기회 가중치를 적용합니다. WAR 차이를 타선 점수로 대신하지 않습니다.
- 선발 FIP는 월별 기록에서 **실제 선발 등판**의 HR·BB·HBP·K·이닝을 합산합니다. 예상 이닝은 최근 최대 5번의 실제 선발 이닝 평균입니다. 구원 등판이 섞인 `IP/G`로 대신하지 않습니다.
- 불펜 FIP는 이전 **14일의 모든 완료 경기**에서 실제 구원 등판만 합산합니다. 최근 투구량은 0~3일 전 구원 투구수에 `[1,1,0.5,0.25]`를 곱한 합계/100입니다. 같은 날 선행 경기는 실제 종료 시점을 입증할 수 있을 때만 포함합니다. 개별 투수의 오늘 사용 가능성을 안다고 가정하지 않습니다.
- FIP 상수는 실제 리그 ERA와 HR·BB·HBP·K·이닝으로 산출하며, 투구 표본은 관측 리그 FIP의 60아웃 사전값으로 수축합니다. 상대 예상 투구 FIP는 선발 예상 이닝과 남은 불펜 이닝으로 가중합니다.
- 구장 환경은 같은 14일간 해당 구장의 실제 경기 총득점을 리그 총득점과 비교하고 10경기 사전값으로 수축합니다. 해당 구장 표본 자체가 없으면 예측 불가입니다. 확정된 인과적 구장 효과가 아니라 최근 관측 득점 환경입니다.
- 사전값은 **실제 작은 표본을 안정화**하기 위한 것입니다. 누락된 선수·경기 기록을 평균으로 채우는 fallback은 없습니다.

원정·홈 득점 분포로 승패와 9이닝 동점 확률을 구합니다.

- 표시 승률은 **9이닝에 동점이 아닐 때의 조건부 승리 확률**입니다. 원정·홈 승률 합은 1입니다.
- `tieAfterNineProbability`는 **9이닝 동점 확률**입니다. 연장 이후 최종 무승부 확률이 아닙니다.
- 기대 득점은 분포 평균, 대표 스코어는 양 팀 분포의 최빈 조합입니다. 대표 스코어가 동점이어도 한 팀의 조건부 승률이 높을 수 있습니다. 승리팀에 맞추려고 스코어를 바꾸지 않습니다.
- 강한 우세라는 이유로 90%·92%를 지정하거나, 별도 승패 모델·확률 보정·Markov·Monte Carlo를 섞지 않습니다. 베팅 추천 태그도 제공하지 않습니다.
- 팀 피타고리안 표는 참고 기록입니다. 경기 예측에 다시 혼합하지 않습니다. 팀 `SV+HLD/G`, 팀 K/BB 역시 실제 불펜 투구량·불펜 전용 기록이 아닙니다.

## 경기 전 수집: 첫 학습의 필수 조건

유효 입력은 스키마 3, 예정 상태, 양 팀 공식 라인업 확정, 검증된 `modelInputs`, 서울시간 경기일, 실제 시작 시각과 **시작보다 엄격히 이른 수집 시각**을 갖춰야 합니다. 데이터 기준 시각은 수집 시각보다 늦을 수 없습니다. 학습에는 경기별 마지막 유효 입력을 사용합니다.

웹 API 조회는 파일에 쓰지 않습니다. 미니PC에서 **경기 시작 전 수집 작업을 별도로 실행해야 합니다.** 02시 학습만 실행하면 이미 시작·종료된 경기의 입력을 복원할 수 없습니다.

```bash
node scripts/helper-pc-train-and-tune.js --collectOnly=true --fetchResults=false --baseUrl=https://kbo-predictor.vercel.app
```

### Windows 자동 예약: 시작 시각 입력 불필요

Git 작업 폴더를 갱신한 뒤, 수집에 사용할 Windows 계정의 CMD에서 한 번 실행합니다. Node.js 22 LTS를 권장합니다.

```bat
cd /d C:\kbo
git pull --ff-only origin main
npm ci
node scripts/auto-collect-pregame.js --install
```

- `KBO-AutoCollect-Plan`: 매일 서울시간 03:00 및 해당 계정 로그인 시 공식 당일 일정을 조회합니다. 설치 직후에도 조회합니다.
- `KBO-AutoCollect-YYYYMMDD`: 실제 시작 **30·25·20·15·10·5분 전**에만 실행합니다. 시작 시간이 같은 경기는 한 번에 처리합니다. 24시간 5분 반복은 없습니다.
- 각 실행에서 공식 일정을 다시 조회하고 남은 예약을 갱신합니다. 취소·진행·종료·비정규시즌 경기는 제외합니다. 일정 조회 실패 시 이전 예약을 지우지 않고 실패로 종료합니다.
- 시작 전 30분보다 이른 입력과 시작 이후 입력은 보관하지 않습니다. 시간이 늦어진 경기에는 남은 예약을 다시 잡습니다. 경기 없는 날에는 일별 수집 작업을 만들지 않습니다.
- 기존 **02시 `kbo-helper` 결과 수집·학습·배포 작업은 그대로 유지**합니다. 앞서 수동으로 만든 경기 전 반복 작업이 있다면 중복 실행을 막기 위해 사용 안 함으로 바꾸세요.
- **설치한 계정이 로그인된 상태여야 합니다.** 화면 잠금은 가능하지만 로그아웃 상태에서는 실행되지 않습니다. Windows 시간대를 `(UTC+09:00) 서울`로 맞추고, 수집 시간에는 PC와 네트워크가 켜져 있어야 합니다. 절전 해제는 Windows의 깨우기 타이머 설정에도 좌우됩니다.
- 로그인·03시 조회 이후 새로 추가되거나 크게 앞당겨진 경기는 다음 조회 전까지 놓칠 수 있습니다. 일정 변경을 알게 된 경우 `node scripts/auto-collect-pregame.js`를 실행해 즉시 다시 예약합니다.
- 설치나 실행 실패는 종료 코드 1입니다. 작업 스케줄러의 마지막 실행 결과와 `data/helper_status.kbo.json`의 `stage: "collected"`, `snapshotRowsCollected`를 확인하세요. `0`은 새 유효 입력이 없다는 뜻이며 학습·배포 성공을 뜻하지 않습니다.

예약 변경 없이 공식 일정과 예정 수집 시각을 확인하는 명령(Windows 외에서도 사용 가능):

```bash
node scripts/auto-collect-pregame.js --preview
```

아래 유효 입력 규칙은 수동·자동 수집에 공통으로 적용됩니다.

- 새 모델이 아직 없어도 모든 필수 입력을 수집한 응답은 `trainingEligible=true`로 보관합니다. 예측 숫자는 계속 `null`입니다. 이 입력으로 첫 모델을 학습합니다.
- 타순 미확정, 선수 식별·기록 불일치, 누락된 날짜·박스스코어·구장 표본, 경기 시작 등은 명시적인 예측 불가 사유입니다.
- 오늘 이전의 기록은 다시 계산하지 않습니다. 오늘 이후라도 현재 서울 날짜의 실제 경기 전 기록만 유효합니다.
- 기존 아카이브는 보존합니다. 구형 스키마·경기 후 수집 기록을 스키마 3으로 바꾸거나 과거 예측으로 위장하지 않습니다.
- 진행·종료 경기에는 유효한 경기 전 **수치 예측**이 보관되어 있을 때만 그 예측을 표시합니다. 입력만 보관했거나 기록이 없으면 예측 불가입니다.

## 02시 결과 수집·학습 작업

기존 예약 작업의 재학습 진입점은 `ml:retrain-daily` / `ml:retrain-kbo`를 유지합니다. 이 변경은 호스트의 예약 시각을 설정하거나 변경하지 않습니다. helper를 통해 배포까지 수행하는 작업은 다음 명령을 사용합니다.

```bash
npm run ml:helper-pc -- --autoPush=true --baseUrl=https://kbo-predictor.vercel.app
```

`from` 기본값은 KBO 공식 일정에서 조회한 해당 연도 정규시즌 개막일입니다. 조회 실패 시 임의의 날짜를 쓰지 않습니다. `--from=YYYYMMDD` 또는 `KBO_OPENING_DAY`로 명시할 수 있으며, `to` 기본값은 서울시간 오늘입니다.

처리 순서:

1. 당일 유효 입력 수집. 과거 입력은 기존 아카이브만 사용합니다.
2. 신규 결과와 최근 정정 구간 수집·병합. 기본 `correctionDays=3`.
3. 스키마 3 경기 전 입력과 실제 정수 득점으로 학습 예제 생성. 무승부도 득점 학습에 포함합니다.
4. 날짜순 학습/독립 검증으로 분리하고 공통 득점 계수를 학습합니다. 기본 `minExamples=30`, `holdoutDays=3`.
5. 검증의 Poisson NLL·득점 MAE·승패 Log loss·Brier가 **학습 구간만으로 만든 리그 득점/홈 승리 비율 기준선**보다 나쁘지 않은지 확인합니다. 무승부는 승패 지표에서 제외합니다.
6. 통과한 산출물만 임시 위치에서 활성 파일로 교체합니다. 선택적으로 push한 뒤 배포된 타입·스키마·버전·모델 SHA-256·독립 검증 상태를 확인합니다.

### 실패와 배포 확인

- 데이터 수집 오류, 표본 부족, 겹치는 학습·검증 날짜, 검증 지표 악화는 종료 코드 1입니다. 실패를 학습 성공으로 보고하지 않습니다.
- 검증 실패 시 기존 활성 **새 득점 모델**을 보존합니다. 처음 실행할 때 새 모델이 없으면 예측 불가 상태가 유지됩니다.
- 성공적으로 수집한 입력과 결과는 이후 학습 실패에도 보존됩니다. 동시 배치는 배타 잠금으로 차단합니다.
- 자동 push는 Git 저장소 안에서만 가능합니다. 다른 변경이 stage되어 있으면 중단하고 자동 rebase하지 않습니다. 자동 배포 대상은 새 모델과 일일 학습 상태입니다.
- 배포 확인 기본값은 8회, 간격 15초입니다. `--verifyAttempts`, `--verifyDelayMs`, `--timeoutMs`로 조정합니다.
- `--verifyDeployment=false`는 `pushed_unverified`이며 배포 확인 성공이 아닙니다. 압축본 단독 실행은 `not_deployed`입니다.
- 상태는 `data/helper_status.kbo.json`, `data/daily_retrain_status.kbo.json`에서 확인합니다. `ok:true`만 보고 웹 반영까지 끝났다고 판단하지 마세요.
- 새 활성 모델은 `data/run_model.kbo.json`, 예제는 `data/run_training_examples.kbo.ndjson`입니다. 기존 모델·튜닝 데이터는 자동 삭제하지 않지만 새 예측 경로에서 읽지 않습니다.

### Windows와 미니PC 압축본

```bat
quick-train-tune.bat --collectOnly=true --fetchResults=false --baseUrl=https://kbo-predictor.vercel.app
```

기존 배치 파일명과 helper 진입점은 유지하되 내용은 새 득점 모델 배치입니다. Git 체크아웃에서는 기본 자동 push, 단독 압축본에서는 로컬 실행입니다. 인자를 지정하면 필요한 `--autoPush`도 직접 지정하세요.

```bash
npm run helper:bundle
```

압축본은 `helper-pc-bundle/kbo-helper-pc.zip`이며 루트 소스로 생성합니다. 파일별 해시는 `bundle-manifest.json`에 기록합니다. 생성에 `zip` 명령이 필요합니다. **운영 데이터는 포함하지 않으므로 미니PC의 기존 `data` 폴더를 보존하면서 코드를 갱신하세요.**

## 로컬 학습과 오프라인 평가

아래 날짜는 예시이며 실제 보유 경기 전 입력 범위에 맞춰야 합니다.

```bash
npm run ml:fetch-results -- --from=20260401 --to=20260430
npm run ml:build-examples -- --from=20260401 --to=20260430
npm run ml:train -- --holdoutDays=3
npm run ml:eval
npm run ml:export-backtest -- --from=20260401 --to=20260430
npm run ml:walk-forward -- --from=20260415 --to=20260430 --trainFrom=20260401
```

- 평가와 백테스트는 로컬 아카이브만 사용합니다. 과거 API 재계산 옵션 `--baseUrl`은 오류입니다.
- 평가 명령은 모델의 독립 검증 구간을 사용합니다. 스코어 MAE에는 무승부를 포함하고 승패 지표에서는 제외합니다.
- walk-forward는 각 평가 날짜 이전의 학습·검증 구간만 사용합니다. 활성 모델을 교체하지 않습니다.
- `--fetchResults=false`는 저장된 결과를 사용합니다. 파일 위치는 각 명령의 `--input/--output/--snapshots/--results/--model/--outDir` 인자로 지정합니다.
- 기존 `--calibrationDays`, 세이버·신뢰도·추천 정책 옵션과 관련 명령은 제거했습니다. 새 모델에 적용된 것처럼 조용히 무시하지 않습니다.

## API

- `GET /api/teams/pythagorean?exponent=1.83`: 10개 팀 기록. 지수 범위 `0.1~10`.
- `GET /api/predictions/gameday?date=YYYYMMDD&includeFinished=false`: 경기 예측. 기본 날짜는 서울시간 오늘. 종료 경기는 `includeFinished=true`일 때 포함합니다. 진행 경기는 포함하되 경기 전 기록이 없으면 예측 불가입니다.
- `GET /api/model/status`: 현재 새 모델의 타입·스키마·파일 해시·학습/검증 구간과 준비 상태. 외부 KBO 조회 없이 동작합니다.

모델/예측 응답에는 `Cache-Control:no-store`를 적용합니다. `homeAdvantage`는 제거된 인자이며 400을 반환합니다. 홈 효과는 회귀 계수로 학습합니다. 다른 리그와 잘못된 달력 날짜도 400입니다. 상위 데이터 요청 실패는 503이며 일부 경기의 필수 입력 부족은 경기별 `status:unavailable`와 사유 코드로 표시합니다.

준비된 경기에는 `expectedAwayRuns/expectedHomeRuns`, `predictedAwayScore/predictedHomeScore`, 조건부 `awayWinProbability/homeWinProbability`, `tieAfterNineProbability`, 반올림하지 않은 `modelInputs`, 출처·표본 `diagnostics`가 있습니다. `predictionSource`는 `live_pregame` 또는 `archived_pregame`입니다. 예측 불가 경기의 수치 필드는 `null`입니다. 첫 학습용 입력은 `trainingEligible=true`일 때만 보관합니다.

공식 출처: [팀 타자](https://www.koreabaseball.com/Record/Team/Hitter/Basic1.aspx), [팀 투수](https://www.koreabaseball.com/Record/Team/Pitcher/Basic1.aspx), [게임센터](https://www.koreabaseball.com/Schedule/GameCenter/Main.aspx). 현재 수집기는 정규시즌 기록 계약만 지원하며 다른 시리즈·연도 자료는 대체하지 않고 차단합니다.

## 검증과 2.0.0 변경

```bash
npm test
```

2.0.0은 확정 타순 OPS·실제 선발 FIP/이닝·실제 구원 등판·최근 구장 환경에 기반한 득점 분포로 완전히 전환합니다. 기존 승패 회귀·세이버 혼합·강제 확률·추천 태그와 관련 실행 명령을 제거했습니다. 기존 운영 데이터와 예약 설정은 자동 변경하지 않습니다.

회귀 테스트는 시점 경계, 득점·승패 확률 의미, 무승부, 독립 검증, 실패 시 활성 모델 보존과 오프라인 평가를 확인합니다. fixture 학습 성능은 프로그램 동작 증거일 뿐 실제 KBO 예측 정확도나 수익성의 증거가 아닙니다.
