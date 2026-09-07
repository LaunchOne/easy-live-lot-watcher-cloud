# Easy Live Lot Watcher — version 0.6.0

A personal Chrome extension for live and timed auctions powered by Easy Live Auction. It supports local desktop monitoring and an optional always-on Railway companion for Pushover alerts when the computer is closed.

Version 0.6.0 adds Railway cloud monitoring. The extension synchronizes only public auction URLs, watched lot numbers, alert stages and public lot descriptions. Railway never receives auction-house passwords, cookies, payment information or bidding access. When cloud mode is connected, Railway owns Pushover delivery and Chrome retains local desktop alerts, avoiding duplicate phone notifications. Local tab-disconnection warnings are suppressed because closing the computer is expected; cloud lookup failures use a strict two-notification limit: one initial warning and one reminder after 10 minutes, then silence until monitoring has been healthy continuously for 10 minutes.

Version 0.5.3 prevents repeated **Auction monitoring needs attention** notifications during one continuous outage. Each monitored auction now sends one warning when contact is first lost and, if it remains disconnected, one final reminder after 10 minutes. It then stays silent until monitoring has been healthy continuously for 10 minutes. Changes between related failure states, such as a stale heartbeat, closed tab or discarded tab, remain part of the same outage and do not generate extra alerts.

Version 0.5.2 fixes ended timed lots that disappear from the auction catalogue. The extension now retains the lot's last known expired deadline instead of reverting it to a missing-lot state. A successful exact lookup that no longer returns the expired lot confirms **Lot ended**, cancels its pending alarms, stops future searches and suppresses monitoring-attention notifications. Temporary lookup failures after the known deadline are also handled silently while the extension performs a conservative confirmation check.

Version 0.5.1 strengthens timed-lot persistence after a page refresh. Individual Easy Live lot URLs contain a stable sale-day identifier; the extension now uses that route-level identifier immediately, even before the catalogue data layer finishes loading, to reconnect the page to the existing saved auction watch list. It also stores a rolling local diagnostic journal for meaningful state changes, saved watches, identity resolution, catalogue errors and monitoring warnings.

A new **Report an issue** panel is available at the bottom of the popup. Use **Download issue report** immediately after a problem occurs, then attach the generated JSON file when asking for support. The report includes the extension version, sanitized settings, watched lot numbers, auction page paths, resolved identifiers, recent page state, alert schedules, health warnings and diagnostic events. It excludes passwords, cookies, payment details, the Pushover User Key and the Pushover Application API Token. Reports stay on the computer unless the user chooses to share them.

Version 0.5.0 adds automatic one-way importing of auction-account watches. When a signed-in Easy Live catalogue or lot page exposes a lot as **Watching**, the extension adds it with the current default live or timed alert stages, labels it **Imported from auction account**, and records the import locally. It uses the auction page's existing signed-in session and never reads or stores the user's auction-house password. Repeated scans do not duplicate a lot or reset an alert that has already fired. Automatic importing is enabled by default and can be turned off in settings.

An always-visible readiness indicator now appears at the top of the popup. Its subtle pulse and label distinguish **Ready**, **Add a lot**, **Locating**, **Attention**, **Disconnected** and **Complete** states without sending a test notification. A future auction that is correctly connected shows **Ready** while waiting to start. Clicking the indicator opens the detailed readiness panel; users who enable reduced motion receive the same status without continuous animation.

Version 0.4.3 fixed watched timed lots disappearing from the popup after a catalogue-page refresh. The extension reconciles the catalogue URL, the auction data identifier and the saved configuration before choosing its storage key, so a refreshed page reconnects to the original watch list. It also ignores unrelated **Bid Live** links elsewhere on a timed catalogue and changes an empty readiness result from the ambiguous **0 of 0** wording to **No watched lots added**.

Version 0.4.2 introduced recognition of live-webcast catalogue pages before their **Watch Live** page opens. You can add watched live lots from the main catalogue days in advance; the extension stores them under the same live-auction identity used by the later bidding page, so the watch list carries over when the webcast starts. Detection uses the catalogue's auction type first, with explicit **Bid Live**, **Watch Live** and **Live Webcast** markers as fallbacks for server-rendered pages.

