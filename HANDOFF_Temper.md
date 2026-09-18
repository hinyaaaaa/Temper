# Temper — 引き継ぎ書

更新日: 2026-09-17（2回目の改修）
対象リポジトリ: `hinyaaaaa/Temper`
構成: `index.html` / `manifest.webmanifest` / `js/{app,planner,store,weather}.js` / `icons/*.png`

---

## 0. この版での変更（前回からの差分）

| 依頼 | 対応 |
|---|---|
| 平日/休日は基本システム自動判定、手動切替は設定タブのみ | 今日タブのトグルを削除。設定タブの切替はそのまま残した |
| タスク一覧を負荷・期限で並び替え | タスクタブに「期限順／負荷順」の並び替えを追加 |
| 週次タスクの登録 | 種別（単発/毎週）＋曜日選択を追加。データモデルを拡張（§1参照） |
| 設定タブの文字量・情報量を削減 | 説明文・登録件数カードを削除、見出しも短縮（§4参照） |
| ホーム画面アイコンが描画されない／モノクロで潰れる | base64で直接埋め込み＋意匠を再設計（§5参照） |
| 完了後にキャパシティ変更すると今日の消化分がリセットされる | 根本原因を特定して修正（§6参照。**実際にあったバグ**） |

---

## 1. 週次タスク（データモデルの拡張）

タスクは `type: 'once' | 'weekly'` を持つ。

```
type: 'once'    // 従来通り。done / doneDate で一度きりの完了を表す
type: 'weekly'  // weekDays: [0-6の配列] が実施する曜日
                // doneDates: ['YYYY-MM-DD', ...] が完了した日付の集合
                // done / doneDate は使わない（常に false / null）
```

「今日はもう済んでいるか」の判定は `Store.isTaskDoneToday(task, dateStr)` に統一した。
週次タスクは `doneDates` にその日付が含まれるかで判定し、翌週にはまた候補へ戻る
（同じタスクIDのまま、日付が変わるだけで自動的に生きた候補になる）。

`planner.js` の `buildCandidates()` は、週次タスクについて
「今日がその曜日か」「その日まだ済んでいないか」「（もしあれば）シリーズの
終了日を過ぎていないか」で候補かどうかを決める。
**週次タスクの `deadline` は「毎回の締切」ではなく「この日以降はもう繰り返さない
（シリーズの終了日）」という意味で扱う** — §14の強制採用（期限超過・本日期限）の
対象にはしていない（`deadlineSortKey` が weekly には常に `Infinity` を返す）。

タスク一覧画面では、週次タスクは**「完了済み」フィルタに移らず、常に「未完了」側**
に数える（終わりのないシリーズであり、タスクの存在と個々の日の完了は別概念、
というSPEC §12の考え方の延長）。

TaskNOVAからのインポートも、`type:'weekly'` と `weekDays` をそのままTemperの
週次タスクとして取り込むよう更新した。旧版は「タイトルに（毎週）を付けた単発
タスクとして一度だけ複製する」という回避策だったが、週次を正式実装したことで
不要になった。

---

## 2. 並び替え（タスクタブ）

「期限順」「未完了/完了済み」フィルタの下に追加。

- **期限順**: `deadline` が近い順。週次タスクと期限なしタスクは末尾（`Infinity`扱い）。
- **負荷順**: `load` の降順（重いタスクが先頭）。

`taskSort` はページ内変数（`taskFilter` と同様、永続化しない一時的なUI状態）。

---

## 3. 今日の負荷が消えるバグの修正（実際にあったバグ）

### 症状
タスクを完了させた後にキャパシティ（平日/休日の容量）を変更すると、
「今日の負荷」の消化分（doneLoad）が消えて0になったように見えていた。

### 原因
`currentTodayPlan.entries` は `buildCandidates()` の結果から作られるが、
`buildCandidates()` は「今日まだ済んでいないタスク」しか候補にしない
（済んだタスクは候補から外れる）。タスクを完了させた直後は
`recomputeTodayPlan()` を呼ばずに `render()` だけしていたため、
古い（完了前の）`plan.entries` がメモリ上に残っており、そこに完了済み
タスクのエントリも一緒に残っていた ―― **これが今日の負荷「消化分」を
計算する唯一の拠り所になっていた**。

