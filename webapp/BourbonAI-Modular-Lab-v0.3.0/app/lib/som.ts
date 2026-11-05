export type SomItem = {
  id: string;
  name: string;
  url: string;
  feature: number[];
  node?: { x: number; y: number };
  distance?: number;
};

export type SomModel = {
  width: number;
  height: number;
  weights: number[][][];
};

const euclidean = (a: number[], b: number[]) =>
  Math.sqrt(a.reduce((sum, value, index) => sum + (value - b[index]) ** 2, 0));

export function extractImageFeature(url: string) {
  return new Promise<number[]>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 64;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return reject(new Error("無法讀取影像特徵"));
      context.drawImage(image, 0, 0, 64, 64);
      const pixels = context.getImageData(0, 0, 64, 64).data;
      const gray = Array(12).fill(0);
      const red = Array(6).fill(0);
      const green = Array(6).fill(0);
      const blue = Array(6).fill(0);
      let edge = 0;
      let previous = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const r = pixels[index] / 255;
        const g = pixels[index + 1] / 255;
        const b = pixels[index + 2] / 255;
        const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
        gray[Math.min(11, Math.floor(luminance * 12))] += 1;
        red[Math.min(5, Math.floor(r * 6))] += 1;
        green[Math.min(5, Math.floor(g * 6))] += 1;
        blue[Math.min(5, Math.floor(b * 6))] += 1;
        if (Math.abs(luminance - previous) > 0.15) edge += 1;
        previous = luminance;
      }
      const divisor = 64 * 64;
      resolve([...gray, ...red, ...green, ...blue, edge].map((value) => value / divisor));
    };
    image.onerror = () => reject(new Error("無法讀取影像特徵"));
    image.src = url;
  });
}

function seeded(seed = 2026) {
  let state = seed;
  return () => ((state = state * 48271 % 2147483647) / 2147483647);
}

export function trainSom(features: number[][], width = 5, height = 4, epochs = 90): SomModel {
  if (!features.length) throw new Error("請先加入影像資料集");
  const random = seeded(features.length * 97);
  const weights = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => {
      const base = features[Math.floor(random() * features.length)];
      return base.map((value) => Math.max(0, value + (random() - 0.5) * 0.04));
    }),
  );
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const learningRate = 0.48 * (1 - epoch / epochs) + 0.03;
    const radius = Math.max(0.6, Math.max(width, height) * 0.52 * (1 - epoch / epochs));
    features.forEach((feature) => {
      const winner = bestNode({ width, height, weights }, feature);
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const gridDistance = Math.sqrt((x - winner.x) ** 2 + (y - winner.y) ** 2);
          const influence = Math.exp(-(gridDistance ** 2) / (2 * radius ** 2));
          weights[y][x] = weights[y][x].map((weight, index) =>
            weight + learningRate * influence * (feature[index] - weight),
          );
        }
      }
    });
  }
  return { width, height, weights };
}

export function bestNode(model: SomModel, feature: number[]) {
  let best = { x: 0, y: 0, distance: Infinity };
  for (let y = 0; y < model.height; y += 1) {
    for (let x = 0; x < model.width; x += 1) {
      const distance = euclidean(feature, model.weights[y][x]);
      if (distance < best.distance) best = { x, y, distance };
    }
  }
  return best;
}

export function mapSomItems(model: SomModel, items: SomItem[]) {
  return items.map((item) => {
    const node = bestNode(model, item.feature);
    return { ...item, node: { x: node.x, y: node.y }, distance: node.distance };
  });
}

export function retrieveSimilar(query: SomItem, candidates: SomItem[], limit = 8) {
  return candidates
    .filter((item) => item.id !== query.id)
    .map((item) => ({ ...item, distance: euclidean(query.feature, item.feature) }))
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    .slice(0, limit);
}
