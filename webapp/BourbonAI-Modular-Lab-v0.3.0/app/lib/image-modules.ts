export type ImageModuleId =
  | "average"
  | "gaussian"
  | "median"
  | "bilateral"
  | "laplacian"
  | "sobel"
  | "canny"
  | "threshold"
  | "threshold-inv";

export type ModuleParameter = {
  key: string;
  zh: string;
  en: string;
  min: number;
  max: number;
  step: number;
  value: number;
  odd?: boolean;
};

export type ImageModuleDefinition = {
  id: ImageModuleId;
  zh: string;
  en: string;
  category: "模糊降噪" | "邊緣偵測" | "二值化";
  description: string;
  parameters: ModuleParameter[];
  apply: (input: ImageData, params: Record<string, number>) => ImageData;
};

export type PipelineStep = {
  uid: string;
  moduleId: ImageModuleId;
  enabled: boolean;
  params: Record<string, number>;
};

export type DetectedObject = {
  id: number;
  areaPixels: number;
  perimeterPixels: number;
  circularity: number;
  diameterPixels: number;
  meanGray: number;
  grayStdDev: number;
  edgeSmoothness: number;
  centerX: number;
  centerY: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  isCircularCell: boolean;
  isGlassBead: boolean;
  manuallySelectedBead: boolean;
  realArea?: number;
};

export type AnalysisPoint = {
  x: number;
  y: number;
};

export type CellAnalysisOptions = {
  circularityThreshold: number;
  glassBeadEnabled: boolean;
  glassBeadDiameter: number;
  glassBeadCircularityThreshold?: number;
  manualGlassBeadPoints?: AnalysisPoint[];
  excludedMask?: Uint8Array;
};

export type ImageStats = {
  imageWidth: number;
  imageHeight: number;
  pixels: number;
  insidePixels: number;
  outsidePixels: number;
  excludedPixels: number;
  beadExcludedPixels: number;
  analyzedPixels: number;
  insideOutsideRatio: number;
  insidePercent: number;
  averageGray: number;
  circularity: number;
  histogram: number[];
  threshold: number;
  objectCount: number;
  circularCellCount: number;
  beadCount: number;
  beadDiameterPixels?: number;
  realUnitsPerPixel?: number;
  objects: DetectedObject[];
  overlay: ImageData;
};

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const odd = (n: number, min = 1, max = 15) => {
  let value = Math.max(min, Math.min(max, Math.round(n)));
  if (value % 2 === 0) value += value === max ? -1 : 1;
  return value;
};
const grayAt = (data: Uint8ClampedArray, pixel: number) => {
  const i = pixel * 4;
  return data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
};

function grayscale(input: ImageData) {
  const out = new Uint8ClampedArray(input.data.length);
  for (let p = 0; p < input.width * input.height; p += 1) {
    const g = clamp(grayAt(input.data, p));
    out.set([g, g, g, 255], p * 4);
  }
  return new ImageData(out, input.width, input.height);
}

function convolve(input: ImageData, kernel: number[], size: number, divisor = 1, bias = 0) {
  const source = grayscale(input);
  const out = new Uint8ClampedArray(source.data.length);
  const r = Math.floor(size / 2);
  const { width: w, height: h } = source;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let total = 0;
      for (let ky = -r; ky <= r; ky += 1) {
        for (let kx = -r; kx <= r; kx += 1) {
          const py = Math.max(0, Math.min(h - 1, y + ky));
          const px = Math.max(0, Math.min(w - 1, x + kx));
          total += source.data[(py * w + px) * 4] * kernel[(ky + r) * size + kx + r];
        }
      }
      const value = clamp(total / divisor + bias);
      out.set([value, value, value, 255], (y * w + x) * 4);
    }
  }
  return new ImageData(out, w, h);
}

function average(input: ImageData, params: Record<string, number>) {
  const size = odd(params.kernel ?? 5, 3, 15);
  return convolve(input, Array(size * size).fill(1), size, size * size);
}

function gaussian(input: ImageData, params: Record<string, number>) {
  const size = odd(params.kernel ?? 5, 3, 15);
  const sigma = Math.max(0.1, params.sigma ?? 1.5);
  const r = Math.floor(size / 2);
  const kernel: number[] = [];
  let sum = 0;
  for (let y = -r; y <= r; y += 1) {
    for (let x = -r; x <= r; x += 1) {
      const weight = Math.exp(-(x * x + y * y) / (2 * sigma * sigma));
      kernel.push(weight);
      sum += weight;
    }
  }
  return convolve(input, kernel, size, sum);
}

