const requestedStage = Math.min(4, Math.max(1,
  Math.floor(Number(new URLSearchParams(location.search).get('stage')) || 1)));
showStage(requestedStage);