This version also fixes future lots with no active countdown. A missing closing time is no longer evidence that a lot has ended. Such timed lots remain monitored and show **Auction not started** until the site supplies a closing time. The existing **Lot ended**, **Auction ended** and automatic monitoring-shutdown states still require an expired deadline or explicit closure evidence.

Version 0.4.1 added compatibility with Easy Live Auction's newer server-rendered catalogue and individual-lot pages. It can detect catalogues that no longer expose the earlier Alpine data layer, resolve exact lot-number searches through the catalogue's normal search route, and refresh closing times from the resulting lot pages.

This updated build also stops monitoring work when it is no longer useful:

- a confirmed ended lot is removed from the catalogue lookup cycle;
- when every watched lot is confirmed ended, scanning, alerts and reliability protection stop for that sale;
- when the page or auction data explicitly confirms the entire auction has ended, all remaining lookups and scheduled alerts are cancelled;
- unresolved watched lots change to **Unavailable — auction ended** instead of being searched indefinitely;
- the dashboard shows **Auction ended** or **Complete**, while retaining the watch list and local history; and
- ending an auction does not send a new desktop or Pushover notification.

Version 0.4.0 introduced:

- one-tab timed monitoring: keep the sale’s main catalogue open and the extension finds watched lots across catalogue pages;
- optional alert stages for each lot: live presets are 10 lots, 5 lots and live now; timed presets are 10 minutes, 3 minutes and 30 seconds;
- an all-auctions dashboard ordered by urgency;
- reliability mode, which protects active auction tabs from Chrome discarding and prevents inactivity sleep while monitoring;
- 30-second heartbeats, connection-loss warnings and an optional safe background-tab recovery setting;
- a readiness test for the page connection, data feed, watched lots, desktop notifications, Pushover and sleep protection;
- local alert history, including delivery results, connection events and timed-lot deadline extensions;
- exact alert links: timed alerts open the individual lot page and live alerts return to the live bidding page;
- no repeated alert stage after a timed deadline extension;
- an explicit **Lot ended** state and automatic release of monitoring protection for completed lots;
- live watch lists ordered by actual catalogue distance, closest first; and
- an urgency-first, accessibility-improved interface with status badges, live progress, larger countdowns, collapsible diagnostics and automatic dark mode.

The default remains one alert at **5 lots away** for live webcasts and **3 minutes before closing** for timed auctions. Extra stages are opt-in, globally for newly added lots or individually for an existing watched lot.

## Local and cloud monitoring

Without Railway enabled, keep Chrome running, the Mac online and one monitored page open for each sale:

- before a live webcast, use its **main catalogue** to prepare the watch list; when bidding starts, open the **Watch Live** page for lot-distance alerts;
- use the sale’s **main catalogue** for a timed auction—individual lot tabs are no longer required; and
- leave a MacBook lid open unless it is correctly operating in closed-display mode.

Reliability mode allows the screen to turn off and prevents normal inactivity sleep while there are active watched lots. It cannot keep local monitoring active after Chrome quits or macOS suspends the Mac.

With Railway enabled, opening Chrome is required only when adding, editing or removing watches. After the extension shows **Cloud ready**, Railway continues public-data monitoring and Pushover delivery independently. Desktop notifications remain local and therefore require Chrome to be open.

## 1. Install in Chrome

1. Unzip the downloaded package.
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the unzipped `easy-live-lot-watcher` folder.
6. Pin **Easy Live Lot Watcher** from Chrome’s Extensions menu.

Keep the unzipped folder in a permanent location. Chrome does not charge a developer registration fee to load a personal unpacked extension.

### Updating from an earlier version

Replace the files inside the same previously loaded `easy-live-lot-watcher` folder with the version 0.6.0 files. Open `chrome://extensions`, click **Reload** on the extension, and reload auction tabs that were already open.

