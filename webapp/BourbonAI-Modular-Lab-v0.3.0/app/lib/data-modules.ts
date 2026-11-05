export type AnalysisMethod = "kmeans" | "dbscan" | "svm" | "tree" | "forest";
export type AnalysisOptions = { clusters: number; epsilon: number; minPoints: number };
export type AnalysisResult = {
  method: AnalysisMethod;
  labels: number[];
  projection: [number, number][];
  explainedVariance: [number, number];
  counts: Record<string, number>;
  score?: number;
  note: string;
};
export type TextDocument = { name: string; text: string };
export type TextVectorization = {
  features: number[][];
  terms: string[];
  keywords: { term: string; score: number }[];
};

const distance = (a: number[], b: number[]) =>
  Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));
const dot = (a: number[], b: number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
const argmax = (values: number[]) => values.reduce((best, value, index) => value > values[best] ? index : best, 0);

export function standardize(rows: number[][]) {
  if (!rows.length) return [];
  const dimensions = rows[0].length;
  const means = Array.from({ length: dimensions }, (_, column) =>
    rows.reduce((sum, row) => sum + row[column], 0) / rows.length,
  );
  const deviations = means.map((mean, column) =>
    Math.sqrt(rows.reduce((sum, row) => sum + (row[column] - mean) ** 2, 0) / Math.max(1, rows.length - 1)) || 1,
  );
  return rows.map((row) => row.map((value, column) => (value - means[column]) / deviations[column]));
}

function powerVector(matrix: number[][], seed: number) {
  let vector = Array.from({ length: matrix.length }, (_, index) => ((index + seed) % 3) + 1);
  for (let iteration = 0; iteration < 70; iteration += 1) {
    const next = matrix.map((row) => dot(row, vector));
    const norm = Math.sqrt(dot(next, next)) || 1;
    vector = next.map((value) => value / norm);
  }
  return vector;
}

export function pca(rows: number[][]) {
  const data = standardize(rows);
  if (!data.length) return { points: [] as [number, number][], variance: [0, 0] as [number, number] };
  const d = data[0].length;
  const covariance = Array.from({ length: d }, (_, i) =>
    Array.from({ length: d }, (_, j) => data.reduce((sum, row) => sum + row[i] * row[j], 0) / Math.max(1, data.length - 1)),
  );
  const first = powerVector(covariance, 1);
  const lambda1 = dot(first, covariance.map((row) => dot(row, first)));
  const deflated = covariance.map((row, i) => row.map((value, j) => value - lambda1 * first[i] * first[j]));
  const second = d > 1 ? powerVector(deflated, 2) : [0];
  const lambda2 = d > 1 ? Math.max(0, dot(second, covariance.map((row) => dot(row, second)))) : 0;
  const total = covariance.reduce((sum, row, index) => sum + row[index], 0) || 1;
  return {
    points: data.map((row) => [dot(row, first), d > 1 ? dot(row, second) : 0] as [number, number]),
    variance: [100 * lambda1 / total, 100 * lambda2 / total] as [number, number],
  };
}

export function kmeans(rows: number[][], requestedClusters = 3) {
  const data = standardize(rows);
  const k = Math.max(2, Math.min(requestedClusters, data.length));
  let centers = Array.from({ length: k }, (_, index) => [...data[Math.floor(index * data.length / k)]]);
  let labels = Array(data.length).fill(0);
  for (let iteration = 0; iteration < 50; iteration += 1) {
    const next = data.map((row) => argmax(centers.map((center) => -distance(row, center))));
    if (next.every((label, index) => label === labels[index]) && iteration) break;
    labels = next;
    centers = centers.map((center, cluster) => {
      const members = data.filter((_, index) => labels[index] === cluster);
      return members.length
        ? center.map((_, column) => members.reduce((sum, row) => sum + row[column], 0) / members.length)
        : center;
    });
  }
  return labels;
}

export function dbscan(rows: number[][], epsilon = 0.9, minPoints = 4) {
  const data = standardize(rows);
  const labels = Array(data.length).fill(-2);
  const neighbors = (index: number) => data.map((row, other) => distance(row, data[index]) <= epsilon ? other : -1).filter((value) => value >= 0);
  let cluster = 0;
  for (let point = 0; point < data.length; point += 1) {
    if (labels[point] !== -2) continue;
    const near = neighbors(point);
    if (near.length < minPoints) { labels[point] = -1; continue; }
    labels[point] = cluster;
    const queue = [...near];
    while (queue.length) {
      const candidate = queue.shift()!;
      if (labels[candidate] === -1) labels[candidate] = cluster;
      if (labels[candidate] !== -2) continue;
      labels[candidate] = cluster;
      const expanded = neighbors(candidate);
      if (expanded.length >= minPoints) expanded.forEach((value) => { if (!queue.includes(value)) queue.push(value); });
    }
    cluster += 1;
  }
  return labels;
}

function trainPerceptron(rows: number[][], targets: number[], classes: number) {
  const weights = Array.from({ length: classes }, () => Array(rows[0].length + 1).fill(0));
  for (let epoch = 0; epoch < 45; epoch += 1) {
    rows.forEach((row, index) => {
      const prediction = argmax(weights.map((weight) => dot(weight.slice(0, -1), row) + weight.at(-1)!));
      if (prediction === targets[index]) return;
      row.forEach((value, column) => {
        weights[targets[index]][column] += 0.025 * value;
        weights[prediction][column] -= 0.025 * value;
      });
      weights[targets[index]][row.length] += 0.025;
      weights[prediction][row.length] -= 0.025;
    });
  }
  return rows.map((row) => argmax(weights.map((weight) => dot(weight.slice(0, -1), row) + weight.at(-1)!)));
}

function bestStump(rows: number[][], targets: number[], columns?: number[]) {
  const candidates = columns ?? rows[0].map((_, index) => index);
  let best = { column: candidates[0] ?? 0, threshold: 0, left: 0, right: 0, error: Infinity };
  candidates.forEach((column) => {
    const sorted = rows.map((row, index) => ({ value: row[column], target: targets[index] })).sort((a, b) => a.value - b.value);
    for (let split = 1; split < sorted.length; split += Math.max(1, Math.floor(sorted.length / 12))) {
      const threshold = (sorted[split - 1].value + sorted[split].value) / 2;
      const majority = (items: typeof sorted) => {
        const counts: Record<number, number> = {};
        items.forEach((item) => { counts[item.target] = (counts[item.target] ?? 0) + 1; });
        return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 0);
      };
      const left = majority(sorted.filter((item) => item.value <= threshold));
      const right = majority(sorted.filter((item) => item.value > threshold));
      const error = sorted.filter((item) => (item.value <= threshold ? left : right) !== item.target).length;
      if (error < best.error) best = { column, threshold, left, right, error };
    }
  });
  return best;
}

