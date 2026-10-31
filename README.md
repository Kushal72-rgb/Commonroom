# Commonroom

Commonroom is a campus resource-sharing application. The static HTML/CSS/JavaScript frontend calls the Express API in `backend/` for accounts, resources, bookings, incidents, and activity history.

## Requirements

- Node.js **20.19 or later** (required by the installed Mongoose release).
- MongoDB Community Server for local development, or MongoDB Atlas for a hosted database.
- npm 10 or later is recommended.

## Local development

1. Start the local MongoDB service.
2. In PowerShell, create the backend environment file and install the locked dependencies:

   ```powershell
   cd D:\Hackathons\backend
   Copy-Item .env.example .env
   npm ci
   ```

3. Edit `backend/.env`. Keep `NODE_ENV=development`, use the local MongoDB URI, and replace `JWT_SECRET` with a random value of at least 32 bytes. Generate one with:

   ```powershell
   node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
   ```

4. Start the API:

   ```powershell
   npm start
   ```

   The default local port is 5000. `http://127.0.0.1:5000/api/health` should return `status: "ok"` when MongoDB is connected.

5. In another terminal, serve the project root as static files:

   ```powershell
   cd D:\Hackathons
   python -m http.server 5500
   ```

6. Open `http://127.0.0.1:5500`.

Run frontend tests from the project root with `node --test tests/*.test.js`. Run backend integration tests from `backend/` with `npm test`; the local MongoDB service and valid `backend/.env` are required.

## Production environment

Set these variables in the backend hosting provider’s secret/environment settings. Do not commit production values.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | Yes | Set to `production`; disables development CORS defaults and sanitizes server error logs. |
| `PORT` | Host supplied | Port for the API listener. The app reads this value and defaults to 5000 for local development. |
| `MONGODB_URI` | Yes | MongoDB Atlas or another production MongoDB connection URI. |
| `JWT_SECRET` | Yes | Random secret with at least 32 UTF-8 bytes. Generate it outside this chat and store it only in the provider’s secret manager. |
| `CORS_ORIGIN` | Yes | Comma-separated, exact HTTPS frontend origins, such as `https://commonroom.example.org`. Do not include paths or a trailing slash. |
| `JWT_EXPIRES_IN` | No | JWT lifetime understood by `jsonwebtoken`; defaults to `1h`. |
| `RESOURCE_LOCK_LEASE_MS` | No | Resource lock lease in milliseconds; defaults to `60000` and accepts `5000` through `900000`. |

The backend fails to start in production if `CORS_ORIGIN` is absent, contains `*`, contains a non-HTTPS origin, or contains a URL path. Development defaults to the two localhost origins only when `CORS_ORIGIN` is unset. Requests from other browser origins do not receive CORS permission. CORS is not authentication: API authorization must continue to protect data and actions.

The frontend API URL is public configuration, not a secret. Set it before loading `api.js` in `index.html` or the deployed HTML template:

```html
<script>window.COMMONROOM_API_BASE = 'https://commonroom-api.example.org/api';</script>
<script src="api.js?v=phase9-final-1"></script>
```

Keep the config script before `api.js`. Do not put tokens, database credentials, or JWT signing secrets in frontend code. If a static host provides environment substitution, it can inject this public API base at build/deploy time.

## MongoDB Atlas setup

1. Create a production Atlas cluster and a dedicated database user with only the database permissions Commonroom needs.
2. Configure Atlas network access to allow the backend host’s outbound IP addresses or private network. Avoid opening the cluster to all IPs when the host offers stable egress addresses.
3. Copy the Atlas `mongodb+srv://...` URI into the backend environment as `MONGODB_URI`, selecting the `commonroom` database. URL-encode special characters in the database password.
4. Use TLS and the provider’s current recommended URI options. Do not commit the URI or paste it into logs or support messages.
5. Confirm `GET /api/health` reports both API `ok` and database `connected` after startup.

The `.env.example` file contains local defaults and placeholders only. Root and backend `.gitignore` files exclude `.env` files and `node_modules`; check `git status` before committing any configuration files.

## Backend deployment

1. Deploy the `backend/` directory as a Node service with Node.js 20.19 or later.
2. Install with `npm ci --omit=dev` and start with `npm start` (equivalent to `node server.js`). The host should inject `PORT`.
3. Configure `NODE_ENV`, `MONGODB_URI`, `JWT_SECRET`, and `CORS_ORIGIN` in the provider’s secret manager. Set `JWT_EXPIRES_IN` or `RESOURCE_LOCK_LEASE_MS` only when you intend to change their defaults.
4. Configure the provider’s health check as `/api/health` and wait for MongoDB connection before considering the service ready.
5. Use HTTPS for the public API endpoint. Keep MongoDB and the API host off public unrestricted network access where the provider supports private networking.

## Frontend deployment

