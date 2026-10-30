# LUMA

Codexの作業と担当エージェントをひと目で確認する、ローカル専用のmacOSアプリです。

作業をタブで切り替え、中央のノード図でタスクの分岐と進み具合を確認できます。ノードや左のエクスプローラーで工程を選ぶと、右のインスペクターに報告・担当者・先に必要な工程を表示します。実線の矢印は前提工程、破線は親子関係です。状態更新でノードの配置は変わりません。タスク計画のない従来の作業は、作業全体のノードを表示します。

完了した作業は自動でタブから外れます。「完了履歴」をオンにすると、保存されている完了済みの作業も表示でき、オフにすると進行中の作業だけに戻ります。起動時は履歴を表示しません。工程や担当者に未完了・操作待ち・問題があれば、作業全体を完了扱いにせず表示し続けます。記録の保存上限は従来どおりです。

黒鉛色の面、細い罫線、角の切り欠き、控えめな黄のアクセントで工業的な質感に整えています。小窓では `EXPLORER` と `INSPECTOR` を開閉でき、ノード図は通常のスクロールで確認できます。ノード間は矢印キーでも移動できます。

ヘッダーの大きな長方形は、選択中のタブに限らず全作業の状態を集計します。赤は問題あり、黄は操作待ち、緑は作業中・完了・待機です。状態名も表示するため、緑が完了を意味するわけではありません。タスクやエージェントの色は以下の通りです。

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

ウィンドウは移動・拡大縮小できます。`PIN` で最前面へ固定、`COMPACT` で小さな表示に切り替えます。アプリを閉じても作業の記録は残ります。

macOS 12以降、XcodeまたはCommand Line Tools、Python 3.9以降が必要です。初回は標準のSwiftコンパイラでビルドします。AppKit・WebKit・Python標準ライブラリを使用し、Webサーバーは不要です。画面はローカルの状態ファイルだけを読み、Discord通知を有効にした場合のみCLIがDiscordへ送信します。ロゴはSVGで、同じ形からDock用アイコンも生成します。

## Codexから使う

専用スキルは隣の「agent-skills/skills/codex-luma」にあります。通常の開発作業でも利用し、明示して呼び出すこともできます。

```text
$codex-luma を使って、この機能を実装して
```

エージェントが作業の節目に状態を送ります。複数工程の計画は最初に一度だけ登録し、その後は通常の報告に短いタスクIDを添えて更新します。図の配置や色、通知はLUMA側が処理するため、描画や通知専用のLLM呼び出しは不要です。表示は受け取った最終報告で、Codexの内部状態を自動取得するものではありません。承認操作はCodex側で行います。

未登録の場合は、このスキルだけを追加できます。

```bash
python3 ../agent-skills/scripts/install_skills.py codex-luma
```

## CLI

```bash
python3 scripts/indicator.py start --title 'ログイン画面を実装' --project '/path/to/project' --tasks '[{"id":"check","title":"現状確認","status":"running"},{"id":"build","title":"実装","dependsOn":["check"]},{"id":"verify","title":"検証","dependsOn":["build"]}]'
# 返された session の文字列を SESSION へ入れる
python3 scripts/indicator.py update --session SESSION --status running --done-task check --task build --message '画面を実装中'
python3 scripts/indicator.py agent --session SESSION --id review --name 'レビュー' --task '挙動を確認' --status running
python3 scripts/indicator.py agent --session SESSION --id review --status done --message '確認完了'
python3 scripts/indicator.py update --session SESSION --status running --done-task build --task verify --message '動作を確認中'
python3 scripts/indicator.py update --session SESSION --status done --done-task verify --message '実装・検証完了'
```

本体・タスク・サブエージェントを合成し、問題 → 操作待ち → 作業中の順で優先表示します。未完了のエージェントやタスクがあると、作業全体の完了への更新は拒否されます。状態は排他ロックとatomic replaceで「.runtime/state.json」へ保存し、「LUMA_STATE_PATH」で変更できます。進行中のセッションは削除せず、完了セッションとイベントには保存上限を設けています。

タスクの `parentId` はエクスプローラー内の親子関係、`dependsOn` は先に必要な工程、`agentId` は登録済みの担当者です。省略時は親・依存・担当者なしとして扱います。`update --tasks` はIDを指定した差分の追加・変更にも使えます。タスク状態は `pending`（未着手）、`running`、`waiting`（ユーザー操作待ち）、`error`、`done`、`skipped`（取りやめ）です。

## Discord通知

設定ファイルは `~/Library/Application Support/LUMA/notifications.json`（`LUMA_CONFIG_PATH` で変更可）です。Webhookはソースや作業データへ保存せず、このファイルだけに置きます。設定例：

```json
{
  "enabled": true,
  "discordWebhook": "https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN",
  "notifyErrors": true,
  "notifyWaiting": true,
  "notifyCompletion": true
}
```

設定ファイルは本人だけが読める権限（`chmod 600`）にします。設定がない場合や `enabled` が `false` の場合は送信しません。

問題・操作待ちへ変わったときと、作業タブ全体が完了したときに送信します。細かな工程の完了は通知しません。同じ問題状態の報告を繰り返しても通知せず、復旧後に再発すれば再び通知します。通知は状態に応じた丸の絵文字（完了は緑、問題は赤、操作待ちは黄）とMarkdownの大きな見出し、太字の作業名、プロジェクト・対象・報告の箇条書きで表示します。メンションは無効です。

送信は別プロセスで行い、アプリを閉じてもCLIから通知できます。通信失敗やレート制限は最大5回・最長6時間の範囲で自動再試行し、送れなかった通知は状態ファイルと同じ場所の `state.json.notifications.json` に残します。設定や接続を直した後に再試行する場合：

```bash
python3 scripts/notifications.py --state .runtime/state.json --retry
```

Discordの仕様は [Webhook Resource](https://github.com/discord/discord-api-docs/blob/main/developers/resources/webhook.mdx)、[Rate Limits](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)、[Markdown Text 101](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline) に従います。

## 検証

```bash
python3 -m unittest discover -s tests -p 'test_*.py'
node --test tests/*.test.js
bash scripts/build.sh
```

「native/main.swift」はウィンドウとファイル監視、「web/」は表示、「scripts/indicator.py」は状態更新、「scripts/notifications.py」は通知を担います。テストは一時設定とモック通信を使用し、実際のDiscordへ送信しません。ビルド出力と作業データは「.build/」「.runtime/」へ保存します。
