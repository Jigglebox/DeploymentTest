// Pure decision logic. No I/O: easy to test, easy to reason about.
// Returns { allow: boolean, reason?, trip?: boolean, alerts: [] }

export function decide({ key, snapshot, estimateUsd = 0, model = null }) {
  const p = key.policy;
  const alerts = [];
  const deny = (reason, extra = {}, trip = false) => ({ allow: false, reason, trip, alerts, ...extra });

  if (key.status === 'tripped') return deny('circuit_open', { detail: key.tripped_reason });
  if (key.status === 'disabled') return deny('key_disabled');

  if (p.allowed_models?.length && (!model || !p.allowed_models.some((m) => model.startsWith(m)))) {
    return deny('model_not_allowed', { detail: model ? `model ${model} is not in allowed_models` : 'request does not name a model' });
  }
  if (p.rpm_limit && snapshot.requestsLastMinute >= p.rpm_limit) {
    return deny('rate_limited', { detail: `${snapshot.requestsLastMinute} requests in the last 60s (limit ${p.rpm_limit})` });
  }
  if (p.loop_max_repeats && snapshot.repeats >= p.loop_max_repeats) {
    return deny('loop_detected', { detail: `identical request repeated ${snapshot.repeats}x within ${p.loop_window_sec}s` }, true);
  }

  const budgets = [
    ['monthly', p.monthly_budget_usd, snapshot.monthUsd],
    ['daily', p.daily_budget_usd, snapshot.dayUsd],
    ['run', p.per_run_budget_usd, snapshot.runUsd],
  ];
  for (const [scope, limit, spent] of budgets) {
    if (limit == null) continue;
    if (spent >= limit) return deny('budget_exceeded', { scope, limit, spent }, true);
    if (spent + estimateUsd > limit) {
      return deny('budget_would_exceed', { scope, limit, spent, estimate: estimateUsd, detail: `this call (~$${estimateUsd.toFixed(4)}) would push ${scope} spend past $${limit}` });
    }
  }

  // Burn-rate alert: if the last hour's pace would exhaust the monthly budget before month end.
  if (p.monthly_budget_usd && p.burn_rate_alert_pct) {
    const pct = (snapshot.monthUsd / p.monthly_budget_usd) * 100;
    if (pct >= p.burn_rate_alert_pct) alerts.push({ type: 'budget_threshold', pct: Math.round(pct) });
    const hoursLeft = hoursLeftInMonth();
    const projected = snapshot.monthUsd + snapshot.hourUsd * hoursLeft;
    if (snapshot.hourUsd > 0 && projected > p.monthly_budget_usd * 1.5) {
      alerts.push({ type: 'burn_rate', projectedUsd: Number(projected.toFixed(2)), hourUsd: Number(snapshot.hourUsd.toFixed(4)) });
    }
  }
  return { allow: true, alerts };
}

/** After a request is metered: should the breaker open so the NEXT call is blocked? */
export function postCheck({ key, snapshot }) {
  const p = key.policy;
  if (p.monthly_budget_usd != null && snapshot.monthUsd >= p.monthly_budget_usd) return { trip: true, reason: 'budget_exceeded', scope: 'monthly', spent: snapshot.monthUsd, limit: p.monthly_budget_usd };
  if (p.daily_budget_usd != null && snapshot.dayUsd >= p.daily_budget_usd) return { trip: true, reason: 'budget_exceeded', scope: 'daily', spent: snapshot.dayUsd, limit: p.daily_budget_usd };
  return { trip: false };
}

export function hoursLeftInMonth(now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(1, (end - now.getTime()) / 36e5);
}
