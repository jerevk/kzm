PRAGMA foreign_keys=ON;
CREATE TABLE meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO meta VALUES('picks_enabled','0'),('initialized','0'),('dataset_imported','0'),('importing','0');
CREATE TABLE players (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE,
 password_hash TEXT NOT NULL, salt TEXT NOT NULL, iterations INTEGER NOT NULL DEFAULT 100000,
 active INTEGER NOT NULL DEFAULT 1 CHECK(active IN(0,1)),
 is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN(0,1)), created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE TABLE sessions (
 token_hash TEXT PRIMARY KEY,player_id TEXT NOT NULL REFERENCES players(id),expires_at INTEGER NOT NULL,
 created_at INTEGER NOT NULL DEFAULT(unixepoch())
);
CREATE INDEX sessions_player ON sessions(player_id);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE rate_limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX rates_expiry ON rate_limits(expires_at);
CREATE TABLE teams (id TEXT PRIMARY KEY,name TEXT NOT NULL,name_key TEXT NOT NULL UNIQUE,base INTEGER NOT NULL CHECK(base BETWEEN 0 AND 100),color TEXT NOT NULL DEFAULT '#37003C',api_id INTEGER UNIQUE);
CREATE TABLE rounds (
 number INTEGER PRIMARY KEY CHECK(number BETWEEN 1 AND 38),cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 4),
 deadline INTEGER, manual_deadline INTEGER NOT NULL DEFAULT 0 CHECK(manual_deadline IN(0,1)),
 CHECK(cycle=CASE WHEN number<=10 THEN 1 WHEN number<=19 THEN 2 WHEN number<=28 THEN 3 ELSE 4 END)
);
WITH RECURSIVE nums(n) AS(SELECT 1 UNION ALL SELECT n+1 FROM nums WHERE n<38)
INSERT INTO rounds(number,cycle) SELECT n,CASE WHEN n<=10 THEN 1 WHEN n<=19 THEN 2 WHEN n<=28 THEN 3 ELSE 4 END FROM nums;
CREATE TABLE fixtures (
 id TEXT PRIMARY KEY,round_no INTEGER NOT NULL REFERENCES rounds(number),home_id TEXT NOT NULL REFERENCES teams(id),away_id TEXT NOT NULL REFERENCES teams(id),
 kickoff INTEGER,home_score INTEGER CHECK(home_score BETWEEN 0 AND 99),away_score INTEGER CHECK(away_score BETWEEN 0 AND 99),
 status TEXT NOT NULL DEFAULT 'SCHEDULED',api_id INTEGER UNIQUE,manual_score INTEGER NOT NULL DEFAULT 0 CHECK(manual_score IN(0,1)),
 CHECK(home_id<>away_id),CHECK((home_score IS NULL)=(away_score IS NULL)), UNIQUE(round_no,home_id,away_id)
);
CREATE INDEX fixtures_round ON fixtures(round_no);
CREATE TABLE picks (
 player_id TEXT NOT NULL REFERENCES players(id),round_no INTEGER NOT NULL REFERENCES rounds(number),cycle INTEGER NOT NULL,
 team_id TEXT NOT NULL REFERENCES teams(id),is_double INTEGER NOT NULL DEFAULT 0 CHECK(is_double IN(0,1)),
 base INTEGER NOT NULL CHECK(base BETWEEN 0 AND 100),imported_points REAL,updated_at INTEGER NOT NULL DEFAULT(unixepoch()),
 PRIMARY KEY(player_id,round_no),UNIQUE(player_id,cycle,team_id),
 CHECK(cycle=CASE WHEN round_no<=10 THEN 1 WHEN round_no<=19 THEN 2 WHEN round_no<=28 THEN 3 ELSE 4 END)
);
CREATE UNIQUE INDEX one_double_per_cycle ON picks(player_id,cycle) WHERE is_double=1;
CREATE INDEX picks_round ON picks(round_no);
CREATE TABLE payments (player_id TEXT NOT NULL REFERENCES players(id),cycle INTEGER NOT NULL CHECK(cycle BETWEEN 1 AND 4),paid INTEGER CHECK(paid IN(0,1)),updated_at INTEGER NOT NULL DEFAULT(unixepoch()),PRIMARY KEY(player_id,cycle));
CREATE TABLE audit (id INTEGER PRIMARY KEY,actor_id TEXT,action TEXT NOT NULL,target TEXT,created_at INTEGER NOT NULL DEFAULT(unixepoch()));
CREATE TABLE import_history (id TEXT PRIMARY KEY,created_at INTEGER NOT NULL DEFAULT(unixepoch()),summary TEXT NOT NULL);
CREATE VIEW pick_scores AS
 SELECT p.*,t.name AS team_name,u.name AS player_name,
 f.home_id,f.away_id,f.home_score,f.away_score,f.status AS match_status,
 CASE WHEN r.deadline IS NOT NULL AND r.deadline<=unixepoch() THEN
 COALESCE(p.imported_points,
 CASE WHEN f.status IN('FINISHED','IN_PLAY','PAUSED','AWARDED') AND f.home_score IS NOT NULL AND f.away_score IS NOT NULL THEN
 (CASE WHEN p.team_id=f.home_id THEN CASE WHEN f.home_score>f.away_score THEN p.base ELSE 0 END
 ELSE CASE WHEN f.away_score>f.home_score THEN p.base+1 WHEN f.away_score=f.home_score THEN 1 ELSE 0 END END)*(1+p.is_double)
 ELSE NULL END) ELSE NULL END AS points
 FROM picks p JOIN players u ON u.id=p.player_id JOIN teams t ON t.id=p.team_id JOIN rounds r ON r.number=p.round_no
 LEFT JOIN fixtures f ON f.id=(SELECT x.id FROM fixtures x WHERE x.round_no=p.round_no AND(p.team_id=x.home_id OR p.team_id=x.away_id) ORDER BY x.kickoff,x.id LIMIT 1);
CREATE TRIGGER pick_insert_guard BEFORE INSERT ON picks WHEN (SELECT value FROM meta WHERE key='importing')<>'1'
BEGIN
 SELECT RAISE(ABORT,'PICKS_DISABLED') WHERE (SELECT value FROM meta WHERE key='picks_enabled')<>'1';
 SELECT RAISE(ABORT,'PLAYER_INACTIVE') WHERE NOT EXISTS(SELECT 1 FROM players WHERE id=NEW.player_id AND active=1);
 SELECT RAISE(ABORT,'ROUND_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE number=NEW.round_no AND deadline>unixepoch());
END;
CREATE TRIGGER pick_update_guard BEFORE UPDATE OF team_id,is_double ON picks WHEN (SELECT value FROM meta WHERE key='importing')<>'1'
BEGIN
 SELECT RAISE(ABORT,'PICKS_DISABLED') WHERE (SELECT value FROM meta WHERE key='picks_enabled')<>'1';
 SELECT RAISE(ABORT,'PLAYER_INACTIVE') WHERE NOT EXISTS(SELECT 1 FROM players WHERE id=NEW.player_id AND active=1);
 SELECT RAISE(ABORT,'ROUND_LOCKED') WHERE NOT EXISTS(SELECT 1 FROM rounds WHERE number=NEW.round_no AND deadline>unixepoch());
END;
