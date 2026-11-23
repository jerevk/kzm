// Rows are already scoped by the caller. Only confirmed outcomes enter statistics.
export function calculatePersonalStats(rows = []) {
  const picks = Array.isArray(rows) ? rows : [];
  const stats = {
    totalPicks: picks.length,
    settledPicks: 0,
    pendingPicks: 0,
    hits: 0,
    misses: 0,
    hitRate: null,
    confirmedPoints: 0,
    doubleUsed: 0,
    doubleSettled: 0,
    doublePending: 0,
    doubleHits: 0,
    doubleMisses: 0,
    doubleHitRate: null,
    bestRounds: [],
    bestClubs: [],
  };
  const rounds = [];
  const clubs = new Map();

  for (const pick of picks) {
    const isDouble = pick?.is_double === true || pick?.is_double === 1 || pick?.is_double === '1';
    const raw = pick?.points;
    const points = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '')
      ? Number(raw)
      : NaN;
    const settled = (pick?.settled === true || pick?.settled === 1)
      && Number.isFinite(points) && points >= 0;

    if (isDouble) stats.doubleUsed += 1;
    if (!settled) {
      stats.pendingPicks += 1;
      if (isDouble) stats.doublePending += 1;
      continue;
    }

    stats.settledPicks += 1;
    stats.confirmedPoints += points;
    if (points > 0) stats.hits += 1;
    else stats.misses += 1;

    if (isDouble) {
      stats.doubleSettled += 1;
      if (points > 0) stats.doubleHits += 1;
      else stats.doubleMisses += 1;
    }

    const round = Number(pick.round_no);
    if (Number.isInteger(round) && round > 0) rounds.push({ round, points });
    if (typeof pick.team_name === 'string' && pick.team_name.trim() !== '') {
      clubs.set(pick.team_name, (clubs.get(pick.team_name) || 0) + points);
    }
  }

  if (stats.settledPicks) stats.hitRate = 100 * stats.hits / stats.settledPicks;
  if (stats.doubleSettled) stats.doubleHitRate = 100 * stats.doubleHits / stats.doubleSettled;

  const bestRoundPoints = rounds.reduce((max, round) => Math.max(max, round.points), 0);
  if (bestRoundPoints > 0) {
    stats.bestRounds = rounds.filter(round => round.points === bestRoundPoints)
      .sort((a, b) => a.round - b.round);
  }
  const bestClubPoints = [...clubs.values()].reduce((max, points) => Math.max(max, points), 0);
  if (bestClubPoints > 0) {
    stats.bestClubs = [...clubs].filter(([, points]) => points === bestClubPoints)
      .map(([name, points]) => ({ name, points }))
      .sort((a, b) => a.name.localeCompare(b.name, 'hr'));
  }

  return stats;
}
