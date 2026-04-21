<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This project uses Next.js 16 + React 19 — APIs, conventions, and file structure may differ from earlier versions. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

Key things that tend to bite:
- `cookies()`, `headers()`, `params`, `searchParams` are **async** in Next 16 — always `await`.
- Turbopack is default in dev.
- Route types are generated; `next-env.d.ts` is regenerated on build.
<!-- END:nextjs-agent-rules -->
