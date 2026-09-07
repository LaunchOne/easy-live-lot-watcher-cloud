# Easy Live Lot Watcher Cloud

An always-on Railway companion for the Easy Live Lot Watcher Chrome extension. It monitors public Easy Live auction pages and sends Pushover alerts while the user's computer is asleep or closed.

Service v1.0.1 monitors live watches whether they were prepared from the scheduled catalogue or added directly from the **Bid Live** page. The public health response includes separate live/timed auction and watched-lot counts for synchronization checks.

## Safety boundaries

- Public auction information only.
- No auction-house usernames, passwords, cookies or account sessions.
- No payment information.
- No automated bidding or bid-button interaction.
- API and Pushover credentials are Railway variables and must never be committed.

## Railway deployment

1. In Railway, create a project from this GitHub repository.
2. Add a persistent volume and mount it at `/data`.
3. Add these service variables:

   - `CLOUD_API_KEY`: a random value of at least 24 characters.
   - `PUSHOVER_USER_KEY`: the Pushover account User Key.
   - `PUSHOVER_APP_TOKEN`: the Pushover application API token.
   - `PUSHOVER_PRIORITY`: optional; defaults to `1`.
   - `DATA_FILE`: optional; defaults to `/data/state.json`.
   - `POLL_INTERVAL_SECONDS`: optional; defaults to `30` and cannot be lower than `15`.

4. Generate a public Railway domain for the service.
5. Confirm `https://YOUR-DOMAIN/health` returns JSON with `"ok": true`.
6. Install extension v0.6.0, enter the Railway URL and `CLOUD_API_KEY`, then use **Save & test cloud**.

Do not place secrets in this repository. The `.env.example` file contains names only.

## Monitoring behaviour

The extension sends the service a complete watch-list snapshot. Removing a watch locally removes it from Railway on the next synchronization. Railway checks active auctions every 30 seconds by default, persists alert de-duplication state on the `/data` volume and stops scanning auctions confirmed complete.

Timed alert stages send once even when a deadline is extended. If monitoring starts late, only the nearest useful stage is sent. Live lots use catalogue order where available, including lettered lot numbers.

An auction-page failure sends at most two Pushover warnings for one continuous incident: an initial warning and one reminder after 10 minutes. Further warnings remain suppressed until the page has been healthy continuously for 10 minutes and a new incident begins.

## API

`GET /health` is public for Railway health checks. All `/api/*` routes require `Authorization: Bearer CLOUD_API_KEY`.

- `PUT /api/sync` replaces the complete watch configuration.
- `GET /api/status` returns sanitized runtime status and recent service events.
- `POST /api/test` sends a Pushover test.
- `POST /api/check` triggers an immediate monitoring pass.

## Local tests

```bash
npm test
```
