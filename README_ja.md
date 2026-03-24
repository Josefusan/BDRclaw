# BDRclaw

> **眠らないAI SDRチーム — あなたがクロージングに集中している間に、有資格ミーティングを予約します。**

コンテナで実行される軽量なAIネイティブBDRチーム。CRM、メール、LinkedIn、Slack、SMSに接続し、認知的負荷をかけずにクロージングに集中できます。

[Anthropic Agents SDK](https://docs.anthropic.com/en/docs/agents)上に構築。[NanoClaw](https://github.com/qwibitai/nanoclaw)にインスパイア。

<p align="center">
  <a href="README.md">English</a>&nbsp; • &nbsp;
  <a href="README_zh.md">中文</a>
</p>

---

## なぜBDRclawか

ほとんどのセールス自動化ツールはダッシュボードです。あなたはまだ考え、決定し、実行する必要があります。BDRclawは違います — エージェントチームです。プロスペクティング、シーケンス実行、フォローアップ、エンリッチメント、CRM同期を、バイヤーがいるすべてのチャネルで自動的に行います。

SDR採用不要。認知的負荷なし。有資格パイプラインだけ。

| BDRclawがやること | あなたがやること |
|---|---|
| LinkedInでプロスペクティング | ディスカバリーコールを実施 |
| コールドメールシーケンスを送信 | 異議に対応 |
| SMS & Slackでフォローアップ | 交渉してクロージング |
| CRMレコードをエンリッチ・更新 | 契約書にサイン |
| ホットリードと購買シグナルをフラグ | 入金を確認 |

---

## アーキテクチャ

```
チャネル (メール / LinkedIn / Slack / SMS / WhatsApp)
        ↓
    SQLiteキュー
        ↓
  ポーリングループ + ルーター
        ↓
  コンテナ (Claude Agent SDK)  ←→  prospects/*/CLAUDE.md
        ↓
   CRM同期 + アウトバウンドアクション
```

- **単一のNode.jsプロセス。** マイクロサービスなし。
- **コンテナ分離エージェント。** 各エージェントは独自のLinuxコンテナで実行。
- **見込み客メモリ。** 各見込み客は `prospects/*/CLAUDE.md` を持つ — タッチポイント履歴、ステージ、返信履歴、エンリッチメントデータ。
- **機能よりスキル。** 機能はClaude Codeスキルとして追加。

---

## 自動化するもの

### アウトバウンドチャネル
- **メール** — マルチステップコールドシーケンス、フォローアップ、返信検出
- **LinkedIn** — 接続リクエスト、DMシーケンス、プロフィールエンリッチメント
- **SMS** — Twilio駆動のテキストアウトリーチ
- **Slack** — Slack Connect経由のSDRシーケンス
- **WhatsApp** — 海外見込み客向けのウォームアウトリーチ

### CRM & エンリッチメント
- **HubSpot / Attio / Salesforce** — コンタクト自動作成、タッチ記録、ステージ更新
- **Apollo / Hunter / Clay** — メール検索とコンタクトエンリッチメント

### インテリジェンスレイヤー
- 毎日のBDRブレイン：パイプラインレビュー、フォローアップキュー、ホットリードフラグ
- 購買シグナル検出（転職、資金調達、ウェブサイト訪問）
- 返信分類（興味あり / 興味なし / 紹介 / 配信停止）
- ミーティング予約 → CRMステージ自動更新 → クローザーに通知

---

## クイックスタート

```bash
gh repo fork Josefusan/BDRclaw --clone
cd BDRclaw
claude
```

その後、`/setup`を実行。Claude Codeがすべてを処理します。

---

## スキル

| スキル | 説明 |
|---|---|
| `/add-gmail` | コールドメールシーケンス + 返信検出 |
| `/add-linkedin` | LinkedInプロスペクティング + DMシーケンス |
| `/add-hubspot` | CRM同期、ステージ更新、コンタクト作成 |
| `/add-attio` | Attio CRM統合 |
| `/add-apollo` | コンタクトエンリッチメント + メール検索 |
| `/add-twilio` | SMSアウトリーチ |
| `/add-slack-outreach` | Slack Connect SDRシーケンス |
| `/add-whatsapp` | WhatsAppアウトリーチチャネル |
| `/add-calendly` | ミーティングリンク挿入 + 予約検出 |
| `/add-clay` | Clayエンリッチメントワークフロー |

### オープンコアモデル

ベースBDRclawフレームワークはMITライセンス。プレミアムスキルは別途管理。

> ベースフレームワークはMIT。プレミアムスキルが競争優位性。

---

## 必要条件

- macOSまたはLinux
- Node.js 20以上
- Claude Code
- Apple Container（macOS）またはDocker（macOS/Linux）
- Anthropic APIキー

---

## コントリビューション

機能を追加するのではなく、スキルを追加してください。

詳細は[CONTRIBUTING.md](./CONTRIBUTING.md)を参照。

---

## ライセンス

MIT — [LICENSE](./LICENSE)を参照

---

*[NanoClaw](https://github.com/qwibitai/nanoclaw) (MIT) のコンセプトに基づいて構築。*
