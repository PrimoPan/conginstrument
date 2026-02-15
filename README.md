# CogInstrument Backend (MVP)

Node.js (TypeScript) + Express + MongoDB backend for:
- Username-only login (session token)
- Multi-conversation per user
- Turn-based chat: model returns **assistant_text + graph_patch**, backend merges and returns **full graph**
- (RAG later)

> ⚠️ Security note: username-only login is **not** real authentication. Use it as an experiment label / participant code (e.g., `u001`), not for public deployment.

---

## Tech Stack

- Node.js + TypeScript
- Express
- MongoDB
- OpenAI SDK (via GreatRouter gateway)
  - Chat: `/chat/completions`
  - (Embeddings later)

---

## Environment Variables

Create `.env` (do **NOT** commit it). See `.env.example`.

Required:
- `OPENAI_API_KEY`
- `OPENAI_BASE_URL` (e.g., `https://endpoint.wendalog.com` or `https://endpoint.greatrouter.com`)
- `MODEL` (default: `gpt-5-mini`)
- `MONGO_URI`
- `MONGO_DB`
- `PORT`

---

## Setup & Run

### Install
```bash
npm install
