"""Psychometric Item Analysis and Batch Report Generation.

Calculates:
- Facility Index (Item Difficulty, P = correct / N)
- Discrimination Index (Upper 27% vs Lower 27% cohort difference)
- Point-Biserial Correlation (r_pbis between item score and total test score)
- Frequency Distribution of selected options (A, B, C, D, E, Blank, Multi)
- Test Reliability (Cronbach's Alpha) and descriptive statistics

Renders a self-contained static HTML report via Jinja2.
"""
from __future__ import annotations

import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

import jinja2

from omr.grading import AnswerKey, ExamGrade


@dataclass
class DistractorStat:
    option: str
    count: int
    percentage: float
    is_correct: bool


@dataclass
class ItemStats:
    """Psychometric statistics for an individual exam item."""

    key: str
    kind: str
    correct_answer: str
    points: float
    facility_index: float  # P: 0.0 (hard) to 1.0 (easy)
    discrimination_index: float  # D: Upper 27% vs Lower 27%
    point_biserial: float  # r_pbis: item correlation with total score
    distractors: list[DistractorStat]
    blank_count: int
    multi_count: int

    @property
    def difficulty_label(self) -> str:
        if self.facility_index > 0.85:
            return "Easy"
        elif self.facility_index < 0.35:
            return "Hard"
        return "Moderate"

    @property
    def discrimination_quality(self) -> str:
        if self.discrimination_index >= 0.35:
            return "Excellent"
        elif self.discrimination_index >= 0.20:
            return "Good"
        elif self.discrimination_index >= 0.0:
            return "Fair / Weak"
        return "Poor / Negative"


@dataclass
class BatchPsychometrics:
    """Aggregated test statistics across a cohort of exams."""

    exam_title: str
    num_students: int
    total_possible_score: float
    mean_score: float
    median_score: float
    std_dev: float
    min_score: float
    max_score: float
    mean_percentage: float
    cronbach_alpha: float
    items: list[ItemStats]
    grades: list[ExamGrade]

    def to_dict(self) -> dict[str, Any]:
        return {
            "exam_title": self.exam_title,
            "num_students": self.num_students,
            "mean_score": round(self.mean_score, 2),
            "median_score": round(self.median_score, 2),
            "std_dev": round(self.std_dev, 2),
            "min_score": round(self.min_score, 2),
            "max_score": round(self.max_score, 2),
            "cronbach_alpha": round(self.cronbach_alpha, 3),
            "items": [
                {
                    "key": it.key,
                    "facility_index": round(it.facility_index, 3),
                    "discrimination_index": round(it.discrimination_index, 3),
                    "point_biserial": round(it.point_biserial, 3),
                }
                for it in self.items
            ],
        }


def compute_pearson_r(x: Sequence[float], y: Sequence[float]) -> float:
    """Computes Pearson correlation coefficient between two numeric sequences."""
    n = len(x)
    if n < 3:
        return 0.0

    mean_x = sum(x) / n
    mean_y = sum(y) / n

    cov = sum((xi - mean_x) * (yi - mean_y) for xi, yi in zip(x, y))
    var_x = sum((xi - mean_x) ** 2 for xi in x)
    var_y = sum((yi - mean_y) ** 2 for yi in y)

    denom = math.sqrt(var_x * var_y)
    if denom == 0.0:
        return 0.0
    return float(cov / denom)


