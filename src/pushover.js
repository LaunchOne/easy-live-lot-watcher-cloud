export class Pushover {
  constructor({ userKey, appToken, priority = 1, fetchImpl = fetch }) {
    this.userKey = userKey;
    this.appToken = appToken;
    this.priority = priority;
    this.fetch = fetchImpl;
  }

  get configured() {
    return Boolean(this.userKey && this.appToken);
  }

  async send({ title, message, url = "" }) {
    if (!this.configured) throw new Error("Pushover is not configured on Railway.");
    const body = new URLSearchParams({
      token: this.appToken,
      user: this.userKey,
      title: String(title).slice(0, 250),
      message: String(message).slice(0, 1024),
      priority: String(this.priority),
      sound: "pushover"
    });
    if (url) {
      body.set("url", url);
      body.set("url_title", "Open auction");
    }
    const response = await this.fetch("https://api.pushover.net/1/messages.json", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
      body
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.status !== 1) {
      const detail = Array.isArray(result.errors) ? result.errors.join(" ") : `HTTP ${response.status}`;
      throw new Error(`Pushover rejected the alert: ${detail}`);
    }
    return result;
  }
}
