# LUMA

Codexの作業と担当エージェントをひと目で確認する、ローカル専用のmacOSアプリです。

作業ごとに状態・現在の報告・最終更新を表示します。問題と操作待ちは一覧の上へ並び、完了した古い作業は折りたたまれます。作業を選ぶと担当エージェントの状況を確認でき、活動履歴は必要なときだけ開けます。

| 色 | 状態 |
| --- | --- |
| シアン | 作業中 |
| 黄 | 承認・回答・ユーザー操作待ち |
| 赤 | 問題あり、または状態ファイルの読み取りに失敗 |
| 緑 | 完了 |
| 灰色 | 待機中 |

## 起動

「Launch Luma.command」をダブルクリックするか、以下を実行します。

```bash
bash scripts/run.sh
```

ウィンドウは移動・拡大縮小できます。「固定」で最前面へ固定、「縮小」で小さな表示に切り替えます。アプリを閉じても作業の記録は残ります。

macOS 12以降、XcodeまたはCommand Line Tools、Python 3.9以降が必要です。初回は標準のSwiftコンパイラでビルドします。AppKit・WebKit・Python標準ライブラリを使用し、Webサーバーや外部通信は使いません。ロゴはSVGで、同じ形からDock用アイコンも生成します。

## Codexから使う

専用スキルは隣の「agent-skills/skills/codex-luma」にあります。明示的な呼び出し専用です。

```text
$codex-luma を使って、この機能を実装して
```

スキルを呼んだ作業だけアプリを起動し、エージェントが作業の節目に状態を送ります。表示は受け取った最終報告で、Codexの内部状態を自動取得するものではありません。承認操作はCodex側で行います。

未登録の場合は、このスキルだけを追加できます。

```bash
python3 ../agent-skills/scripts/install_skills.py codex-luma
```

## CLI

```bash
python3 scripts/indicator.py start --title 'ログイン画面を実装' --project '/path/to/project'
# 返された session の文字列を SESSION へ入れる
python3 scripts/indicator.py update --session SESSION --status running --message '画面を実装中'
python3 scripts/indicator.py agent --session SESSION --id review --name 'レビュー' --task '挙動を確認' --status running
python3 scripts/indicator.py agent --session SESSION --id review --status done --message '確認完了'
python3 scripts/indicator.py update --session SESSION --status done --message '実装・検証完了'
```

本体とサブエージェントを合成し、赤 → 黄 → シアンの順で優先表示します。未完了のエージェントがあると完了への更新は拒否されます。状態は排他ロックとatomic replaceで「.runtime/state.json」へ保存し、「LUMA_STATE_PATH」で変更できます。進行中のセッションは削除せず、完了セッションとイベントには保存上限を設けています。

## 検証

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/model.test.js
bash scripts/build.sh
```

「native/main.swift」はウィンドウとファイル監視、「web/」は表示、「scripts/indicator.py」は状態更新を担います。ビルド出力と作業データは「.build/」「.runtime/」へ保存します。
