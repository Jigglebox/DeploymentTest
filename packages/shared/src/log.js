// Structured JSON logging to stdout; quiet under tests.
const level = process.env.LOG_LEVEL ?? (process.env.NODE_TEST_CONTEXT ? 'silent' : 'info');
const order = { silent: 99, error: 40, warn: 30, info: 20, debug: 10 };
function emit(lvl, msg, fields) {
  if (order[lvl] < order[level]) return;
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), level: lvl, msg, ...fields }) + '\n');
}
export const log = {
  debug: (m, f = {}) => emit('debug', m, f),
  info: (m, f = {}) => emit('info', m, f),
  warn: (m, f = {}) => emit('warn', m, f),
  error: (m, f = {}) => emit('error', m, f),
};
