# Temper v1.12.1

## 適用方法（GitHub Desktop）
1. この zip の `files/` の中身を、Temper リポジトリのフォルダ直下に **上書きコピー**
2. 下の「削除するファイル」をリポジトリのフォルダから **削除**
3. GitHub Desktop で差分を確認 → Commit → Push
※ この `CHANGES.md` 自体はコピーしないでください。

## 削除するファイル
- `js/sw.js`（v1.9.0 の古い未使用ファイル。実際に登録されているのは直下の `sw.js`）

## 変更（機能の変更なし・セキュリティ修正）
- **タスクIDの検証**: `store.js` に `isValidTaskId()` を追加（英数字と `_ . : @ -`）。JSON取り込み時、不正なIDは採番し直し。`sync-core.js` はクラウドから届いたタスクのIDが不正なら取り込まない
- **`esc()` が `"` `'` も変換**するように変更（属性値の中でも安全に）
- **`attrId()` を追加**し、`onclick` / `data-task-id` / `querySelector` に入るIDから許可文字以外を除去（二重の防御）
- バージョンを **v1.12.1** に更新（`app.js` の `APP_VERSION`、`sw.js` のキャッシュ名 `temper-shell-v1.12.1`）
- `HANDOFF_Temper.md` に §19 を追記

## 確認したこと
- `simulate.mjs` の 350,565 件のアサーションが全て通過（修正前後とも同数）
- `');alert(1);('` / `x" onmouseover="..."` / 空白・`<img>`・空・null のIDが採番し直され、`abc123` や `ok_1.2:3@x-y` は維持されること

## 未対応
- `firestore.rules` はそのまま（自分のデータのみ書き込み可で適切。サイズ・形式の検証は未追加。変更する場合は Firebase コンソールへの手動反映が必要なため、動作確認なしでは入れていません）