キャパシティを変更すると `onCapacityInput()` が `recomputeTodayPlan()` を
呼んでプランを作り直す。この再計算では `buildCandidates()` が完了済み
タスクを除外するため、`plan.entries` から完了済みタスクの記録が消え、
消化分の計算根拠ごと失われていた。

### 対策
「今日という日付の時点で完了しているか」を `plan.entries` に頼らず、
**`state.tasks` を直接見て** `Store.isTaskDoneToday(t, today)` で判定するように
変更した（`renderTodayPage()` 内）。これによりPlannerの再計算が何度走っても、
既に完了したタスクの負荷値は消えない。

修正の過程で**もう1つ、二重計上のバグ**も見つけて直した：
`totalLoad = doneLoad + plan.totalLoad` としていたが、`plan.totalLoad` は
「完了させる前の時点」の合計であり、完了させたタスクの負荷がそこに
まだ含まれたままだった。`doneLoad`（state.tasksから今日完了したものを合計）
と`plan.totalLoad`を足すと、完了させたタスクの負荷が二重に数えられて
しまう。`pendingEntries`（今日まだ済んでいないもののみ）から合計し直す
（`pendingLoad`）ことで解決した。

```js
const pendingEntries = plan.entries.filter((e) => !isTaskDoneToday(e.id, today));
const doneLoad = state.tasks.filter(t => Store.isTaskDoneToday(t, today))
                             .reduce((sum, t) => sum + (t.load || 0), 0);
const pendingLoad = pendingEntries.reduce((sum, e) => sum + e.load, 0);
const totalLoad = doneLoad + pendingLoad; // ここが二重計上しないための要
```

**この教訓は残しておく**: `currentTodayPlan` はあくまで「今この瞬間の
Plannerの提案」であり、過去に完了した事実の記録ではない。完了状態を
今後どこかに表示・集計する必要が出てきたら、必ず `state.tasks`
（永続化されている実体）を直接見ること。plan.entriesの残骸に頼らない。

---

## 4. 設定タブの簡素化

削除したもの:
- キャパシティカードの説明文（「○月○日は『休日』として計算しています。
  土日は既定で休日です。」）
- 天気トグルの説明文（「オフにすると常に晴れとして表示します」）
- データカードの説明文（「読み込みは追加のみで…」）
- 「登録済みのタスク」カード（未完了/完了/履歴の件数表示）まるごと

見出しも「1日の負荷キャパシティ」→「負荷キャパシティ」、
「今日の扱い」→「今日は」に短縮した。機能（インポート・エクスポート・
容量調整・平日休日切替）はすべて維持している。

---

## 5. ホーム画面アイコン（再設計）

### 「描画されない」問題への対応

前版は `<link rel="apple-touch-icon" href="./icons/icon-180.png">` と外部ファイルを
参照していた。この参照が失敗する経路（ホスティング環境やパスの状況、
manifestとの優先順位の食い違いなど）が考えられたため、**base64で直接
`index.html` に埋め込む**方式に変更した。ファイルの到達性に一切依存しない。
`manifest.webmanifest` の `icons` も同様に埋め込んだ（Android/PWA側の保険）。
`icons/*.png` ファイル自体は変更なく同梱している（README用途などに）。

埋め込んでもindex.htmlは54KB程度に収まっている（画像4枚で計30KB弱）。

### 「白黒（モノクロ/ティント表示）でのっぺりする」問題への対応

前版は「なめらかな空のグラデーション＋ぼかした光暈」というデザインで、
iOS 18のモノクロ/ティント表示（アイコンを単色化する表示モード）にすると
輪郭が失われ、ただの染みにしか見えなかった。**面（グラデーション）で
表現するデザインは単色化に弱い**という教訓を得て、方針を変えた:

- 背景はほぼフラットな単色（グラデーションは1〜2%の微差のみ）
- モチーフは「地平線に半分沈む太陽」1つに絞り、**輪郭を完全にシャープ**
  にする（ぼかしは一切使わない）
- 星は小さく硬い正方形（ぼかさない＝単色化しても消えない）
- 光暈・グロー等の装飾は廃止

円という単純な形は小サイズでも潰れず、単色化しても背景との明暗差だけで
形が残る。実際にグレースケール変換して確認済み（下記の検証方法参照）。
歯車やロゴ文字を使わない、という前版からの方針（アプリの空そのものを
縮図にする）は維持しつつ、単色化に強い形に絞った。

角丸は焼き込んでいない（iOS側がマスクを掛けるため、全面(full-bleed)で
用意するのが正しい、という前版の判断は維持）。

