# BDRClaw

> **Anthropic Agent SDK上に構築された、軽量でコンテナ分離型のAIセールス開発プラットフォーム。**
> LinkedIn、メール、SMS、Slack、WhatsApp、Telegram、Discordのすべてのチャネルで、プロスペクティング、アウトリーチ、フォローアップ、CRM管理を自動化 — チームがスプレッドシートの入力ではなく、商談のクロージングに集中できます。

<p align="center">
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>
</p>

---

## ビジョン

BDRClawは、ワールドクラスのBDRにAIの頭脳、メモリシステム、セールスツールスタック全体へのアクセスを与えた結果です — 専用コンテナで安全に実行され、暴走せず、データを漏洩せず、一行一行監査可能です。

**NanoClawのオープンコアfork**として構築され、BDRClawは同じ哲学を保持しています：

- **理解できる規模。** 1つのプロセス、少数のソースファイル、マイクロサービスなし。
- **分離によるセキュリティ。** エージェントはLinuxコンテナ（Docker / Apple Container）で実行。Bashはコンテナ内で実行されるため安全。
- **AIネイティブ。** セットアップウィザードなし。モニタリングダッシュボードなし。デバッグツールなし。Claudeに聞くだけ。
- **機能より技能。** 新しい統合はインストール可能なスキル（`/add-hubspot`、`/add-linkedin`、`/add-apollo`）として提供され、コアの肥大化ではありません。

ベースフレームワークはMIT。プレミアムスキルが競争優位性。

---

## BDRClawが自動化するもの

BDRが行うすべてのこと（電話を除く）：

| アクティビティ | チャネル | スキル |
|---|---|---|
| コールドアウトリーチシーケンス | Gmail / SMTP | `/add-gmail` |
| LinkedIn DM + 接続リクエスト | LinkedIn | `/add-linkedin` |
| SMSフォローアップ | Twilio | `/add-sms` |
| Slackプロスペクティング | Slack | `/add-slack-outreach` |
| WhatsAppシーケンス | WhatsApp | `/add-whatsapp` |
| Telegramアウトリーチ | Telegram | `/add-telegram` |
| コンタクトエンリッチメント | Apollo / Hunter / Clearbit | `/add-apollo` |
| CRM管理 + 取引ステージ更新 | HubSpot / Attio / Salesforce | `/add-hubspot` |
| パイプラインレビュー + フォローアップキュー | 内部スケジューラー | ビルトイン |
| リードスコアリング + 優先順位付け | Claude推論レイヤー | ビルトイン |
| ミーティング予約 | Cal.com / Calendly | `/add-cal` |

---

## アーキテクチャ

```
チャネル (Gmail, LinkedIn, SMS, Slack...)
        |
        v
    SQLite DB
        |
        v
   ポーリングループ
        |
        v
  BDRブレインエージェント  <----  prospects/*/CLAUDE.md (見込み客ごとのメモリ)
        |
        v
  コンテナ (Claude Agent SDK)
        |
        v
   アウトバウンドルーター  -->  チャネルレジストリ  -->  レスポンス
```

### コアコンポーネント

| ファイル | 役割 |
|---|---|
| `src/index.ts` | オーケストレーター：状態、メッセージループ、エージェント呼び出し |
| `src/channels/registry.ts` | 起動時のチャネル自己登録 |
| `src/ipc.ts` | IPCウォッチャーとタスク処理 |
| `src/router.ts` | メッセージフォーマットとアウトバウンドルーティング |
| `src/group-queue.ts` | 見込み客ごとのキュー（グローバル同時実行制限付き） |
| `src/container-runner.ts` | ストリーミングエージェントコンテナの起動 |
| `src/task-scheduler.ts` | スケジュールされたBDRタスクの実行 |
| `src/db.ts` | SQLite操作（見込み客、タッチポイント、シーケンス、CRM状態） |
| `prospects/*/CLAUDE.md` | 見込み客ごとのメモリ |

---

## クイックスタート

```bash
gh repo fork josephclark/bdrclaw --clone
cd bdrclaw
claude
```

その後、`/setup`を実行します。Claude Codeがすべてを処理します：依存関係、認証、コンテナセットアップ、サービス設定。

### 必要条件

- macOSまたはLinux
- Node.js 22以上
- Claude Code
- Docker（macOS/Linux）またはApple Container（macOS）
- Anthropic APIキー

### 環境変数

```env
ANTHROPIC_API_KEY=
DATABASE_URL=./data/bdrclaw.db
TRIGGER_WORD=@BDR
MAIN_CHANNEL=telegram
AUTO_SEND=false
DAILY_BRAIN_RUN=07:00
```

---

## 使い方

メインチャネル（Telegram / WhatsApp / Slackセルフチャット）から：

```
@BDR 見込み客を追加: 田中太郎, Acme Corp エンジニアリングVP, tanaka@acme.com, linkedin.com/in/tarotanaka
@BDR 田中太郎をコールドアウトリーチv1シーケンスに登録
@BDR 今週のパイプラインはどうなっている
@BDR 最もホットなリードは誰
@BDR Acme Corpへのすべてのアウトリーチを一時停止
@BDR パイプラインレポートを生成してチームSlackに送信
@BDR 田中太郎を有資格としてマーク、返信があり木曜日に電話を希望
```

---

## オープンコアモデル

### 無料（MIT）

- コアオーケストレーター + コンテナランナー
- SQLiteメッセージ/見込み客/シーケンスストレージ
- ポーリングループ + タスクスケジューラー
- BDRブレインエージェントロジック
- 見込み客メモリシステム（`prospects/*/CLAUDE.md`）
- 基本スキル：`/add-gmail`、`/add-telegram`、`/add-whatsapp`、`/add-slack`

### 有料（BDRClaw Proスキル）

- `/add-linkedin` — LinkedIn DM + 接続自動化
- `/add-apollo` — コンタクトエンリッチメント + リードインポート
- `/add-hubspot` — フルCRM同期
- `/add-salesforce` — Salesforce統合
- `/add-sms` — Twilio SMSシーケンス
- `/add-cal` — Cal.com / Calendly予約自動化

---

## コントリビューション

NanoClawと同じ哲学：**機能を追加するのではなく、スキルを追加してください。**

Salesforceサポートを追加したい場合、コアにSalesforceを追加するPRを開かないでください。BDRClawをフォークし、ブランチでスキルを構築し、PRを開いてください。他のユーザーがインストールできる`skills/add-salesforce`ブランチを作成します。

---

## ライセンス

コア：MIT
Proスキル：商用（`LICENSE_PRO`を参照）

---

*BDRClawは[Clark Tech Ventures LLC](https://clarktechventures.com)によって構築されています。*