function median(input: ImageData, params: Record<string, number>) {
  const size = odd(params.kernel ?? 3, 3, 7);
  const source = grayscale(input);
  const out = new Uint8ClampedArray(source.data.length);
  const r = Math.floor(size / 2);
  const { width: w, height: h } = source;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const values: number[] = [];
      for (let ky = -r; ky <= r; ky += 1) {
        for (let kx = -r; kx <= r; kx += 1) {
          const py = Math.max(0, Math.min(h - 1, y + ky));
          const px = Math.max(0, Math.min(w - 1, x + kx));
          values.push(source.data[(py * w + px) * 4]);
        }
      }
      values.sort((a, b) => a - b);
      const value = values[Math.floor(values.length / 2)];
      out.set([value, value, value, 255], (y * w + x) * 4);
    }
  }
  return new ImageData(out, w, h);
}

function bilateral(input: ImageData, params: Record<string, number>) {
  const source = grayscale(input);
  const out = new Uint8ClampedArray(source.data.length);
  const colorSigma = Math.max(1, params.sigmaColor ?? 60);
  const spaceSigma = Math.max(1, params.sigmaSpace ?? 3);
  const r = Math.min(3, Math.round(spaceSigma));
  const { width: w, height: h } = source;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const center = source.data[(y * w + x) * 4];
      let weighted = 0;
      let weights = 0;
      for (let ky = -r; ky <= r; ky += 1) {
        for (let kx = -r; kx <= r; kx += 1) {
          const py = Math.max(0, Math.min(h - 1, y + ky));
          const px = Math.max(0, Math.min(w - 1, x + kx));
          const value = source.data[(py * w + px) * 4];
          const sw = Math.exp(-(kx * kx + ky * ky) / (2 * spaceSigma ** 2));
          const cw = Math.exp(-((value - center) ** 2) / (2 * colorSigma ** 2));
          weighted += value * sw * cw;
          weights += sw * cw;
        }
      }
      const value = clamp(weighted / Math.max(weights, 0.0001));
      out.set([value, value, value, 255], (y * w + x) * 4);
    }
  }
  return new ImageData(out, w, h);
}

function sobelValues(input: ImageData) {
  const source = grayscale(input);
  const { width: w, height: h } = source;
  const values = new Float32Array(w * h);
  const gx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
  const gy = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      let sx = 0;
      let sy = 0;
      for (let ky = -1; ky <= 1; ky += 1) {
        for (let kx = -1; kx <= 1; kx += 1) {
          const value = source.data[((y + ky) * w + x + kx) * 4];
          const k = (ky + 1) * 3 + kx + 1;
          sx += value * gx[k];
          sy += value * gy[k];
        }
      }
      values[y * w + x] = Math.sqrt(sx * sx + sy * sy);
    }
  }
  return values;
}

function valuesToImage(values: Float32Array, w: number, h: number) {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0; p < values.length; p += 1) {
    const value = clamp(values[p]);
    out.set([value, value, value, 255], p * 4);
  }
  return new ImageData(out, w, h);
}

function sobel(input: ImageData) {
  return valuesToImage(sobelValues(input), input.width, input.height);
}

function canny(input: ImageData, params: Record<string, number>) {
  const values = sobelValues(gaussian(input, { kernel: 3, sigma: 1 }));
  const low = params.low ?? 50;
  const high = Math.max(low, params.high ?? 150);
  const { width: w, height: h } = input;
  const state = new Uint8Array(w * h);
  for (let p = 0; p < values.length; p += 1) state[p] = values[p] >= high ? 2 : values[p] >= low ? 1 : 0;
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      const p = y * w + x;
      if (state[p] !== 1) continue;
      let strong = false;
      for (let ky = -1; ky <= 1; ky += 1) for (let kx = -1; kx <= 1; kx += 1) strong ||= state[(y + ky) * w + x + kx] === 2;
      state[p] = strong ? 2 : 0;
    }
  }
  return valuesToImage(Float32Array.from(state, (value) => (value === 2 ? 255 : 0)), w, h);
}

function binary(input: ImageData, params: Record<string, number>, inverse = false) {
  const source = grayscale(input);
  const out = new Uint8ClampedArray(source.data.length);
  const limit = params.threshold ?? 128;
  for (let p = 0; p < input.width * input.height; p += 1) {
    let value = source.data[p * 4] > limit ? 255 : 0;
    if (inverse) value = 255 - value;
    out.set([value, value, value, 255], p * 4);
  }
  return new ImageData(out, input.width, input.height);
}

