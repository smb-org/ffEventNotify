  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_key TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL CHECK (event_type IN ('seasonal-special', 'maintenance', 'topic-generic')),
    title TEXT NOT NULL,
    title_status TEXT NOT NULL DEFAULT 'ok' CHECK (title_status IN ('ok', 'unsicher')),
    title_reason TEXT,
    start_utc TEXT,
    start_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (start_status IN ('ok', 'unsicher')),
    start_reason TEXT DEFAULT 'not extracted',
    end_utc TEXT,
    end_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (end_status IN ('ok', 'unsicher')),
    end_reason TEXT DEFAULT 'not extracted',
    rewards_json TEXT NOT NULL DEFAULT '[]',
    rewards_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (rewards_status IN ('ok', 'unsicher')),
    rewards_reason TEXT DEFAULT 'not extracted',
    description TEXT,
    description_status TEXT NOT NULL DEFAULT 'unsicher' CHECK (description_status IN ('ok', 'unsicher')),
    description_reason TEXT DEFAULT 'not extracted',
    discord_message_id TEXT,
    scheduled_event_id TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS event_sources (
    url TEXT PRIMARY KEY,
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('topic', 'special', 'maintenance', 'followup', 'feed', 'banner')),
    published_at TEXT,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS field_provenance (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    field TEXT NOT NULL CHECK (field IN ('title', 'start', 'end', 'rewards', 'description')),
    source_url TEXT NOT NULL REFERENCES event_sources(url) ON DELETE CASCADE,
    source_time TEXT NOT NULL,
    PRIMARY KEY (event_id, field)
  );

  CREATE TABLE IF NOT EXISTS items (
    item_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS seen_entries (
    url TEXT PRIMARY KEY,
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    classification TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS warnings_sent (
    key TEXT PRIMARY KEY
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checklist_entries (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    item_id TEXT NOT NULL REFERENCES items(item_id),
    acquired INTEGER NOT NULL DEFAULT 0 CHECK (acquired IN (0, 1)),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (event_id, user_id, item_id)
  );

  CREATE TABLE IF NOT EXISTS reminders (
    event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    lead_hours INTEGER NOT NULL CHECK (lead_hours IN (24, 72)),
    due_at TEXT NOT NULL,
    sent_at TEXT,
    PRIMARY KEY (event_id, user_id, lead_hours)
  );

  CREATE INDEX IF NOT EXISTS idx_events_end_utc ON events(end_utc);
  CREATE INDEX IF NOT EXISTS idx_event_sources_event_id ON event_sources(event_id);
  CREATE INDEX IF NOT EXISTS idx_seen_entries_first_seen_at ON seen_entries(first_seen_at);