Using the same folder and extension entry preserves watch lists, settings and Pushover keys. Timed alert stages already recorded by earlier versions remain recorded and will not repeat after an extension.

If version 0.4.1 previously saved a live catalogue under a timed-auction entry, the extension automatically moves those watched lot numbers to the confirmed live auction and applies the current default live alert stages.

## 2. Configure Railway cloud monitoring

Deploy the companion service from `LaunchOne/easy-live-lot-watcher-cloud`, attach a persistent volume at `/data`, and set `CLOUD_API_KEY`, `PUSHOVER_USER_KEY` and `PUSHOVER_APP_TOKEN` as Railway variables. Generate a Railway public domain, then enter that HTTPS URL and the same `CLOUD_API_KEY` under extension settings. Select **Save & test cloud** and wait for both the green connected status and the Pushover test message.

The cloud API key should contain at least 24 unpredictable characters. Never commit it or either Pushover key to GitHub.

## 3. Configure notifications and reliability

1. Open the extension and click the settings cog.
2. Select the default live and timed alert stages for newly added and automatically imported lots.
3. Leave **Import watched lots automatically** on if you want Easy Live lots marked **Watching** to be copied into the extension.
4. Leave **Protect active monitoring** on unless you manage sleep prevention separately.
5. Leave automatic recovery off for the safest behaviour. If enabled, the extension warns first and reloads only an unresponsive background tab, never the auction tab you are viewing.
6. Choose a connection warning delay. The default is two minutes.
7. Leave desktop notifications on.
8. Optionally configure Pushover and click **Save & test alerts**.