const kernel: ModuleParameter = { key: "kernel", zh: "核心大小", en: "Kernel size", min: 3, max: 15, step: 2, value: 5, odd: true };
const thresholdParam: ModuleParameter = { key: "threshold", zh: "灰階閾值", en: "Threshold", min: 0, max: 255, step: 1, value: 128 };

export const IMAGE_MODULES: ImageModuleDefinition[] = [
  { id: "average", zh: "均值模糊", en: "Average Blur", category: "模糊降噪", description: "平均鄰域像素以快速降低雜訊。", parameters: [kernel], apply: average },
  { id: "gaussian", zh: "高斯模糊", en: "Gaussian Blur", category: "模糊降噪", description: "以高斯權重平滑影像並保留較多邊緣。", parameters: [kernel, { key: "sigma", zh: "標準差", en: "Sigma X", min: 0.5, max: 8, step: 0.1, value: 1.5 }], apply: gaussian },
  { id: "median", zh: "中值模糊", en: "Median Blur", category: "模糊降噪", description: "取鄰域中值，適合去除椒鹽雜訊。", parameters: [{ ...kernel, max: 7, value: 3 }], apply: median },
  { id: "bilateral", zh: "雙邊濾波", en: "Bilateral Filter", category: "模糊降噪", description: "平滑影像同時保留邊緣與細節。", parameters: [{ key: "sigmaColor", zh: "色彩標準差", en: "Sigma color", min: 1, max: 200, step: 1, value: 60 }, { key: "sigmaSpace", zh: "空間標準差", en: "Sigma space", min: 1, max: 8, step: 1, value: 3 }], apply: bilateral },
  { id: "laplacian", zh: "拉普拉斯算子", en: "Laplacian", category: "邊緣偵測", description: "使用二階微分強調灰階急遽變化。", parameters: [{ key: "scale", zh: "縮放常數", en: "Scale", min: 1, max: 9, step: 2, value: 1, odd: true }], apply: (input, p) => convolve(input, [0, 1, 0, 1, -4, 1, 0, 1, 0].map((n) => n * (p.scale ?? 1)), 3, 1, 128) },
  { id: "sobel", zh: "索伯運算", en: "Sobel", category: "邊緣偵測", description: "計算水平與垂直的一階梯度。", parameters: [], apply: sobel },
  { id: "canny", zh: "Canny 邊緣偵測", en: "Canny", category: "邊緣偵測", description: "雙閾值連結連續且清晰的輪廓。", parameters: [{ key: "low", zh: "低閾值", en: "Low threshold", min: 0, max: 255, step: 1, value: 50 }, { key: "high", zh: "高閾值", en: "High threshold", min: 0, max: 255, step: 1, value: 150 }], apply: canny },
  { id: "threshold", zh: "二值化", en: "Threshold", category: "二值化", description: "依指定閾值轉換為黑白影像。", parameters: [thresholdParam], apply: (input, p) => binary(input, p) },
  { id: "threshold-inv", zh: "反相二值化", en: "Threshold INV", category: "二值化", description: "以反相規則輸出黑白影像。", parameters: [thresholdParam], apply: (input, p) => binary(input, p, true) },
];

export const IMAGE_MODULE_MAP = Object.fromEntries(IMAGE_MODULES.map((item) => [item.id, item])) as Record<ImageModuleId, ImageModuleDefinition>;
let uid = 0;
export function createStep(moduleId: ImageModuleId): PipelineStep {
  uid += 1;
  const item = IMAGE_MODULE_MAP[moduleId];
  return { uid: `${moduleId}-${uid}-${Date.now()}`, moduleId, enabled: true, params: Object.fromEntries(item.parameters.map((p) => [p.key, p.value])) };
}
export function runPipeline(input: ImageData, steps: PipelineStep[]) {
  return steps.reduce((image, step) => step.enabled ? IMAGE_MODULE_MAP[step.moduleId].apply(image, step.params) : image, input);
}

function otsuThreshold(histogram: number[], total: number) {
  let weightedTotal = 0;
  for (let value = 0; value < 256; value += 1) weightedTotal += value * histogram[value];
  let backgroundWeight = 0;
  let backgroundSum = 0;
  let bestVariance = -1;
  let best = 128;
  for (let value = 0; value < 256; value += 1) {
    backgroundWeight += histogram[value];
    if (!backgroundWeight) continue;
    const foregroundWeight = total - backgroundWeight;
    if (!foregroundWeight) break;
    backgroundSum += value * histogram[value];
    const backgroundMean = backgroundSum / backgroundWeight;
    const foregroundMean = (weightedTotal - backgroundSum) / foregroundWeight;
    const variance = backgroundWeight * foregroundWeight * (backgroundMean - foregroundMean) ** 2;
    if (variance > bestVariance) {
      bestVariance = variance;
      best = value;
    }
  }
  return best;
}

