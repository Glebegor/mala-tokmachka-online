// Mod scripts run in a sandbox. Available: sw.on(event, fn), sw.giveResource(playerId, res, n),
// sw.teamPlayers(team), sw.toast(text), sw.log(...).
sw.on('pointCaptured', (e) => {
  for (const id of sw.teamPlayers(e.team)) sw.giveResource(id, 'money', 120);
  sw.toast('Point ' + e.id + ' captured: +120 money to the capturing team');
});

sw.on('buildingCompleted', (e) => {
  if (e.def === 'mine') sw.giveResource(e.owner, 'ore', 20); // signing bonus
});
