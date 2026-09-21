/** A scored attempt is green only when the agent finished successfully. */
export function roundGreen(round) {
  return round.audited === true && round.total > 0 && round.passed === round.total &&
    round.exitCode === 0 && round.timedOut === false &&
    (!round.confirmTurn || (round.confirmExitCode === 0 && round.confirmTimedOut === false));
}

export function summarizeRounds(rounds, requestedRounds) {
  const conclusive = rounds.filter((round) => round.audited);
  const fullPasses = conclusive.filter(roundGreen).length;
  const voided = rounds.length - conclusive.length;
  const failed = conclusive.length - fullPasses;
  return {
    requestedRounds,
    attempts: rounds.length,
    conclusive: conclusive.length,
    voided,
    fullPasses,
    // Documentation can be assessed only after unpacking; prompt reliability includes every attempt.
    promptPassed: rounds.length === requestedRounds && fullPasses === requestedRounds,
    exitCode: failed > 0 ? 1 : conclusive.length < requestedRounds ? 2 : 0,
  };
}

export function cellGreen(cell, requestedRounds) {
  return cell.exitCode === 0 && Array.isArray(cell.rounds) &&
    summarizeRounds(cell.rounds, requestedRounds).promptPassed;
}

export function positiveNumber(value, flag, integer = false) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error(`${flag} must be a positive ${integer ? 'integer' : 'number'}`);
  }
  return parsed;
}
