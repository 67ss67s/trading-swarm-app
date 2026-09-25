"""可选图表：python3 scripts/plot-entry-study.py；需要 matplotlib，读取已归档研究JSON。"""
import json
from datetime import datetime, timezone
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates

root = Path(__file__).resolve().parents[1] / 'docs/research'
entry = json.loads((root / 'entry-study-2026-09-12.json').read_text())
params = json.loads((root / 'param-study-2026-09-12.json').read_text())
fig, axes = plt.subplots(3, 2, figsize=(13, 11), layout='constrained')
colors = ['#a64037', '#306aab', '#318567']
def curve(ax, stats, label, color):
    points = stats['fixed_risk_daily_curve']
    if points:
        xs = [datetime.fromtimestamp(p['at']/1000, timezone.utc) for p in points]
        ax.step(xs, [p['r'] for p in points], where='post', label=label, color=color, linewidth=1.5)
for ax, row in zip(axes[:, 0], entry['results']):
    for arm, color in zip(row['arms'], colors):
        curve(ax, arm['oos'], arm['mode'], color)
    ax.set_title(row['id'] + ' | purged 20d OOS folds', fontsize=10)
    ax.legend(fontsize=8, frameon=False)
for ax, row in zip(axes[:, 1], params['results']):
    chosen = row['selected']
    ax.set_title(row['id'] + ' | one frozen OOS', fontsize=10)
    if chosen:
        curve(ax, chosen['oos'], f"candidate #{chosen['index']}", '#6f4fa0')
        ax.legend(fontsize=8, frameon=False)
    else:
        ax.set_axis_off()
        ax.text(.5, .5, 'No eligible training candidate\nOOS not run', ha='center', va='center', transform=ax.transAxes)
for ax in axes.flat:
    if not ax.axison:
        continue
    ax.axhline(0, color='#444444', linewidth=.6)
    ax.grid(alpha=.18)
    ax.set_ylabel('Cumulative R (fixed 1R per opportunity)')
    ax.xaxis.set_major_formatter(mdates.DateFormatter('%b %d'))
    ax.tick_params(axis='x', rotation=20, labelsize=8)
fig.suptitle('P9 | Concurrent mark-to-market equity, daily closing samples\nNo capital cap; research curves are not deployable account returns', fontsize=13)
fig.savefig(root / 'entry-param-equity-2026-09-12.svg')
fig.savefig('/tmp/p9-equity-preview.png', dpi=120)
