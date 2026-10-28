CREATE TABLE notes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    x REAL,
    y REAL,
    rotation REAL NOT NULL DEFAULT 0,
    z_index INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX notes_visible ON notes(archived, seq);