---

## 6. ファイル構成と責務（憲法6条: 分離の原則、変更なし）

| ファイル | 責務 | 依存 |
|---|---|---|
| `index.html` | 構造とスタイル | なし |
| `app.js` | 画面制御・DOM描画・イベント配線のみ | 他3つを呼ぶだけ |
| `planner.js` | 今日のタスク自動選定 | なし（純粋関数） |
| `store.js` | 保存・移行・インポート・設定値の解決・**「今日済んでいるか」の判定** | なし |
| `weather.js` | 天候取得・空の色の組み立て | なし |

`Store.isTaskDoneToday()` は一見「今日の状態」を扱うのでapp.js寄りに見えるが、
一発完了(once)と週次完了(weekly)でデータの持ち方が違うという**データモデルの
知識そのもの**なので、store.jsに置くのが正しい（app.jsはこの関数を呼ぶだけで、
doneとdoneDatesのどちらを見ればいいかを知らなくてよい）。

---

## 7. 検証方法（この環境固有の制約と回避策、変更なし）

- Playwrightの `browser_install` はネットワーク制限で失敗するため、
  `/home/claude/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome` を
  `executable_path` で直接指定する。
- サーバーとPlaywrightは同一のbash_tool呼び出し内で完結させること。
- Google Fontsは許可リストに無く403になる。スクリーンショットではZen Old Minchoが
  当たらないが、実機では読み込まれる。
- 時間帯・曜日を切り替えて確認するには `Date` を差し替える init script を使う。
- アイコンのモノクロ表示は `PIL` で `convert("L")` してグレースケール化することで
  簡易的に近似確認した（iOS実機の正確な変換アルゴリズムとは異なる可能性がある
  ため、**実機での最終確認を推奨**）。

### 今回実施した検証

- 週次タスクの候補生成（`buildCandidates`）を曜日別・完了日別に直接テスト
- 週次タスク作成→今日タブへの反映→完了→翌日には候補に戻ることをE2Eで確認
- 「完了済み」フィルタに週次タスクが決して現れないことを確認
- 並び替え（期限順/負荷順）の実際の並び順を取得して確認
- **キャパシティ変更後も消化分(消化 4)が保持されることをE2Eで確認**（§3のバグ修正）
- 全画面・全モーダルを巡回してコンソールエラーが出ないことを確認

---

## 8. まだ実機確認が必要な項目（前回から変更なし + 追加）

- 画面端の白帯が本当に消えたか（この環境からは検証不可能）
- ホーム画面アイコンが実際に描画されるか（今回のbase64化で解消したはずだが、
  実機での最終確認が必要）
- アイコンのモノクロ/ティント表示が実際に意図通り見えるか（iOS 18実機）
- `<input type="date">` の表示形式（OSロケール依存、このサンドボックスでは確認不可）
- 長押しでの詳細シート、ピンチ等の指の操作感
- Open-Meteoへの実接続
- `backdrop-filter` のパフォーマンス

---

## 9. 既知の簡略化・未実装（変更なし）

- Pattern推定は完全ルールベース。実データでの誤判定率は未検証。
- 天候手動設定（`manualWeatherCondition`）はデータモデルにあるが設定画面から
  変更できない。
- タスクの `description` はデータモデルに残っているが、UIからは入力も表示もしない。
- 祝日（土日以外）の扱い。今は日付単位の手動上書きのみで、祝日カレンダーは
  持っていない。

---

## 付録: Plannerナップサック法の検証コード（再現用、変更なし）

```js
import { buildTodayPlan } from './planner.js';

const today = '2026-09-12';
const tasks = [
  { id: '1', title: '英単語 暗記', load: 2, deadline: null, unlockDate: null, done: false, type: 'once' },
  { id: '3', title: '古文 読解', load: 3, deadline: '2026-09-13', unlockDate: null, done: false, type: 'once' },
  { id: '4', title: '化学 復習ワーク', load: 3, deadline: null, unlockDate: null, done: false, type: 'once' },
  { id: '6', title: '青チャート 発展問題', load: 4, deadline: null, unlockDate: null, done: false, type: 'once' },
  { id: '7', title: '過去問 実戦演習', load: 5, deadline: null, unlockDate: null, done: false, type: 'once' },
];
const plan = buildTodayPlan({ tasks, todayStr: today, baseCapacity: 8 });
// 期待値: 古文読解(3) + 化学復習ワーク(3) + 英単語暗記(2) = 8/8（3件、容量を使い切る）
console.log(plan.entries.map(e => ({ id: e.id, load: e.load })));
```

