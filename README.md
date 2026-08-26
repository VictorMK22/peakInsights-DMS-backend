# PeakInsights Hub — Backend API

Node.js + Express + TypeScript + MongoDB

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your MongoDB URI and JWT secret
npm run dev
```

## API Endpoints

### Auth

- `POST /api/auth/login` — Login
- `GET /api/auth/me` — Get current user
- `PUT /api/auth/change-password` — Change password

### Users (CEO only for write operations)

- `GET /api/users` — List users
- `POST /api/users` — Create user
- `PUT /api/users/:id` — Update user
- `DELETE /api/users/:id` — Deactivate user
- `POST /api/users/assign` — Assign user to supervisor
- `GET /api/users/mappings` — Get supervisor-user mappings

### Documents

- `GET /api/documents` — List documents (role-filtered)
- `POST /api/documents` — Upload new document (multipart/form-data)
- `GET /api/documents/:id` — Get document detail
- `PUT /api/documents/:id` — Update document / new version
- `POST /api/documents/:id/complete` — Complete + auto-revoke ACL
- `POST /api/documents/:id/invite` — Invite collaborator

### Analytics

- `GET /api/analytics/dashboard` — Dashboard stats
- `GET /api/analytics/leaderboard` — Efficiency leaderboard
- `GET /api/analytics/bottlenecks` — Bottleneck heatmap data
- `GET /api/analytics/trends` — Trend analysis
- `GET /api/analytics/audit-trail` — Audit trail
- `GET /api/analytics/collaboration-frequency` — SME analysis

## Architecture

- **RBAC**: CEO > Supervisor > User (top-down authority model)
- **TAT Engine**: Auto-calculates turnaround time on completion
- **Efficiency Ratio**: `targetTAT / actualTAT`
- **Auto-revocation**: ACL cleared on document completion
- **Immutable Audit Logs**: Non-deletable, supervisor-tagged at timestamp
