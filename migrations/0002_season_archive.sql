-- Historical standings only. Existing live-season tables and picks are untouched.
CREATE TABLE IF NOT EXISTS season_archive_standings (
 season INTEGER NOT NULL CHECK(season BETWEEN 2000 AND 2100),
 scope TEXT NOT NULL CHECK(scope IN ('all','1','2','3','4')),
 player_name TEXT NOT NULL,
 points REAL NOT NULL,
 position INTEGER NOT NULL CHECK(position BETWEEN 1 AND 500),
 source_note TEXT NOT NULL DEFAULT '',
 updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
 PRIMARY KEY(season,scope,player_name)
);
CREATE INDEX IF NOT EXISTS season_archive_order ON season_archive_standings(season,scope,position);