### 週次タスクの検証コード（今回追加）

```js
import { buildCandidates, buildTodayPlan } from './planner.js';

const today = '2026-09-17'; // 木曜(4)
const tasks = [
  { id: 'w1', title: '週次見直し', load: 2, type: 'weekly', weekDays: [4], doneDates: [], unlockDate: null, deadline: null },
  { id: 'w2', title: '週次(火曜のみ)', load: 2, type: 'weekly', weekDays: [2], doneDates: [], unlockDate: null, deadline: null },
  { id: 'w3', title: '週次(今日完了済み)', load: 2, type: 'weekly', weekDays: [4], doneDates: ['2026-09-17'], unlockDate: null, deadline: null },
];
console.log(buildCandidates(tasks, today).map(c => c.id)); // ['w1'] のみになるはず
```

---

## 10. アルゴリズムのシミュレーション検証（2026-09-17、3回目）

`simulate.mjs`（リポジトリ同梱、`node simulate.mjs`で実行）で、実際に
タスクを処理させるシミュレーションによりPlanner/Storeのロジックを検証した。
UIのスクリーンショット確認では気づけない、計算・アルゴリズムレベルの
バグを狙って洗い出すためのもの。**再発防止用の回帰テストとして残して
あるので、planner.js/store.jsを変更した際は必ず実行すること。**

### 検証内容

| Part | 内容 | 規模 |
|---|---|---|
| A | `buildTodayPlan`の単日ファジング。強制採用(§14)、重複選出無し、ナップサックの最適性をブルートフォースと突き合わせ等 | 5シード×3000パターン |
| B | 実運用を模した日次進行シミュレーション。ランダムなタイミングでキャパシティを変更し、消化負荷が保持されるかを毎回検証 | 8パターン、計2280日分、完了1810回、容量変更692回 |
| C | 週次タスクが毎週きちんと候補に戻ってくるかの決定的テスト | 6週間 |
| D | `summarizeImport`（確認シートの予測）と`importInto`（実際の結果）の整合性、再インポートの冪等性 | 3シード×1500パターン |
| E | 境界値・壊れたデータへの耐性（capacity=0/負、load=NaN/負、ID重複、うるう年境界、絵文字タイトル等） | — |
| F | タスク500件・容量200での性能と正しさ | — |

**総アサーション数: 306,414件、最終結果は全件通過。**

### 発見して修正したバグ

**`planner.js`: 負のload値がそのまま漏れて今日の負荷合計を狂わせるバグ。**

`task.load || 1` という書き方は「falsyな値（0/null/undefined/NaN）」しか
1に置き換えない。**負の値（例: -3）は truthy なのでそのまま素通りする。**
`knapsackSelect`内の容量計算だけは`Math.max(1, Math.round(...))`で
きちんとクランプされていたが、`toEntry`（entryの表示用load）と
`usedLoad`（今日の負荷合計の集計）はクランプされておらず、
「容量の消費は1として扱うのに、表示・合計は-3として扱う」という
内部的な不整合があった。

通常のUI操作では負荷スライダーが1〜10しか出せず、`store.js`の
`normalizeTask()`も保存前に`clampInt(load, 1, 10)`でクランプするため、
**実際のアプリ操作でこのバグを踏むことはまず無い。** 壊れた
localStorageデータや、将来Plannerを直接呼ぶ別の呼び出し元が
検証を経ていないデータを渡した場合の防御が抜けていた、という
位置づけ。念のため直しておいた。

修正: `safeLoad(rawLoad)`という単一のヘルパーを追加し、load値を
参照する8箇所（`toEntry`、`usedLoad`の加算、ソート時の比較、
`knapsackSelect`内、`orderToAvoidRuns`内）すべてをこれに統一した。

```js
function safeLoad(rawLoad) {
  const n = Math.round(Number(rawLoad));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}
```

### シミュレーションが「バグなし」と確認した主な不変条件

- 選ばれたタスクが重複しない
- 期限超過・本日期限のタスクは容量に関わらず必ず選ばれる（§14）
- 選ばれたタスクの合計loadと`totalLoad`が一致する
- `overCapacity`フラグが実際の容量超過と一致する
- 充填分（filled/weekly）の合計が残り容量を超えない
- **ナップサックの選択がブルートフォースの最適解と一致する**（容量の
  使い残しバグが再発していないことの直接的な証拠）
