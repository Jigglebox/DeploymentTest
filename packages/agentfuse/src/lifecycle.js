// Onboarding emails for hosted orgs: a welcome with the three setup steps, then nudges for orgs that stall.
// Each nudge is sent once per org (flag in ops_kv). Nothing is sent in single-tenant mode or without a mailer.
export function createLifecycle({ store, config, ops, mailer, now = () => new Date() }) {
  const hosted = config.mode === 'hosted';
  const base = config.publicUrl;
  const send = async (org, kind, subject, text) => {
    if (!mailer || !org.email) return false;
    const flag = `lifecycle:${kind}:${org.id}`;
    if (ops.kv.get(flag)) return false;
    await mailer.send({ from: config.fromEmail, to: org.email, subject, text });
    ops.kv.set(flag, now().toISOString());
    ops.track('lifecycle_email', { tenant: org.id, props: { kind } });
    return true;
  };
  return {
    welcome: (org) => hosted && send(org, 'welcome', 'Welcome to AgentFuse: three steps to a protected agent',
      `Hi,\n\nYour AgentFuse account is ready. Three steps and your first agent has a hard budget:\n\n1. Add your OpenAI or Anthropic key under "Provider keys": ${base}/\n2. Create an agent key with a monthly cap: ${base}/\n3. Point your SDK at ${base}/openai/v1 (or ${base}/anthropic) with that af_live_ key: ${base}/docs\n\nAny call that would breach the cap gets a 402 before it leaves your network. Reply to this email if anything is unclear.\n\n— AgentFuse`),
    /** Called hourly by the scheduler. */
    async tick() {
      if (!hosted || !mailer) return { sent: 0 };
      const t = now().getTime();
      let sent = 0;
      for (const org of store.orgsWithoutKeys(new Date(t - 48 * 3600_000).toISOString())) {
        if (await send(org, 'nudge_no_key', 'Your AgentFuse account has no agent key yet', `Hi,\n\nYou signed up two days ago but no agent key exists yet, so nothing is protected. It takes a minute: ${base}/\n\nIf you hit a snag, reply and a human will help.\n\n— AgentFuse`)) sent++;
      }
      for (const org of store.orgsWithoutTraffic(new Date(t - 7 * 86400_000).toISOString())) {
        if (await send(org, 'nudge_no_traffic', 'AgentFuse has not seen a request from your agents yet', `Hi,\n\nYour agent key exists but no request has come through the proxy in a week. The usual cause is the base URL: set OPENAI_BASE_URL=${base}/openai/v1 or ANTHROPIC_BASE_URL=${base}/anthropic and use the af_live_ key as the API key. Details: ${base}/docs\n\n— AgentFuse`)) sent++;
      }
      return { sent };
    },
  };
}