For Pushover, sign in at [pushover.net](https://pushover.net/), copy the User Key from the dashboard, create an application/API token named `Easy Live Lot Watcher`, and paste both values into the settings page. They stay in this local Chrome profile and are sent only to Pushover’s API.

If macOS prompts for notification access, allow Google Chrome in **System Settings → Notifications**.

## 3. Monitor a live webcast

1. Before the webcast starts, open the auction’s **main catalogue**. Once live bidding is available, open its **Watch Live** page.
2. Open Lot Watcher and enable the auction-house website when prompted.
3. Enter lot numbers separated by commas, for example `125, 208A, 310`.
4. The catalogue shows **Scheduled live** before the sale and saves the watch list. Leave the **Watch Live** page open once the webcast starts. You can browse other Chrome tabs normally.

No lot-distance alert is sent from the pre-live catalogue because it has no current live lot yet. The catalogue is used to prepare and retain the watch list; the live bidding page supplies the current-lot feed needed for the 5-lots-away calculation.

The extension follows catalogue order, so gaps and lettered lots are handled correctly. If the auction jumps over lots, it selects the nearest still-useful alert stage instead of sending several overdue warnings at once.

Watched live lots are displayed in actual catalogue order: live now, closest upcoming, remaining upcoming, passed, and lots still waiting to be located. This is based on catalogue position rather than simple lot-number subtraction.

## 4. Monitor a timed auction from one catalogue tab

1. Open the timed sale’s main catalogue page.
2. Open Lot Watcher and enable the auction-house website when prompted.
3. Enter any lot numbers from that sale and click **Add**.
4. Wait for each row to show a countdown and, for off-screen lots, **Found from main catalogue**.
5. Leave that single catalogue tab open.

The extension uses the catalogue’s available page data to resolve watched lots that are not in the visible results. On newer server-rendered Easy Live catalogues, it uses the sale's normal lot-number search route and reads the resulting lot page without navigating your open catalogue tab. Lookups are staggered and become more frequent only near a lot’s deadline. It does not open hidden lot tabs.

Chrome alarms are scheduled as soon as a deadline is known. If late bidding extends a timed lot, the countdown and any alert stages that have not yet fired move to the new deadline. A stage that already sent does not repeat. The extension records the new deadline silently in history.

When bidding closes, the row changes to **Lot ended** and is removed from future lookup cycles once closure is confirmed. When all watched lots have ended, the sale changes to **Complete** and monitoring stops. If the site explicitly confirms the full auction has ended, unresolved rows change to **Unavailable — auction ended**, pending alarms are cancelled and the dashboard shows **Auction ended**. No completion alert is sent.

If a future timed lot has not opened and the site does not provide a closing time yet, its row shows **Auction not started**. The extension keeps checking at a low rate and schedules the selected alerts once a valid deadline appears; it does not mark the lot ended merely because the countdown is absent.

Clicking a timed desktop or Pushover alert opens the exact individual lot page; clicking a live alert opens or focuses the live bidding page. Navigation never places or confirms a bid.

## 5. Edit alerts for one lot

Each watched row shows its current alert stages. Click that stage button, select one or more warnings and save. The change affects only that lot. Removing and re-adding a lot applies the current defaults for newly added lots.

## 6. Automatic auction-account imports

Sign in to the auction website normally, then use its **Watch Lot** control. When the control changes to **Watching** on an open catalogue or individual-lot page, the extension imports that lot automatically. The sync is deliberately one-way: removing a lot from the auction account does not silently cancel the extension alert. An auction page must be open briefly for account-watch importing because Railway deliberately has no access to the signed-in auction account. Once imported and synchronized, public monitoring continues in Railway.

## 7. Dashboard, readiness and history

Open the extension and select **All watches** to see every monitored auction and watched lot. The most urgent lot appears in a prominent **Next up** card, followed by auction cards ordered by urgency. Each card shows auction type, connection health and its closest lots.

On the current-auction view, click **Run readiness test** shortly before bidding. It checks:

- auction heartbeat and live/countdown data;
- whether every watched lot has been found;
- desktop notification permission;
- Pushover credentials and test delivery when enabled; and
- reliability-mode tab and sleep protection.

The test itself sends a desktop notification and, when configured, a Pushover notification. Readiness details and recent history are collapsible so urgent lots remain prominent. Alerts, tests, lost connections, recovery actions, delivery results and deadline extensions remain available in the local log.

If a fault is difficult to reproduce, open **Report an issue** at the bottom of the popup as soon as possible after it happens and select **Download issue report**. Attach that JSON file with a short description of what you were doing, such as “I added lot 125 and refreshed the catalogue.” The rolling journal retains the latest 200 diagnostic events.

## Statuses and troubleshooting

### A watched timed lot remains on “Waiting for catalogue lookup”

Use the main catalogue for the correct sale, wait up to a minute for a distant lot, and confirm the catalogue works when used normally. A temporary catalogue search failure appears in the health detail and is retried without reloading the page.

### A live catalogue says “Scheduled live”

This is the expected pre-start state. Add the live lots you want to watch, then use **Open live page** or the auction site's **Watch Live** link when bidding begins. The same watch list will appear on the live page.

### The dashboard says attention is needed

Open the auction card, confirm the site still updates, and check the internet connection. The extension sends a desktop and optional Pushover warning after the configured delay. It does not reload automatically unless you explicitly enable safe recovery.

### Desktop alerts do not appear

Confirm **Show desktop notifications** is enabled and Google Chrome is allowed under **System Settings → Notifications**. Run the readiness test.

### Pushover testing fails

Confirm the User Key belongs to the Pushover account, the Application API Token belongs to the application you created, and both were copied without spaces.

### The Mac was asleep or the lid was closed

No local browser extension can follow a changing auction page while the computer is suspended or offline. Wake the Mac, reopen or refresh the auction page, and run the readiness test before relying on alerts again.

## Scope, privacy and bidding safety

The extension does not place bids, automate sign-in or collect bid history. In cloud mode it sends only the minimum public monitoring configuration to the user's own Railway service. API keys remain in Chrome and Railway variables; they are redacted from issue reports and never committed to the repository.

Use alerts as a convenience rather than the only safeguard for a time-sensitive purchase. Site changes, skipped lots, network outages, browser suspension and notification-service delays can still prevent or delay an alert.

SMS backup and automated bidding are not included in version 0.6.0.
