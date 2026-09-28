// 日志清理只读预览:列出按规则要删多少噪音明细、要留多少每日摘要。只读打开数据库,不改任何行。
// 用法:node scripts/maintenance-dry-run.mjs /绝对路径/state.sqlite [--days-ahead N]
//   --days-ahead N 假设「现在」是 N 天之后,用来预览数据再老几天时会清掉什么(默认 0)。
// 需要先 npm run build -w @trade-gate/gateway。
import { DatabaseSync } from 'node:sqlite';
import { maintain } from '../packages/gateway/dist/demo/maintenance.js';

const DAY = 86_400_000;
const [file, flag, value] = process.argv.slice(2);
if (!file?.startsWith('/')) {
  console.error('请指定数据库绝对路径');
  process.exit(2);
}
const daysAhead = flag === '--days-ahead' ? Number(value) : 0;
if (!Number.isFinite(daysAhead) || daysAhead < 0) {
  console.error('--days-ahead 必须是非负数');
  process.exit(2);
}

process.env['TG_MAINTENANCE_DRY_RUN'] = '1';
const db = new DatabaseSync(file, { readOnly: true });
try {
  const result = await maintain(db, file, Date.now() + daysAhead * DAY);
  const { plan, deleted, summarized, logs_before: logsBefore, cutoff, snapshots_thinned: snapshotsThinned } = result;
  console.log(JSON.stringify({ cutoff: new Date(cutoff).toISOString(), logs_before: logsBefore, would_delete: deleted, would_keep_as_summary: summarized, logs_after: logsBefore - deleted, plan, snapshots_would_thin: snapshotsThinned }, null, 2));
} finally {
  db.close();
}