- 週次タスクは対象の曜日でのみ、かつその日まだ未完了の場合のみ選ばれる
- 週次タスクは翌週の同じ曜日にはまた候補に戻る（決定的に6週間分確認）
- **キャパシティを変更しても、既に完了した今日のタスクの負荷は
  消えない・二重計上されない**（前回修正したバグの回帰テスト）
- インポートの確認シートに出す予測件数と、実際にインポートした結果が
  一致する。同じデータを2回読み込んでも2回目は0件追加（冪等性）
- 壊れた入力（NaN、負のload、ID重複、うるう年境界日、絵文字タイトル等）
  で例外を投げない
- タスク500件・容量200でも6〜12ms程度で計算が終わる（性能面の劣化なし）

---

## 11. 完了の取り消しでhistoryが積み重なる問題の修正（2026-09-17、4回目）

### 症状
タスクの完了を取り消しても、そのタスクの完了記録が`history`から
消えなかった。取り消してもう一度完了すると、同じ完了について
`history`に何件も記録が刻まれていく。

### 原因
`recordCompletion()`（完了時にhistoryへ1件追加し、統計を+1する）に
対応する「取り消し」の処理が無く、チェックを外したときは
`t.done = false`のようにタスク側のフラグを戻すだけで、
`history`に追加済みのエントリと統計への加算はそのまま残っていた。

### 対策
`store.js`に`undoCompletion(state, task, completedOn)`を追加した。
`recordCompletion()`を鏡写しにした処理で、対応するhistoryエントリ
（taskId・date・event='completed'が一致する直近の1件）を削除し、
`stats.weekday`・`stats.weekdayPattern`への加算も同じ分だけ減算する。
`app.js`の`toggleTask()`の取り消し分岐からこれを呼ぶようにした。

### 副次的に見つけた関連バグ

修正の過程で、`toggleTask()`が「今完了しているか」の判定に
`Store.isTaskDoneToday(t, today)`（今日完了したかどうか）を使っていた
ことに気づいた。これは単発タスクでは問題を起こす: 単発タスクは
一度完了すれば完了日に関わらずずっと完了のままだが、
`isTaskDoneToday`は`doneDate === today`を要求するため、**過去の日に
完了したタスクの「完了済み」タブでチェックを外そうとすると、
「今日はまだ完了していない」と誤判定され、取り消しではなく
「今日改めて完了」扱いになってdoneDateが今日に上書きされ、
historyにも余分な1件が積まれてしまう**、という別のバグの芽があった。

これを避けるため、`store.js`に`isTaskComplete(task, todayStr)`を新設した:

```js
export function isTaskComplete(task, todayStr) {
  if (task.type === 'weekly') return Array.isArray(task.doneDates) && task.doneDates.includes(todayStr);
  return !!task.done; // 単発は完了日を問わない永続状態
}
```

`isTaskDoneToday`（日付限定、今日の負荷リング用）と
`isTaskComplete`（永続的な完了状態、チェックボックス表示・トグル判定用）
は**意味が異なる別概念として明確に分離した**。`toggleTask`・
`renderTaskCard`・`openDetailSheet`は`isTaskComplete`を使うよう修正し、
`renderTodayPage`（今日の負荷集計）は引き続き`isTaskDoneToday`を使う。

### 検証

`simulate.mjs`にPart Gを追加（完了→取り消しを単発20回・週次20回
繰り返してhistoryが0件に戻ることを確認、および過去日完了タスクの
`isTaskComplete`判定が正しく`true`になることを確認）。Part B
（長期シミュレーション）にも取り消し操作を混ぜ、8パターン計449回の
取り消しを含む長期ランダム進行でも`history`件数が「完了−取り消し」の
net値と一致し続けることを確認した。

UIでも直接Playwrightで検証:
- 同一タスクの完了→取り消しを5回繰り返してもhistoryは0件のまま
- 最後に完了させたままにすると1件だけ残る
- 実際にブラウザの日付を跨いで（9/10に完了→9/17に完了済みタブから
  取り消し）、過去日の完了が正しく取り消され、historyの該当エントリと
  その曜日の統計が両方とも元に戻ることを確認

総アサーション数は306,470件（前回から56件増加）、すべて通過。