class PsychometricAnalyzer:
    """Analyzes a batch of graded exams to compute test statistics."""

    def __init__(self, key: AnswerKey):
        self.key = key

    def analyze(self, grades: list[ExamGrade]) -> BatchPsychometrics:
        n = len(grades)
        if n == 0:
            raise ValueError("Cannot perform psychometric analysis on empty grades list.")

        scores = [g.score for g in grades]
        total_possible = self.key.total_points
        mean_score = sum(scores) / n

        sorted_scores = sorted(scores)
        if n % 2 == 1:
            median_score = sorted_scores[n // 2]
        else:
            median_score = (sorted_scores[n // 2 - 1] + sorted_scores[n // 2]) / 2.0

        variance = sum((s - mean_score) ** 2 for s in scores) / max(1, (n - 1))
        std_dev = math.sqrt(variance)
        min_score = sorted_scores[0]
        max_score = sorted_scores[-1]
        mean_pct = (mean_score / total_possible * 100.0) if total_possible > 0 else 0.0

        # Kelly's 27% rule for upper and lower cohorts
        cohort_size = max(1, int(round(n * 0.27)))
        sorted_by_score = sorted(grades, key=lambda g: g.score)
        lower_cohort = sorted_by_score[:cohort_size]
        upper_cohort = sorted_by_score[-cohort_size:]

        # Item analysis
        item_stats_list: list[ItemStats] = []
        item_variances: list[float] = []

        for item_key, key_spec in self.key.items.items():
            # Extract scores and responses for this item across all examinees
            item_scores: list[float] = []
            responses: list[str] = []

            for g in grades:
                ig = g.items.get(item_key)
                if ig:
                    item_scores.append(ig.points_awarded)
                    responses.append(ig.student_response)
                else:
                    item_scores.append(0.0)
                    responses.append("?")

            # Facility Index (Mean points ratio)
            mean_item_score = sum(item_scores) / n
            facility_index = (
                (mean_item_score / key_spec.points) if key_spec.points > 0 else 0.0
            )

            # Discrimination Index (Upper cohort mean - Lower cohort mean)
            upper_scores = [
                g.items[item_key].points_awarded for g in upper_cohort if item_key in g.items
            ]
            lower_scores = [
                g.items[item_key].points_awarded for g in lower_cohort if item_key in g.items
            ]
            mean_upper = (sum(upper_scores) / len(upper_scores)) if upper_scores else 0.0
            mean_lower = (sum(lower_scores) / len(lower_scores)) if lower_scores else 0.0
            max_pts = max(1e-6, key_spec.points)
            discrim_index = (mean_upper - mean_lower) / max_pts

            # Point-Biserial correlation
            r_pbis = compute_pearson_r(item_scores, scores)

            # Variance for Cronbach's Alpha
            item_var = sum((s - mean_item_score) ** 2 for s in item_scores) / max(1, (n - 1))
            item_variances.append(item_var)

            # Option frequency distribution
            blank_cnt = sum(1 for r in responses if r in {"?", ""})
            multi_cnt = sum(1 for r in responses if r == "*")

            corr_ans_str = (
                ", ".join(key_spec.correct_answer)
                if isinstance(key_spec.correct_answer, list)
                else str(key_spec.correct_answer)
            )

            # Option frequencies
            counts: dict[str, int] = {}
            for r in responses:
                if r not in {"?", "*"}:
                    counts[r] = counts.get(r, 0) + 1

            # Determine choices set
            if key_spec.kind == "mcq":
                all_opts = ["A", "B", "C", "D", "E"]
            elif key_spec.kind == "tf":
                all_opts = ["T", "F"]
            else:
                all_opts = list(counts.keys())[:5]

            distractor_stats: list[DistractorStat] = []
            for opt in all_opts:
                cnt = counts.get(opt, 0)
                is_correct = (
                    opt in key_spec.correct_answer
                    if isinstance(key_spec.correct_answer, list)
                    else opt == str(key_spec.correct_answer)
                )
                distractor_stats.append(
                    DistractorStat(
                        option=opt,
                        count=cnt,
                        percentage=round((cnt / n * 100.0), 1),
                        is_correct=is_correct,
                    )
                )

            item_stats_list.append(
                ItemStats(
                    key=item_key,
                    kind=key_spec.kind,
                    correct_answer=corr_ans_str,
                    points=key_spec.points,
                    facility_index=round(facility_index, 3),
                    discrimination_index=round(discrim_index, 3),
                    point_biserial=round(r_pbis, 3),
                    distractors=distractor_stats,
                    blank_count=blank_cnt,
                    multi_count=multi_cnt,
                )
            )

        # Cronbach's Alpha test reliability
        k = len(self.key.items)
        if k > 1 and variance > 0:
            sum_item_vars = sum(item_variances)
            cronbach_alpha = (k / (k - 1)) * (1.0 - (sum_item_vars / variance))
            cronbach_alpha = max(0.0, min(1.0, cronbach_alpha))
        else:
            cronbach_alpha = 1.0

        return BatchPsychometrics(
            exam_title=self.key.title or "Exam Results",
            num_students=n,
            total_possible_score=total_possible,
            mean_score=mean_score,
            median_score=median_score,
            std_dev=std_dev,
            min_score=min_score,
            max_score=max_score,
            mean_percentage=mean_pct,
            cronbach_alpha=cronbach_alpha,
            items=item_stats_list,
            grades=sorted_by_score,
        )


REPORT_TEMPLATE_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>{{ metrics.exam_title }} — Psychometric Item Analysis Report</title>
  <style>
    :root {
      --bg: #f8fafc;
      --card: #ffffff;
      --text: #0f172a;
      --muted: #64748b;
      --border: #e2e8f0;
      --accent: #2563eb;
      --success: #16a34a;
      --warning: #d97706;
      --danger: #dc2626;
      --correct-bg: #dcfce7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    body { margin: 0; background: var(--bg); color: var(--text); line-height: 1.5; padding: 2rem; }
    .container { max-width: 1200px; margin: 0 auto; }
    header { margin-bottom: 2rem; }
    h1 { margin: 0 0 0.5rem; font-size: 1.85rem; }
    .subtitle { color: var(--muted); font-size: 0.95rem; }
    
    .grid-kpis {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
      gap: 1rem;
      margin-bottom: 2rem;
    }
    .kpi {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    .kpi-title { font-size: 0.8rem; text-transform: uppercase; color: var(--muted); letter-spacing: 0.05em; }
    .kpi-val { font-size: 1.65rem; font-weight: 700; color: var(--text); margin-top: 0.25rem; }
    .kpi-sub { font-size: 0.75rem; color: var(--muted); margin-top: 0.2rem; }

    .card {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 1.5rem;
      margin-bottom: 2rem;
      box-shadow: 0 1px 3px rgba(0,0,0,0.05);
    }
    h2 { font-size: 1.25rem; margin: 0 0 1rem; border-bottom: 1px solid var(--border); padding-bottom: 0.5rem; }

    table { width: 100%; border-collapse: collapse; font-size: 0.88rem; text-align: left; }
    th { background: #f1f5f9; color: var(--muted); font-weight: 600; padding: 0.65rem 0.75rem; border-bottom: 2px solid var(--border); }
    td { padding: 0.65rem 0.75rem; border-bottom: 1px solid var(--border); }
    tr:hover { background: #f8fafc; }

    .badge {
      display: inline-block;
      padding: 0.15rem 0.45rem;
      border-radius: 4px;
      font-size: 0.75rem;
      font-weight: 600;
    }
    .badge-good { background: #dcfce7; color: #15803d; }
    .badge-fair { background: #fef3c7; color: #b45309; }
    .badge-poor { background: #fee2e2; color: #b91c1c; }

    .distractor-bar {
      display: inline-flex;
      align-items: center;
      gap: 0.25rem;
      font-family: monospace;
      font-size: 0.8rem;
      margin-right: 0.5rem;
      padding: 2px 4px;
      border-radius: 3px;
    }
    .distractor-correct {
      background: var(--correct-bg);
      font-weight: 700;
      color: #166534;
      border: 1px solid #86efac;
    }
    .pct-bar {
      display: inline-block;
      height: 6px;
      border-radius: 3px;
      background: #94a3b8;
      vertical-align: middle;
    }
    .pct-bar-correct { background: #22c55e; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>{{ metrics.exam_title }}</h1>
      <div class="subtitle">Cohort Psychometric & Item Analysis Report &bull; Generated from {{ metrics.num_students }} exam scans</div>
    </header>

    <div class="grid-kpis">
      <div class="kpi">
        <div class="kpi-title">Examinees</div>
        <div class="kpi-val">{{ metrics.num_students }}</div>
        <div class="kpi-sub">Total Graded Sheets</div>
      </div>
      <div class="kpi">
        <div class="kpi-title">Mean Score</div>
        <div class="kpi-val">{{ "%.1f"|format(metrics.mean_score) }}</div>
        <div class="kpi-sub">{{ "%.1f"|format(metrics.mean_percentage) }}% (Max: {{ metrics.total_possible_score }})</div>
      </div>
      <div class="kpi">
        <div class="kpi-title">Median Score</div>
        <div class="kpi-val">{{ "%.1f"|format(metrics.median_score) }}</div>
        <div class="kpi-sub">50th Percentile</div>
      </div>
      <div class="kpi">
        <div class="kpi-title">Std Dev (&sigma;)</div>
        <div class="kpi-val">{{ "%.2f"|format(metrics.std_dev) }}</div>
        <div class="kpi-sub">Score Spread</div>
      </div>
      <div class="kpi">
        <div class="kpi-title">Reliability (&alpha;)</div>
        <div class="kpi-val">{{ "%.3f"|format(metrics.cronbach_alpha) }}</div>
        <div class="kpi-sub">Cronbach's Alpha</div>
      </div>
      <div class="kpi">
        <div class="kpi-title">Score Range</div>
        <div class="kpi-val">{{ "%.0f"|format(metrics.min_score) }} &ndash; {{ "%.0f"|format(metrics.max_score) }}</div>
        <div class="kpi-sub">Low / High</div>
      </div>
    </div>

    <div class="card">
      <h2>Item Analysis & Discrimination Metrics</h2>
      <table>
        <thead>
          <tr>
            <th>Item</th>
            <th>Type</th>
            <th>Key</th>
            <th>Facility (P)</th>
            <th>Discrim (D)</th>
            <th>Point-Biserial (r)</th>
            <th>Quality</th>
            <th>Distractor Frequencies (% Chosen)</th>
          </tr>
        </thead>
        <tbody>
          {% for it in metrics.items %}
          <tr>
            <td><strong>#{{ it.key }}</strong></td>
            <td>{{ it.kind|upper }}</td>
            <td><code>{{ it.correct_answer }}</code></td>
            <td>{{ "%.2f"|format(it.facility_index) }} <small>({{ it.difficulty_label }})</small></td>
            <td>
              <span class="badge {% if it.discrimination_index >= 0.30 %}badge-good{% elif it.discrimination_index >= 0.15 %}badge-fair{% else %}badge-poor{% endif %}">
                {{ "%+.2f"|format(it.discrimination_index) }}
              </span>
            </td>
            <td>{{ "%+.2f"|format(it.point_biserial) }}</td>
            <td>{{ it.discrimination_quality }}</td>
            <td>
              {% for d in it.distractors %}
                <span class="distractor-bar {% if d.is_correct %}distractor-correct{% endif %}">
                  {{ d.option }}: {{ d.percentage }}%
                  <span class="pct-bar {% if d.is_correct %}pct-bar-correct{% endif %}" style="width: {{ [d.percentage * 0.4, 40]|min }}px"></span>
                </span>
              {% endfor %}
              {% if it.blank_count > 0 %}<small style="color:var(--muted)">[Blank: {{ it.blank_count }}]</small>{% endif %}
            </td>
          </tr>
          {% endfor %}
        </tbody>
      </table>
    </div>

    <div class="card">
      <h2>Student Roster & Grade Aggregation</h2>
      <table>
        <thead>
          <tr>
            <th>Rank</th>
            <th>Student ID</th>
            <th>Student Name</th>
            <th>Score</th>
            <th>Percentage</th>
            <th>Roster Status</th>
          </tr>
        </thead>
        <tbody>
          {% for g in metrics.grades|reverse %}
          <tr>
            <td>{{ loop.index }}</td>
            <td><code>{{ g.student_id }}</code></td>
            <td><strong>{{ g.student_name }}</strong></td>
            <td>{{ "%.1f"|format(g.score) }} / {{ g.max_score }}</td>
            <td>
              <span class="badge {% if g.percentage >= 80 %}badge-good{% elif g.percentage >= 60 %}badge-fair{% else %}badge-poor{% endif %}">
                {{ "%.1f"|format(g.percentage) }}%
              </span>
            </td>
            <td>
              <span class="badge {% if g.roster_match.matched %}badge-good{% else %}badge-poor{% endif %}">
                {{ g.roster_match.status|upper }}
              </span>
            </td>
          </tr>
          {% endfor %}
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>
"""


class ReportGenerator:
    """Renders psychometrics into clean static HTML reports."""

    def __init__(self):
        self.template = jinja2.Environment(autoescape=True).from_string(REPORT_TEMPLATE_HTML)

    def render(self, metrics: BatchPsychometrics) -> str:
        return self.template.render(metrics=metrics)

    def save(self, metrics: BatchPsychometrics, path: str | Path) -> Path:
        out_path = Path(path)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        html_content = self.render(metrics)
        out_path.write_text(html_content, encoding="utf-8")
        return out_path
