Multi-Model AI Chat Client

A self-hosted, bring-your-own-key (BYOK) web app for chatting with and comparing outputs across large language models, image generation models, and video generation models — all routed through OpenRouter.

Why this exists

Comparing how different models handle the same prompt usually means juggling separate accounts, API keys, and interfaces for every provider. This app puts that behind one interface: pick a model from OpenRouter's catalog, chat with it, and open another tab with a different model to compare side by side. No automated multi-model broadcasting — comparison is just a normal part of using multiple tabs.

This is a personal project, not a public product. It's invite-only and not intended for open signup, though the architecture doesn't require a rework if that changes later.

Features
Text, image, and video chat, each backed by OpenRouter's respective API
Live model picker with search, modality filtering, and pricing shown inline
Provider routing controls (price/speed sort, data-privacy preference) for models served by multiple underlying providers
Spend dashboard: total cost, plus breakdown by model and by chat
Image input across all three modalities: attach images to vision text models, as reference images for image-to-image editing, or as a first frame for image-to-video
BYOK — your own OpenRouter API key, encrypted at rest, never exposed after initial save
Local storage with optional linked cloud folders (Google Drive, Dropbox, OneDrive), with user-set priority order and per-provider quotas, so you're not capped by local disk alone
Password + TOTP two-factor auth, with a "trusted device" option so TOTP isn't required on every login
Tech stack
Frontend: React + Vite
Backend: Node.js + Express
Database: PostgreSQL
Project docs
chat_project_bible.md — full spec: schema, auth design, storage rules, OpenRouter integration details, and everything else that defines how this app is supposed to work.
build_guide.md — staged build-and-test plan, written as a sequence of prompts for building this incrementally with Claude Code, with a manual verification checklist after each stage.

Status

Actively being built, following the staged plan in build_guide.md. Not yet feature-complete.

License

MIT — see [LICENSE](LICENSE). All dependencies are permissive-licensed (MIT/ISC/BSD/Apache-2.0/0BSD); none are copyleft.
