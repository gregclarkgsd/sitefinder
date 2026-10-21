// Test-only persistent psql sessions inside the fixed disposable Docker stack.
// No host, URL, password, environment credential or remote fallback is accepted.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export function localTestPool(onQuery = async () => {}) {
  return { async connect() {
    const child = spawn('docker', ['exec', '-i', 'supabase_db_sitefinder', 'psql',
      '-X', '-qAt', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']);
    let pending, output = '', errors = '', closed = false;
    const fail = error => { closed = true; if (pending) { clearTimeout(pending.timer); pending.reject(error); pending = null; } };
    child.on('error', fail);
    child.on('close', code => fail(new Error(`Local psql exited (${code}): ${errors}`)));
    child.stdin.on('error', fail);
    child.stderr.on('data', chunk => { errors += chunk; });
    child.stdout.on('data', chunk => {
      output += chunk;
      let end;
      while ((end = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, end).trim(); output = output.slice(end + 1);
        if (!pending) continue;
        if (line === pending.marker) {
          const active = pending; pending = null; clearTimeout(active.timer);
          try { active.resolve({ rows: active.lines.flatMap(line => JSON.parse(line)) }); }
          catch (error) { active.reject(error); }
        } else if (line) pending.lines.push(line);
      }
    });
    const connection = {
      async query(source, params = []) {
        if (closed || pending) throw new Error('Closed or concurrent test connection');
        // Literal substitution is confined to synthetic fixtures in this test
        // harness; it is not the production parameterized transport.
        const literal = value => {
          if (value === null) return 'NULL';
          if (typeof value === 'number' && Number.isFinite(value)) return String(value);
          if (typeof value !== 'string') throw new Error('Unsupported synthetic parameter');
          return "'" + value.replaceAll("'", "''") + "'";
        };
        const sql = source.replace(/\$(\d+)/g, (_, n) => {
          if (Number(n) > params.length) throw new Error('Missing test parameter');
          return literal(params[Number(n) - 1]);
        }).replace(/;\s*$/, '');
        const control = /^(BEGIN|COMMIT|ROLLBACK|SET)\b/i.test(sql);
        let command = sql;
        if (!control) {
          const rows = /^select\b/i.test(sql.trim()) ? `select * from (${sql}) as selected`
            : `${sql}${/\breturning\b/i.test(sql) ? '' : ' returning 1'}`;
          command = `with test_rows as (${rows}) select coalesce(json_agg(test_rows),'[]'::json) from test_rows`;
        }
        const result = await new Promise((resolve, reject) => {
          const marker = `done_${randomUUID()}`;
          const timer = setTimeout(() => { fail(new Error('Local test query timeout')); child.kill(); }, 15000);
          pending = { resolve, reject, marker, lines: [], timer };
          child.stdin.write(`${command};\n\\echo ${marker}\n`);
        });
        await onQuery(source, result);
        return result;
      },
      release() { child.stdin.end(); },
    };
    return connection;
  } };
}
