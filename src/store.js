import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export function emptyState() {
  return {
    format: 1,
    revision: 0,
    syncedAt: null,
    auctions: {},
    runtime: {},
    alerts: {},
    incidents: {},
    completedAuctions: {},
    completedLots: {},
    events: []
  };
}

export class StateStore {
  constructor(filename) {
    this.filename = filename;
    this.state = emptyState();
    this.queue = Promise.resolve();
  }

  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.filename, "utf8"));
      this.state = { ...emptyState(), ...parsed };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await this.save();
    }
    return this.state;
  }

  mutate(action) {
    const job = this.queue.then(async () => {
      const result = await action(this.state);
      this.state.revision = Number(this.state.revision || 0) + 1;
      await this.save();
      return result;
    });
    this.queue = job.catch(() => null);
    return job;
  }

  event(type, details = {}, level = "info") {
    this.state.events.unshift({ id: crypto.randomUUID(), time: Date.now(), type, level, details });
    this.state.events = this.state.events.slice(0, 300);
  }

  async save() {
    await mkdir(dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.filename);
  }
}