function treePredict(rows: number[][], targets: number[]) {
  const stump = bestStump(rows, targets);
  return rows.map((row) => row[stump.column] <= stump.threshold ? stump.left : stump.right);
}

function forestPredict(rows: number[][], targets: number[]) {
  let state = 1776;
  const random = () => ((state = (state * 48271) % 2147483647) / 2147483647);
  const trees = Array.from({ length: 21 }, () => {
    const columns = rows[0].map((_, index) => index).filter(() => random() > 0.45);
    return bestStump(rows, targets, columns.length ? columns : [Math.floor(random() * rows[0].length)]);
  });
  return rows.map((row) => {
    const votes = trees.map((tree) => row[tree.column] <= tree.threshold ? tree.left : tree.right);
    const counts: Record<number, number> = {};
    votes.forEach((value) => { counts[value] = (counts[value] ?? 0) + 1; });
    return Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
  });
}

export function analyze(rows: number[][], method: AnalysisMethod, options: AnalysisOptions): AnalysisResult {
  if (rows.length < 2 || rows[0].length < 2) throw new Error("至少需要兩筆資料與兩個數值欄位");
  const data = standardize(rows);
  const projection = pca(rows);
  let labels: number[];
  let score: number | undefined;
  let note = "";
  if (method === "kmeans") {
    labels = kmeans(data, options.clusters);
    note = "K-Means 以歐氏距離反覆更新群中心。";
  } else if (method === "dbscan") {
    labels = dbscan(data, options.epsilon, options.minPoints);
    note = "DBSCAN 的 -1 類別代表密度不足的離群點。";
  } else {
    const targets = kmeans(data, options.clusters);
    labels = method === "svm"
      ? trainPerceptron(data, targets, Math.max(...targets) + 1)
      : method === "tree" ? treePredict(data, targets) : forestPredict(data, targets);
    score = 100 * labels.filter((label, index) => label === targets[index]).length / labels.length;
    note = "未指定人工標籤，因此以 K-Means 暫定群組進行分類器流程驗證。";
  }
  const counts: Record<string, number> = {};
  labels.forEach((label) => { counts[String(label)] = (counts[String(label)] ?? 0) + 1; });
  return { method, labels, projection: projection.points, explainedVariance: projection.variance, counts, score, note };
}

const englishTokens = (text: string) => text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? [];
const chineseTokens = (text: string) => {
  const chunks = text.match(/[\u3400-\u9fff]+/g) ?? [];
  const tokens: string[] = [];
  chunks.forEach((chunk) => {
    if (chunk.length === 1) tokens.push(chunk);
    for (let index = 0; index < chunk.length - 1; index += 1) tokens.push(chunk.slice(index, index + 2));
  });
  return tokens;
};

export function vectorizeText(documents: TextDocument[], language: "en" | "zh", stopWords: Set<string>): TextVectorization {
  const tokenLists = documents.map((document) => (language === "en" ? englishTokens(document.text) : chineseTokens(document.text)).filter((token) => !stopWords.has(token)));
  const frequencies: Record<string, number> = {};
  tokenLists.forEach((tokens) => new Set(tokens).forEach((token) => { frequencies[token] = (frequencies[token] ?? 0) + 1; }));
  const terms = Object.entries(frequencies).sort((a, b) => b[1] - a[1]).slice(0, 80).map(([term]) => term);
  const features = tokenLists.map((tokens) => {
    const counts: Record<string, number> = {};
    tokens.forEach((token) => { counts[token] = (counts[token] ?? 0) + 1; });
    return terms.map((term) => (counts[term] ?? 0) / Math.max(tokens.length, 1) * Math.log((documents.length + 1) / ((frequencies[term] ?? 0) + 1)));
  });
  const keywords = terms.map((term, index) => ({ term, score: features.reduce((sum, row) => sum + row[index], 0) })).sort((a, b) => b.score - a.score).slice(0, 16);
  return { features, terms, keywords };
}

export function precisionSearch(documents: TextDocument[], wordA: string, wordB: string, windowSize: number) {
  const results: { file: string; excerpt: string }[] = [];
  documents.forEach((document) => {
    const lower = document.text.toLowerCase();
    let position = lower.indexOf(wordA.toLowerCase());
    while (position >= 0) {
      const start = Math.max(0, position - windowSize);
      const end = Math.min(document.text.length, position + wordA.length + windowSize);
      const excerpt = document.text.slice(start, end).replace(/\s+/g, " ");
      if (!wordB || excerpt.toLowerCase().includes(wordB.toLowerCase())) results.push({ file: document.name, excerpt });
      position = lower.indexOf(wordA.toLowerCase(), position + wordA.length);
    }
  });
  return results;
}
