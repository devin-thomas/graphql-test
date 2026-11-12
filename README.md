# CaseGraph

**GraphQL support-case investigation app** — a working end-to-end project built for technical support and API troubleshooting practice, not a static wireframe. TypeScript, [GraphQL Yoga 6](https://the-guild.dev/graphql/yoga-server/docs), the standard `graphql` executor, and persistent SQLite. No outside services, accounts, or API keys needed.

The data is **fully synthetic**. Do not use real customer data. This is a local/dev portfolio project rather than an audited multitenant production support system.

## Features

- **Actual GraphQL API:** one `/graphql` endpoint with schema introspection and the browser-based GraphiQL IDE.
- **Real relationships:** cases link to customers, agents, and event histories; fetch exactly the nested fields needed.
- **Typed queries and mutations:** search/filter cases, cursor pagination, operational metrics, create cases, assign owners, change status, and add notes.
- **SQLite persistence:** case edits survive restarts, with foreign keys, indexes, transactions, and seeded sample cases.
- **Safer write access:** `Authorization: Bearer <token>` required on all mutations; no default write token, no token in the repo. Not a replacement for production identity, RBAC, or secrets management.
- **GraphQL Request Lab:** in-app query editor with examples of validation errors, not-found objects, pagination, and protected mutations.
- **Debugging:** structured `errors[].extensions.code`, `X-Request-ID`, HTTP response codes, and cases specifically about 429s, 401s, webhook retries, and GraphQL schema changes.
- **Automated tests:** domain, database persistence, HTTP operations, nested GraphQL queries, auth checks, and mutations.

## Run locally

Requires **Node.js 22.16+**. Node 22's built-in `node:sqlite` and `--experimental-strip-types` may print experimental warnings; this is expected on Node 22.16.

```bash
npm install
cp .env.example .env
# Edit .env and replace CASEGRAPH_WRITE_TOKEN with your own 16+ character secret.
npm start
```

Open **http://127.0.0.1:4000** for the dashboard, or **http://127.0.0.1:4000/graphql** for GraphiQL and its schema explorer.

On Windows PowerShell, use `Copy-Item .env.example .env` instead of `cp`.

For reload-on-change development, run `npm run dev`. The default SQLite file is `./data/casegraph.sqlite`; set `CASEGRAPH_DB_PATH=:memory:` for a fresh disposable database on each launch.

### First authenticated mutation

Set a 16+ character write secret in `.env`, restart, and paste the same secret into the **Read-only session** panel in the dashboard. The page saves it only in the current browser tab. Alternatively use curl:

```bash
curl -s http://127.0.0.1:4000/graphql \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer REPLACE_WITH_YOUR_TOKEN' \
  -d '{"query":"mutation { addCaseNote(id: \"1\", message: \"Reproduced the failure and captured the request ID\") { id message actor } }"}'
```

Try a read-only query (no token required):

```bash
curl -s http://127.0.0.1:4000/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ cases(first: 2) { totalCount edges { node { id subject customer { name } } } pageInfo { endCursor hasNextPage } } }"}'
```

## Practice real GraphQL troubleshooting

| Exercise | Reproduce | Diagnose |
|---|---|---|
| Schema mismatch | Request `nonExistentField` under `SupportCase` | `errors[]` includes a validation problem and points to the offending field; use GraphiQL schema docs |
| Auth error | Execute `createCase` without bearer token | `UNAUTHENTICATED` in `errors[].extensions.code`; verify token and HTTP header |
| Validation error | Set `first: 500` in a `cases` query | `BAD_USER_INPUT` with the paging range constraint |
| Partial field selection | Request only `subject` then add `customer { name }` | Inspect payload changes; no endpoint change needed |
| Missing entity | Request `case(id: "999999")` | `case: null` with no error (nullable field); contrast with missing `updateCaseStatus` |
| Cursor pagination | Request `first: 2`, pass `pageInfo.endCursor` into `after` | See nonoverlapping windows while totalCount remains stable |
| Mutation auditing | Create a case, assign an agent, change status, add note | Query `events` and verify transaction-backed state survives restart |

**Common GraphQL mental model:** the HTTP response can be `200` even when an operation produces field-level GraphQL errors. Check `errors` and `data`, not just the HTTP status. Request-validation and method errors may produce `4xx`. This app uses `application/graphql-response+json` where the client accepts it. See [GraphQL common HTTP errors](https://graphql.org/learn/debug-errors/).

> **Microsoft Graph is not GraphQL.** The name refers to Microsoft's REST-based API. This project uses the GraphQL query language, schema validation, and execution engine directly.

## Schema map

```text
Query.cases → CaseConnection → CaseEdge.node → SupportCase
                                              ├── Customer
                                              ├── Agent (assignee)
                                              └── CaseEvent[]
Mutation.createCase      → SupportCase
Mutation.updateCaseStatus → SupportCase
Mutation.assignCase      → SupportCase
Mutation.addCaseNote     → CaseEvent
```

Open [`examples/operations.graphql`](examples/operations.graphql) for copy-and-paste operations.

## Verification

```bash
npm run check          # TypeScript check + all Node tests
npm run test:store     # Built-in SQLite tests, even without installed npm packages
npm test               # Domain + GraphQL HTTP integration tests
```

A GitHub Actions workflow runs on pushes and PRs when this project is in a repo.

## Running with Docker

```bash
docker build -t casegraph .
docker run --rm -p 127.0.0.1:4000:4000 \
  -e CASEGRAPH_WRITE_TOKEN='YOUR_16_PLUS_CHAR_SECRET' \
  -v casegraph-data:/data casegraph
```

The Docker volume persists SQLite state. Do not expose the app directly to the public Internet: use HTTPS at the edge, real identity and per-tenant access controls, field-level authorization, query cost/depth constraints, logging, rate limiting, and an appropriate database before considering production use. A single bearer secret is for local developer exercises only.

## Architecture

- `src/store.ts` — SQLite schema, synthetic fixture seed, transactions, domain validation, filters, pagination and event history.
- `src/graphql.ts` — schema definition, nested resolvers, authorization, structured errors.
- `src/server.ts` — Yoga `/graphql` HTTP handling, health check, same-origin dashboard assets.
- `web/` — dependency-free browser dashboard and request lab, all using the actual GraphQL API.
- `tests/` — persistence, typed mutation, cursor, API validation, HTTP/auth integration tests.

Intended for portfolio and educational use. All customer and case names are fictional.

## Hosted CaseGraph field guide (Vercel)

The public website in `public/` showcases GraphQL concepts and provides an interactive live query lab backed by `api/graphql.ts`, a Vercel Function using the same TypeScript GraphQL schema and synthetic cases as the local application. Vercel serves `/graphql` via a rewrite to the function; GET opens GraphiQL, and POST executes real GraphQL operations.

**Hosting limitation and security:** the public demo uses in-memory SQLite and is intentionally **read-only**. Mutations return `UNAUTHENTICATED`, do not accept any user-provided write token, and no data persists across cold starts. It is not a multi-user support system. For persistent create/assign/status/note mutations, run `npm start` locally or use Docker with a private bearer secret. The two deployments share a schema, not a persistent database.

The Vercel project is linked to the GitHub repository's `main` branch so future pushes deploy the showcase automatically. All example cases and customer names are fictional.
