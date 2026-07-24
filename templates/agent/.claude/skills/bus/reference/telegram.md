# Telegram

## send-telegram
Send a message to the user via Telegram.

```bash
cortextos bus send-telegram <chat_id> "<message>"
```

- **chat_id** (required): Telegram chat ID (available in config)
- **message** (required): The message text. Supports Telegram markdown (not MarkdownV2 — do NOT escape `!`, `.`, `-`, etc.)

Example:
```bash
cortextos bus send-telegram "$CTX_TELEGRAM_CHAT_ID" "Deployed to production. URL: https://site.com"
```

Do NOT spam. Reserve for things the user actually needs to see.

## edit-message
Edit an existing Telegram message (e.g., update a status message in-place).

```bash
cortextos bus edit-message <chat_id> <message_id> "<new_text>" [reply_markup_json]
```

## answer-callback
Answer a Telegram callback query to dismiss button loading state.

```bash
cortextos bus answer-callback <callback_query_id> [toast_text]
```

## post-activity
Post a message to the org's Telegram activity channel (org-wide broadcast).

```bash
cortextos bus post-activity "<message>"
```