1. Host `index.html`, `styles.css`, `app.js`, `api.js`, and `workflow.js` on an HTTPS static site host.
2. Configure `window.COMMONROOM_API_BASE` before the `api.js` script as shown above.
3. Set backend `CORS_ORIGIN` to the exact frontend origin (scheme and host, including a non-default port if used). Add each separately deployed frontend origin explicitly, comma-separated.
4. Verify the deployed site requests the HTTPS API host rather than `localhost` or `127.0.0.1`.

## Production smoke checks

After deployment, run these checks from a terminal. Replace the example API host and use a disposable test account; do not paste real passwords into shared logs.

```powershell
$api = 'https://commonroom-api.example.org/api'
Invoke-RestMethod "$api/health"
Invoke-RestMethod "$api/resources"
```

Then in a private browser window:

1. Open the deployed HTTPS frontend and confirm resources load without CORS or mixed-content errors.
2. Register a disposable member; confirm the account gets the `member` role. Log out and sign in again.
3. Confirm an unauthenticated booking/resource-management action is rejected and member permissions do not expose owner-only operations.
4. With a separately provisioned owner account, create a disposable resource, approve a booking, check it in, return it, and inspect the activity history.
5. Report an incident and verify it does not block return. Archive the disposable resource and confirm it disappears from active public listings while its history remains accessible.
6. Refresh after each successful action and confirm the API remains the source of truth.
7. Confirm an unlisted browser origin is denied CORS access and `GET /api/health` reports database disconnection as unhealthy if the database is unavailable.

Do not use local demo-owner provisioning scripts against production; they intentionally restrict operation to a local database. Provision production owners through a controlled administrative procedure outside public registration.

## Production security and known limitations

- Passwords are hashed using bcryptjs (work factor 12). Public registration always creates members; it ignores client role selection. JWT signing uses the environment secret and HS256 verification.
- The current browser stores its bearer JWT in `localStorage`. This survives refresh but is readable by JavaScript; an XSS could steal it. User-controlled text is escaped, but production should still deploy a restrictive Content Security Policy and consider a migration to Secure, HttpOnly, SameSite cookies with CSRF protection. That migration changes login/logout and API credential handling and has not been made here.
- Authentication rate limits are in-process memory maps. They reset on restart and are not shared across multiple API instances. Behind a reverse proxy, confirm the client IP handling before relying on IP-based limits. Production should apply edge/shared-store rate limiting and a carefully scoped Express `trust proxy` setting before scaling horizontally.
- Request validation and authorization are enforced in controllers. Production errors return generic messages; error logs avoid request details in production. Continue to keep logs access-controlled and avoid logging request bodies, authorization headers, or environment values.
- Booking creation, approval, resource updates, and archiving share an atomic per-resource lease in the Resource document. The default lease is 60 seconds; the holder renews it roughly every third of the lease, with a minimum interval of one second, and verifies/renews immediately before protected writes. `RESOURCE_LOCK_LEASE_MS` can tune this from 5 seconds to 15 minutes. Acquisition atomically succeeds only for an unlocked or expired lease, increments a monotonic fence, and stamps pending approval candidates with that fence. Approval writes require the matching booking fence; resource writes require the matching token, fence, and unexpired lease. A stale holder cannot release a later owner’s token. Booking creation also rechecks ownership after inserting and removes its still-pending row if it lost the lease during that write.
- MongoDB Atlas supports the single-document atomic lock updates; the implementation does not use transactions or assume replica-set transaction support. Multiple API instances using the same database coordinate on the same Resource document. A crashed process does not need an operator reset: after `approvalLockExpiresAt`, the next operation can acquire the lock. The existing recovery script remains local-only and is not exposed as an endpoint. Before a rolling deployment, stop/drain every old API instance first: old code has no expiry and does not understand fencing. App-server clocks must be synchronized (NTP); because lease comparisons use application timestamps, keep clock skew small relative to the configured lease.
- The multi-document lifecycle still is not transactional. A process termination between booking insertion and its post-insert ownership check can leave a pending booking row; it cannot approve that row without a current fence, and an archived resource cannot receive a new approval, but that row may require normal operational cleanup. A lease plus fencing greatly narrows stale-write risk without transactions; a strict atomic guarantee across Resource, Booking, and Activity documents would require a transaction on a supported replica set or a larger data-model redesign. Activity records and business actions also remain separate writes, so a crash can leave a successful action without its activity event.
- Booking/resource changes and Activity records are separate writes, not an atomic audit transaction. A crash between writes can leave a completed action without its activity event (or a lock released after the action). The current code does not assume transactions; a replica set alone would not make these separate writes atomic without a session transaction implementation.
- The repository has no frontend build pipeline or CSP headers configured. Add host-level security headers (at least a suitable CSP, `X-Content-Type-Options`, and `Referrer-Policy`) and verify the existing inline configuration scripts are allowed by the chosen CSP.

This phase prepares configuration and documentation only. It does not deploy or publish the application.