function majorityFilter(mask: Uint8Array, width: number, height: number) {
  const output = new Uint8Array(mask.length);
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let neighbors = 0;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) neighbors += mask[(y + dy) * width + x + dx];
      }
      output[y * width + x] = neighbors >= 5 ? 1 : 0;
    }
  }
  return output;
}

export function analyzeCellImage(input: ImageData, options: CellAnalysisOptions): ImageStats {
  const { width, height } = input;
  const total = width * height;
  const excludedMask = options.excludedMask?.length === total ? options.excludedMask : undefined;
  const excludedPixels = excludedMask
    ? excludedMask.reduce((sum, value) => sum + Number(Boolean(value)), 0)
    : 0;
  const gray = new Uint8Array(total);
  const sourceHistogram = Array(256).fill(0);
  let borderSum = 0;
  let borderCount = 0;
  let eligiblePixelCount = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    const value = clamp(grayAt(input.data, pixel));
    gray[pixel] = value;
    if (excludedMask?.[pixel]) continue;
    sourceHistogram[value] += 1;
    eligiblePixelCount += 1;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (x < 2 || y < 2 || x >= width - 2 || y >= height - 2) {
      borderSum += value;
      borderCount += 1;
    }
  }

  const threshold = otsuThreshold(sourceHistogram, eligiblePixelCount);
  const brightForeground = borderSum / Math.max(1, borderCount) <= threshold;
  let mask = Uint8Array.from(gray, (value, pixel) => {
    if (excludedMask?.[pixel]) return 0;
    return brightForeground ? Number(value > threshold) : Number(value <= threshold);
  });
  mask = majorityFilter(mask, width, height);
  mask = majorityFilter(mask, width, height);

  const visited = new Uint8Array(total);
  const queue = new Int32Array(total);
  const retainedMask = new Uint8Array(total);
  const objectLabels = new Int32Array(total);
  const objects: DetectedObject[] = [];
  const minArea = Math.max(16, Math.round(total * 0.00004));
  const maxArea = Math.round(total * 0.7);
  const directions = [-1, 0, 1];

  for (let seed = 0; seed < total; seed += 1) {
    if (!mask[seed] || visited[seed]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;
    const component: number[] = [];
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    let sumGray = 0;
    let sumGraySquared = 0;
    let perimeter = 0;

    while (head < tail) {
      const pixel = queue[head++];
      component.push(pixel);
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      sumX += x;
      sumY += y;
      sumGray += gray[pixel];
      sumGraySquared += gray[pixel] ** 2;
      if (x === 0 || !mask[pixel - 1]) perimeter += 1;
      if (x === width - 1 || !mask[pixel + 1]) perimeter += 1;
      if (y === 0 || !mask[pixel - width]) perimeter += 1;
      if (y === height - 1 || !mask[pixel + width]) perimeter += 1;

      for (const dy of directions) {
        for (const dx of directions) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const next = ny * width + nx;
          if (mask[next] && !visited[next]) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }

    const areaPixels = component.length;
    if (areaPixels < minArea || areaPixels > maxArea) continue;
    const objectId = objects.length + 1;
    component.forEach((pixel) => {
      retainedMask[pixel] = 1;
      objectLabels[pixel] = objectId;
    });
    const meanGray = sumGray / areaPixels;
    const grayStdDev = Math.sqrt(Math.max(0, sumGraySquared / areaPixels - meanGray ** 2));
    const circularity = Math.min(100, 4 * Math.PI * areaPixels * 100 / Math.max(1, perimeter ** 2));
    const boxWidth = maxX - minX + 1;
    const boxHeight = maxY - minY + 1;
    const aspect = Math.min(boxWidth, boxHeight) / Math.max(boxWidth, boxHeight);
    const edgeSmoothness = Math.min(100, (circularity + aspect * 100) / 2);
    const isCircularCell = circularity >= options.circularityThreshold;
    const manuallySelectedBead = Boolean(options.glassBeadEnabled)
      && circularity >= 50
      && Boolean(options.manualGlassBeadPoints?.some((point) => {
        const insideBounds = point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY;
        if (insideBounds) return true;
        const distance = Math.hypot(point.x - sumX / areaPixels, point.y - sumY / areaPixels);
        return distance <= Math.max(8, Math.sqrt(areaPixels / Math.PI) * 1.35);
      }));
    const beadCircularityThreshold = Math.max(50, Math.min(100, options.glassBeadCircularityThreshold ?? 96));
    const isGlassBead = options.glassBeadEnabled
      && (manuallySelectedBead || (
        circularity >= beadCircularityThreshold
        && edgeSmoothness >= beadCircularityThreshold
        && grayStdDev <= 10
      ));
    objects.push({
      id: objectId,
      areaPixels,
      perimeterPixels: perimeter,
      circularity,
      diameterPixels: 2 * Math.sqrt(areaPixels / Math.PI),
      meanGray,
      grayStdDev,
      edgeSmoothness,
      centerX: sumX / areaPixels,
      centerY: sumY / areaPixels,
      minX,
      maxX,
      minY,
      maxY,
      isCircularCell,
      isGlassBead,
      manuallySelectedBead,
    });
  }

  const beads = objects.filter((object) => object.isGlassBead);
  const beadExcludedPixels = beads.reduce((sum, object) => sum + object.areaPixels, 0);
  const beadDiameterPixels = beads.length
    ? beads.reduce((sum, object) => sum + object.diameterPixels, 0) / beads.length
    : undefined;
  const realUnitsPerPixel = beadDiameterPixels && options.glassBeadDiameter > 0
    ? options.glassBeadDiameter / beadDiameterPixels
    : undefined;
  if (realUnitsPerPixel) {
    objects.forEach((object) => {
      if (object.isCircularCell && !object.isGlassBead) object.realArea = object.areaPixels * realUnitsPerPixel ** 2;
    });
  }

  const histogram = Array(256).fill(0);
  let insidePixels = 0;
  let sum = 0;
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (!retainedMask[pixel]) continue;
    const objectId = objectLabels[pixel];
    if (objectId && objects[objectId - 1]?.isGlassBead) continue;
    histogram[gray[pixel]] += 1;
    insidePixels += 1;
    sum += gray[pixel];
  }
  const analyzedPixels = Math.max(0, total - excludedPixels - beadExcludedPixels);
  const outsidePixels = Math.max(0, analyzedPixels - insidePixels);
  const overlayData = new Uint8ClampedArray(input.data);
  for (let pixel = 0; pixel < total; pixel += 1) {
    if (excludedMask?.[pixel]) continue;
    const objectId = objectLabels[pixel];
    if (!objectId) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    const boundary = x === 0 || y === 0 || x === width - 1 || y === height - 1
      || objectLabels[pixel - 1] !== objectId || objectLabels[pixel + 1] !== objectId
      || objectLabels[pixel - width] !== objectId || objectLabels[pixel + width] !== objectId;
    if (!boundary) continue;
    const object = objects[objectId - 1];
    const color = object.isGlassBead ? [0, 0, 0] : object.isCircularCell ? [116, 240, 167] : [54, 215, 232];
    overlayData[pixel * 4] = color[0];
    overlayData[pixel * 4 + 1] = color[1];
    overlayData[pixel * 4 + 2] = color[2];
    overlayData[pixel * 4 + 3] = 255;
  }
  const circularObjects = objects.filter((object) => object.isCircularCell && !object.isGlassBead);
  return {
    imageWidth: width,
    imageHeight: height,
    pixels: insidePixels,
    insidePixels,
    outsidePixels,
    excludedPixels,
    beadExcludedPixels,
    analyzedPixels,
    insideOutsideRatio: outsidePixels ? insidePixels / outsidePixels : insidePixels ? Infinity : 0,
    insidePercent: analyzedPixels ? insidePixels * 100 / analyzedPixels : 0,
    averageGray: insidePixels ? sum / insidePixels : 0,
    circularity: objects.length ? objects.reduce((sumCircularity, object) => sumCircularity + object.circularity, 0) / objects.length : 0,
    histogram,
    threshold,
    objectCount: objects.length,
    circularCellCount: circularObjects.length,
    beadCount: beads.length,
    beadDiameterPixels,
    realUnitsPerPixel,
    objects,
    overlay: new ImageData(overlayData, width, height),
  };
}

export function imageStats(input: ImageData): ImageStats {
  return analyzeCellImage(input, { circularityThreshold: 75, glassBeadEnabled: false, glassBeadDiameter: 0 });
}
