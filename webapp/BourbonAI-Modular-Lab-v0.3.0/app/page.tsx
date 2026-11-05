"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import {
  IMAGE_MODULE_MAP,
  IMAGE_MODULES,
  analyzeCellImage,
  createStep,
  runPipeline,
  type AnalysisPoint,
  type ImageModuleId,
  type ImageStats,
  type PipelineStep,
} from "./lib/image-modules";
import {
  parsePipelineTemplate,
  pipelineTemplateBlob,
  pipelineTemplateFilename,
  type PipelineTemplateData,
} from "./lib/pipeline-template";
import DataWorkspace from "./components/DataWorkspace";
import ModuleRegistry from "./components/ModuleRegistry";
import SomWorkspace from "./components/SomWorkspace";

type Tab = "image" | "data" | "som" | "modules";
type Asset = { id: string; name: string; url: string; demo?: boolean };
type NormalizedPoint = { x: number; y: number };
type InteractionMode = "bead" | "exclude" | null;
type ProcessingOverrides = {
  glassBeadEnabled?: boolean;
  glassBeadCircularityThreshold?: number;
  manualBeadPoints?: NormalizedPoint[];
  exclusionRegions?: NormalizedPoint[][];
};

const tabs: { id: Tab; zh: string; en: string }[] = [
  { id: "image", zh: "影像管線", en: "Image Pipeline" },
  { id: "data", zh: "資料分析", en: "Data Analysis" },
  { id: "som", zh: "SOM 檢索", en: "Image Retrieval" },
  { id: "modules", zh: "模組庫", en: "Module Registry" },
];
const initialPipeline = [createStep("gaussian"), createStep("canny"), createStep("threshold")];
const demo: Asset = { id: "demo", name: "demo_fluorescence_cells.png", url: "/demo-cells.png", demo: true };

async function toImageData(url: string, max = 1400, filename = "") {
  if (/\.tiff?$/i.test(filename)) {
    const UTIF = await import("utif");
    const buffer = await fetch(url).then((response) => response.arrayBuffer());
    const pages = UTIF.decode(buffer);
    if (!pages.length) throw new Error("TIFF 檔案沒有可讀取的影像頁面");
    UTIF.decodeImage(buffer, pages[0]);
    const rgba = UTIF.toRGBA8(pages[0]);
    const source = new ImageData(new Uint8ClampedArray(rgba), pages[0].width, pages[0].height);
    const scale = Math.min(1, max / Math.max(source.width, source.height));
    if (scale === 1) return source;
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = source.width;
    sourceCanvas.height = source.height;
    sourceCanvas.getContext("2d")?.putImageData(source, 0, 0);
    const outputCanvas = document.createElement("canvas");
    outputCanvas.width = Math.round(source.width * scale);
    outputCanvas.height = Math.round(source.height * scale);
    const context = outputCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("無法啟用 Canvas 影像運算");
    context.drawImage(sourceCanvas, 0, 0, outputCanvas.width, outputCanvas.height);
    return context.getImageData(0, 0, outputCanvas.width, outputCanvas.height);
  }
  return new Promise<ImageData>((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, max / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(image.naturalWidth * scale);
      canvas.height = Math.round(image.naturalHeight * scale);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return reject(new Error("無法啟用 Canvas 影像運算"));
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(context.getImageData(0, 0, canvas.width, canvas.height));
    };
    image.onerror = () => reject(new Error("無法讀取影像"));
    image.src = url;
  });
}

function dataUrl(image: ImageData) {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("無法啟用 Canvas 影像運算");
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

function download(url: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
}

function createExclusionMask(width: number, height: number, polygons: NormalizedPoint[][]) {
  if (!polygons.length) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return undefined;
  context.fillStyle = "#fff";
  polygons.forEach((polygon) => {
    if (polygon.length < 3) return;
    context.beginPath();
    context.moveTo(polygon[0].x * width, polygon[0].y * height);
    polygon.slice(1).forEach((point) => context.lineTo(point.x * width, point.y * height));
    context.closePath();
    context.fill();
  });
  const alpha = context.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) mask[pixel] = alpha[pixel * 4 + 3] ? 1 : 0;
  return mask;
}

function restoreExcludedPixels(output: ImageData, source: ImageData, mask?: Uint8Array) {
  if (!mask) return output;
  const data = new Uint8ClampedArray(output.data);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const offset = pixel * 4;
    data[offset] = source.data[offset];
    data[offset + 1] = source.data[offset + 1];
    data[offset + 2] = source.data[offset + 2];
    data[offset + 3] = source.data[offset + 3];
  }
  return new ImageData(data, output.width, output.height);
}

function Histogram({ values, kind }: { values: number[]; kind: "bar" | "curve" }) {
  const bars = useMemo(() => {
    const grouped = Array.from({ length: 48 }, (_, index) =>
      values.slice(Math.floor(index * 256 / 48), Math.floor((index + 1) * 256 / 48)).reduce((a, b) => a + b, 0),
    );
    const peak = Math.max(...grouped, 1);
    return grouped.map((value) => 100 * value / peak);
  }, [values]);
  if (kind === "curve") {
    const points = bars.map((height, index) => `${index * 100 / Math.max(1, bars.length - 1)},${100 - height}`).join(" ");
    return <svg className="histogram curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="邊緣內側像素灰階分布曲線"><polyline points={points} /></svg>;
  }
  return <div className="histogram" aria-label="邊緣內側像素灰階分布長條圖">{bars.map((height, index) => <i key={index} style={{ height: `${Math.max(2, height)}%` }} />)}</div>;
}

function Header({ tab, setTab }: { tab: Tab; setTab: (tab: Tab) => void }) {
  return (
    <header className="site-header">
      <button className="brand" onClick={() => setTab("image")}>
        <span className="brand-mark"><i /><i /><i /></span>
        <span><strong>BourbonAI Modular Lab</strong><small>生醫影像與跨領域資料分析</small></span>
      </button>
      <nav>
        {tabs.map((item) => (
          <button key={item.id} className={tab === item.id ? "active" : ""} onClick={() => setTab(item.id)}>
            <span>{item.zh}</span><small>{item.en}</small>
          </button>
        ))}
      </nav>
      <span className="ready"><i /> Browser compute</span>
    </header>
  );
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("image");
  const [assets, setAssets] = useState<Asset[]>([demo]);
  const [activeId, setActiveId] = useState("demo");
  const [pipeline, setPipeline] = useState<PipelineStep[]>(initialPipeline);
  const [selectedUid, setSelectedUid] = useState(initialPipeline[1].uid);
  const [results, setResults] = useState<Record<string, string>>({});
  const [analysisOverlays, setAnalysisOverlays] = useState<Record<string, string>>({});
  const [stats, setStats] = useState<Record<string, ImageStats>>({});
  const [showResult, setShowResult] = useState(false);
  const [showAnalysis, setShowAnalysis] = useState(true);
  const [histogramKind, setHistogramKind] = useState<"bar" | "curve">("bar");
  const [outputOptions, setOutputOptions] = useState({
    histogram: true,
    insidePixels: true,
    areaRatio: true,
    circularCells: true,
  });
  const [circularityThreshold, setCircularityThreshold] = useState(75);
  const [glassBeadEnabled, setGlassBeadEnabled] = useState(false);
  const [glassBeadCircularityThreshold, setGlassBeadCircularityThreshold] = useState(96);
  const [glassBeadDiameter, setGlassBeadDiameter] = useState(10);
  const [diameterUnit, setDiameterUnit] = useState("µm");
  const [manualBeadPoints, setManualBeadPoints] = useState<Record<string, NormalizedPoint[]>>({});
  const [exclusionEnabled, setExclusionEnabled] = useState(false);
  const [excludedRegions, setExcludedRegions] = useState<Record<string, NormalizedPoint[][]>>({});
  const [draftExclusion, setDraftExclusion] = useState<NormalizedPoint[]>([]);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>(null);
  const [previewDimensions, setPreviewDimensions] = useState({ width: 1, height: 1 });
  const [templateName, setTemplateName] = useState("我的影像處理管線");
  const [savedTemplates, setSavedTemplates] = useState<PipelineTemplateData[]>([]);
  const [processing, setProcessing] = useState(false);
  const [liveUpdating, setLiveUpdating] = useState(false);
  const [message, setMessage] = useState("範例影像已載入，可直接執行管線");
  const [dragStep, setDragStep] = useState<string | null>(null);
  const [fileHover, setFileHover] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const templateInputRef = useRef<HTMLInputElement>(null);
  const previewImageRef = useRef<HTMLImageElement>(null);
  const liveUpdateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const interactiveRequestRef = useRef(0);
  const active = assets.find((asset) => asset.id === activeId) ?? assets[0];
  const selected = pipeline.find((step) => step.uid === selectedUid) ?? pipeline[0];
  const definition = selected ? IMAGE_MODULE_MAP[selected.moduleId] : null;
  const activeStats = stats[active?.id];
  const preview = showResult && results[active?.id]
    ? showAnalysis && analysisOverlays[active.id] ? analysisOverlays[active.id] : results[active.id]
    : active?.url;
  const activeExclusions = excludedRegions[active?.id] ?? [];
  const activeManualBeads = manualBeadPoints[active?.id] ?? [];

  useEffect(() => {
    document.documentElement.dataset.bourbonaiHydrated = "true";
    const loadTimer = setTimeout(() => {
      try {
        const raw = window.localStorage.getItem("bourbonai-msj-templates-v1");
        if (raw) setSavedTemplates(JSON.parse(raw) as PipelineTemplateData[]);
      } catch {
        // Invalid browser-local templates are ignored; importing a .msj file remains available.
      }
    }, 0);
    return () => {
      clearTimeout(loadTimer);
      if (liveUpdateTimerRef.current) clearTimeout(liveUpdateTimerRef.current);
    };
  }, []);

  function addFiles(files: FileList | File[]) {
    const valid = Array.from(files).filter((file) => /^image\//.test(file.type));
    if (!valid.length) return setMessage("請選擇 PNG、JPEG、WebP、BMP 或 TIFF 影像");
    const next = valid.map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      name: file.name,
      url: URL.createObjectURL(file),
    }));
    setAssets((current) => [...current, ...next]);
    setActiveId(next[0].id);
    setShowResult(false);
    setMessage(`已加入 ${next.length} 個影像；執行時將同時處理與分析`);
  }

  function fileChange(event: ChangeEvent<HTMLInputElement>) {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = "";
  }

  function drop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setFileHover(false);
    addFiles(event.dataTransfer.files);
  }

  function patchStep(uid: string, edit: (step: PipelineStep) => PipelineStep) {
    setPipeline((current) => current.map((step) => step.uid === uid ? edit(step) : step));
  }

  function addModule(id: ImageModuleId) {
    const step = createStep(id);
    setPipeline((current) => [...current, step]);
    setSelectedUid(step.uid);
  }

  function reorder(over: string) {
    if (!dragStep || dragStep === over) return;
    setPipeline((current) => {
      const from = current.findIndex((step) => step.uid === dragStep);
      const to = current.findIndex((step) => step.uid === over);
      const next = [...current];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }

  async function processAsset(asset: Asset, overrides: ProcessingOverrides = {}) {
    const source = await toImageData(asset.url, 1400, asset.name);
    const regions = overrides.exclusionRegions ?? excludedRegions[asset.id] ?? [];
    const excludedMask = createExclusionMask(source.width, source.height, regions);
    const output = restoreExcludedPixels(runPipeline(source, pipeline), source, excludedMask);
    const normalizedManualPoints = overrides.manualBeadPoints ?? manualBeadPoints[asset.id] ?? [];
    const analysisPoints: AnalysisPoint[] = normalizedManualPoints.map((point) => ({
      x: point.x * source.width,
      y: point.y * source.height,
    }));
    const analysis = analyzeCellImage(source, {
      circularityThreshold,
      glassBeadEnabled: overrides.glassBeadEnabled ?? glassBeadEnabled,
      glassBeadDiameter,
      glassBeadCircularityThreshold: overrides.glassBeadCircularityThreshold ?? glassBeadCircularityThreshold,
      manualGlassBeadPoints: analysisPoints,
      excludedMask,
    });
    return { url: dataUrl(output), overlayUrl: dataUrl(analysis.overlay), stats: analysis };
  }

  function commitAssetOutput(asset: Asset, output: Awaited<ReturnType<typeof processAsset>>) {
    setResults((current) => ({ ...current, [asset.id]: output.url }));
    setAnalysisOverlays((current) => ({ ...current, [asset.id]: output.overlayUrl }));
    setStats((current) => ({ ...current, [asset.id]: output.stats }));
    if (asset.id === activeId) {
      setShowResult(true);
      setShowAnalysis(true);
    }
  }

  async function run(all = false) {
    const targets = all ? assets : active ? [active] : [];
    if (!targets.length) return;
    setProcessing(true);
    try {
      for (let index = 0; index < targets.length; index += 1) {
        setMessage(`處理 ${index + 1}/${targets.length}：${targets[index].name}`);
        const output = await processAsset(targets[index]);
        commitAssetOutput(targets[index], output);
        await new Promise((resolve) => setTimeout(resolve, 16));
      }
      setShowResult(true);
      setShowAnalysis(true);
      setMessage(`處理與分析完成：${targets.length} 個影像`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "影像處理失敗");
    } finally {
      setProcessing(false);
    }
  }

  async function reprocessActive(overrides: ProcessingOverrides, successMessage: string) {
    if (!active || !results[active.id]) return;
    const requestId = ++interactiveRequestRef.current;
    setLiveUpdating(true);
    try {
      const output = await processAsset(active, overrides);
      if (requestId !== interactiveRequestRef.current) return;
      commitAssetOutput(active, output);
      setMessage(successMessage);
    } catch (error) {
      if (requestId !== interactiveRequestRef.current) return;
      setMessage(error instanceof Error ? error.message : "即時更新失敗");
    } finally {
      if (requestId === interactiveRequestRef.current) setLiveUpdating(false);
    }
  }

  function scheduleLiveReprocess(overrides: ProcessingOverrides, successMessage: string) {
    if (!active || !results[active.id]) return;
    if (liveUpdateTimerRef.current) clearTimeout(liveUpdateTimerRef.current);
    liveUpdateTimerRef.current = setTimeout(() => {
      void reprocessActive(overrides, successMessage);
    }, 120);
  }

  function pointFromPointer(event: ReactPointerEvent<HTMLDivElement>) {
    const image = previewImageRef.current;
    if (!image?.naturalWidth || !image.naturalHeight) return null;
    const rect = image.getBoundingClientRect();
    const scale = Math.min(rect.width / image.naturalWidth, rect.height / image.naturalHeight);
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const left = rect.left + (rect.width - renderedWidth) / 2;
    const top = rect.top + (rect.height - renderedHeight) / 2;
    const x = (event.clientX - left) / renderedWidth;
    const y = (event.clientY - top) / renderedHeight;
    if (x < 0 || y < 0 || x > 1 || y > 1) return null;
    return { x, y };
  }

  function handleBeadSelection(point: NormalizedPoint) {
    if (!active || !activeStats || !glassBeadEnabled) return;
    const candidates = activeStats.objects
      .filter((object) => object.circularity >= 50)
      .map((object) => {
        const centerX = object.centerX / activeStats.imageWidth;
        const centerY = object.centerY / activeStats.imageHeight;
        const distance = Math.hypot(point.x - centerX, point.y - centerY);
        const insideBounds = point.x >= object.minX / activeStats.imageWidth
          && point.x <= object.maxX / activeStats.imageWidth
          && point.y >= object.minY / activeStats.imageHeight
          && point.y <= object.maxY / activeStats.imageHeight;
        return { object, centerX, centerY, distance, insideBounds };
      })
      .filter((candidate) => candidate.insideBounds || candidate.distance <= Math.max(
        0.012,
        candidate.object.diameterPixels / Math.max(activeStats.imageWidth, activeStats.imageHeight),
      ))
      .sort((a, b) => a.distance - b.distance);
    const target = candidates[0];
    if (!target) {
      setMessage("點選位置沒有可辨識的近圓區域；請靠近物件中心或降低玻璃珠圓度門檻");
      return;
    }
    const current = manualBeadPoints[active.id] ?? [];
    const existing = current.findIndex((saved) => Math.hypot(saved.x - target.centerX, saved.y - target.centerY) < 0.01);
    const next = existing >= 0
      ? current.filter((_, index) => index !== existing)
      : [...current, { x: target.centerX, y: target.centerY }];
    setManualBeadPoints((state) => ({ ...state, [active.id]: next }));
    void reprocessActive(
      { manualBeadPoints: next },
      existing >= 0 ? "已取消手動玻璃珠並重新統計" : "已將點選區域標記為玻璃珠、以黑色描邊並重新統計",
    );
  }

  function stagePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (interactionMode !== "exclude" || !exclusionEnabled) return;
    const point = pointFromPointer(event);
    if (!point) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraftExclusion([point]);
  }

  function stagePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (interactionMode !== "exclude" || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const point = pointFromPointer(event);
    if (!point) return;
    setDraftExclusion((current) => {
      const last = current[current.length - 1];
      if (last && Math.hypot(last.x - point.x, last.y - point.y) < 0.006) return current;
      return [...current, point];
    });
  }

  function stagePointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const point = pointFromPointer(event);
    if (interactionMode === "bead" && point) {
      handleBeadSelection(point);
      return;
    }
    if (interactionMode !== "exclude" || !exclusionEnabled) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const completed = point ? [...draftExclusion, point] : draftExclusion;
    setDraftExclusion([]);
    if (!active || completed.length < 3) {
      setMessage("排除區域至少需要圈選三個點");
      return;
    }
    const next = [...(excludedRegions[active.id] ?? []), completed];
    setExcludedRegions((current) => ({ ...current, [active.id]: next }));
    setMessage("排除區域已加入；該區域將保留原圖且不納入分析");
    if (results[active.id]) {
      void reprocessActive({ exclusionRegions: next }, "已套用排除區域並立即更新處理圖與統計");
    }
  }

  function currentTemplate(): PipelineTemplateData {
    return {
      name: templateName,
      pipeline,
      settings: {
        circularityThreshold,
        glassBeadEnabled,
        glassBeadDiameter,
        glassBeadCircularityThreshold,
        diameterUnit,
        outputHistogram: outputOptions.histogram,
        outputInsidePixels: outputOptions.insidePixels,
        outputAreaRatio: outputOptions.areaRatio,
        outputCircularCells: outputOptions.circularCells,
      },
    };
  }

  function applyTemplate(data: PipelineTemplateData) {
    setTemplateName(data.name);
    setPipeline(data.pipeline);
    setSelectedUid(data.pipeline[0].uid);
    setCircularityThreshold(data.settings.circularityThreshold);
    setGlassBeadEnabled(data.settings.glassBeadEnabled);
    setGlassBeadDiameter(data.settings.glassBeadDiameter);
    setGlassBeadCircularityThreshold(data.settings.glassBeadCircularityThreshold);
    setDiameterUnit(data.settings.diameterUnit);
    setOutputOptions({
      histogram: data.settings.outputHistogram,
      insidePixels: data.settings.outputInsidePixels,
      areaRatio: data.settings.outputAreaRatio,
      circularCells: data.settings.outputCircularCells,
    });
    setShowResult(false);
    setInteractionMode(null);
    setMessage(`已載入管線範本「${data.name}」；模組、順序與參數已更新`);
  }

  async function importTemplate(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      applyTemplate(parsePipelineTemplate(await file.arrayBuffer()));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "MSJ 管線範本讀取失敗");
    }
  }

  function saveTemplateInBrowser() {
    const data = currentTemplate();
    const next = [...savedTemplates.filter((template) => template.name !== data.name), data];
    setSavedTemplates(next);
    window.localStorage.setItem("bourbonai-msj-templates-v1", JSON.stringify(next));
    setMessage(`已在此瀏覽器儲存範本「${data.name}」`);
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(pipelineTemplateBlob(currentTemplate()));
    download(url, pipelineTemplateFilename(templateName));
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage(`已下載 ${pipelineTemplateFilename(templateName)}（Excel 工作簿格式）`);
  }

  function makeAnalysisWorkbook() {
    const workbook = XLSX.utils.book_new();
    const analyzed = assets.filter((asset) => stats[asset.id]);
    const summaryRows = analyzed.map((asset) => {
      const item = stats[asset.id];
      return {
        檔案: asset.name,
        分割閾值: item.threshold,
        邊緣內像素: item.insidePixels,
        邊緣外像素: item.outsidePixels,
        使用者排除像素: item.excludedPixels,
        玻璃珠扣除像素: item.beadExcludedPixels,
        實際分析像素: item.analyzedPixels,
        內外面積比: item.insideOutsideRatio,
        內側面積百分比: item.insidePercent,
        內側平均灰階: item.averageGray,
        辨識物件數: item.objectCount,
        近圓細胞數: item.circularCellCount,
        玻璃珠數: item.beadCount,
        玻璃珠平均直徑像素: item.beadDiameterPixels ?? "",
        手動指定玻璃珠數: manualBeadPoints[asset.id]?.length ?? 0,
        排除區域數: excludedRegions[asset.id]?.length ?? 0,
        [`每像素${diameterUnit}`]: item.realUnitsPerPixel ?? "",
        [`玻璃珠真實直徑_${diameterUnit}`]: glassBeadEnabled ? glassBeadDiameter : "",
      };
    });
    const histogramRows = analyzed.flatMap((asset) =>
      stats[asset.id].histogram.map((count, gray) => ({ 檔案: asset.name, 灰階值: gray, 邊緣內像素數: count })),
    );
    const objectRows = analyzed.flatMap((asset) =>
      stats[asset.id].objects.map((object) => ({
        檔案: asset.name,
        物件編號: object.id,
        面積像素: object.areaPixels,
        周長像素: object.perimeterPixels,
        等效直徑像素: object.diameterPixels,
        圓度百分比: object.circularity,
        邊緣平滑度百分比: object.edgeSmoothness,
        平均灰階: object.meanGray,
        灰階標準差: object.grayStdDev,
        中心X: object.centerX,
        中心Y: object.centerY,
        近圓細胞: object.isCircularCell && !object.isGlassBead ? "是" : "否",
        玻璃珠: object.isGlassBead ? "是" : "否",
        手動指定玻璃珠: object.manuallySelectedBead ? "是" : "否",
        [`真實面積_${diameterUnit}²`]: object.realArea ?? "",
      })),
    );
    const settingsRows = [
      { 設定: "近圓細胞圓度門檻 (%)", 值: circularityThreshold },
      { 設定: "玻璃珠校正", 值: glassBeadEnabled ? "啟用" : "停用" },
      { 設定: `玻璃珠真實直徑 (${diameterUnit})`, 值: glassBeadEnabled ? glassBeadDiameter : "" },
      { 設定: "玻璃珠圓度條件", 值: `≥ ${glassBeadCircularityThreshold}%` },
      { 設定: "玻璃珠灰階均勻條件", 值: "灰階標準差 ≤ 10" },
      { 設定: "目前影像手動玻璃珠數", 值: active ? (manualBeadPoints[active.id]?.length ?? 0) : 0 },
      { 設定: "目前影像排除區域數", 值: active ? (excludedRegions[active.id]?.length ?? 0) : 0 },
    ];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(summaryRows), "影像摘要");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(histogramRows), "灰階分布");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(objectRows), "物件量測");
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(settingsRows), "分析設定");
    return workbook;
  }

  function downloadAnalysisExcel() {
    if (!Object.keys(stats).length) return;
    XLSX.writeFile(makeAnalysisWorkbook(), "bourbonai_image_analysis.xlsx");
  }

  async function downloadAllResults() {
    const zip = new JSZip();
    assets.filter((asset) => results[asset.id]).forEach((asset) => {
      const basename = asset.name.replace(/\.[^.]+$/, "");
      zip.file(`${basename}_processed.png`, results[asset.id].split(",")[1], { base64: true });
      if (analysisOverlays[asset.id]) zip.file(`${basename}_analysis_overlay.png`, analysisOverlays[asset.id].split(",")[1], { base64: true });
    });
    zip.file("pipeline.json", JSON.stringify(pipeline, null, 2));
    zip.file("pipeline_template.msj", await pipelineTemplateBlob(currentTemplate()).arrayBuffer());
    zip.file("interactive_regions.json", JSON.stringify({
      manualBeadPoints,
      excludedRegions,
      glassBeadCircularityThreshold,
    }, null, 2));
    zip.file(
      "measurements.csv",
      [
        "file,inside_pixels,outside_pixels,excluded_pixels,bead_excluded_pixels,analyzed_pixels,inside_outside_ratio,inside_percent,average_gray,objects,circular_cells,glass_beads,manual_bead_points,excluded_regions,bead_diameter_pixels,real_units_per_pixel",
        ...assets.filter((asset) => stats[asset.id]).map((asset) =>
          `"${asset.name.replaceAll('"', '""')}",${stats[asset.id].insidePixels},${stats[asset.id].outsidePixels},${stats[asset.id].excludedPixels},${stats[asset.id].beadExcludedPixels},${stats[asset.id].analyzedPixels},${stats[asset.id].insideOutsideRatio},${stats[asset.id].insidePercent},${stats[asset.id].averageGray},${stats[asset.id].objectCount},${stats[asset.id].circularCellCount},${stats[asset.id].beadCount},${manualBeadPoints[asset.id]?.length ?? 0},${excludedRegions[asset.id]?.length ?? 0},${stats[asset.id].beadDiameterPixels ?? ""},${stats[asset.id].realUnitsPerPixel ?? ""}`,
        ),
      ].join("\n"),
    );
    if (Object.keys(stats).length) {
      const workbook = XLSX.write(makeAnalysisWorkbook(), { type: "array", bookType: "xlsx" });
      zip.file("image_analysis.xlsx", workbook);
    }
    const blob = await zip.generateAsync({ type: "blob" });
    download(URL.createObjectURL(blob), "bourbonai_processed_results.zip");
  }

  return (
    <main>
      <Header tab={tab} setTab={setTab} />
      {tab === "image" ? (
        <section className="workspace">
          <div className="workspace-heading">
            <div><span>IMAGE PROCESSING + CELL ANALYSIS</span><h1>影像處理與細胞分析工作區</h1><p>影像執行時必定同時完成處理與分析；支援邊緣量測、近圓細胞辨識與玻璃珠尺度校正。</p></div>
            <em><i />{message}</em>
          </div>
          <div className="image-grid">
            <aside className="panel input-panel">
              <div className="panel-title"><b>↥</b><span><strong>輸入影像</strong><small>Input files</small></span><em>{assets.length}</em></div>
              <input ref={inputRef} type="file" multiple accept="image/*" hidden onChange={fileChange} />
              <div className={`file-drop ${fileHover ? "hover" : ""}`} onDragEnter={(event) => { event.preventDefault(); setFileHover(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setFileHover(false)} onDrop={drop}>
                <b>⇧</b><strong>拖放多個影像</strong><small>PNG · JPEG · WebP · BMP · TIFF</small>
                <button onClick={() => inputRef.current?.click()}>選擇檔案</button>
              </div>
              <div className="file-list">
                {assets.map((asset) => (
                  <button key={asset.id} className={activeId === asset.id ? "active" : ""} onClick={() => { setActiveId(asset.id); setShowResult(Boolean(results[asset.id])); }}>
                    <img src={asset.url} alt="" /><span><strong>{asset.name}</strong><small>{asset.demo ? "內建範例" : "使用者影像"}</small></span><em>{results[asset.id] ? "✓" : "○"}</em>
                  </button>
                ))}
              </div>
            </aside>

            <section className="panel preview-panel">
              <div className="panel-title"><b>◫</b><span><strong>影像預覽</strong><small>Live preview</small></span>
                <div className="segmented">
                  <button className={!showResult ? "active" : ""} onClick={() => setShowResult(false)}>原圖</button>
                  <button disabled={!results[active?.id]} className={showResult && !showAnalysis ? "active" : ""} onClick={() => { setShowResult(true); setShowAnalysis(false); }}>處理</button>
                  <button disabled={!analysisOverlays[active?.id]} className={showResult && showAnalysis ? "active" : ""} onClick={() => { setShowResult(true); setShowAnalysis(true); }}>分析</button>
                </div>
              </div>
              <div
                className={`stage ${interactionMode ? `interactive ${interactionMode}` : ""}`}
                onPointerDown={stagePointerDown}
                onPointerMove={stagePointerMove}
                onPointerUp={stagePointerUp}
              >
                <img
                  ref={previewImageRef}
                  src={preview}
                  alt={active?.name}
                  draggable={false}
                  onLoad={(event) => setPreviewDimensions({
                    width: event.currentTarget.naturalWidth || 1,
                    height: event.currentTarget.naturalHeight || 1,
                  })}
                />
                <svg className="region-overlay" viewBox={`0 0 ${previewDimensions.width} ${previewDimensions.height}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
                  {activeExclusions.map((polygon, index) => (
                    <polygon
                      key={`excluded-${index}`}
                      className="excluded-region"
                      points={polygon.map((point) => `${point.x * previewDimensions.width},${point.y * previewDimensions.height}`).join(" ")}
                    />
                  ))}
                  {draftExclusion.length > 1 && (
                    <polyline
                      className="excluded-region draft"
                      points={draftExclusion.map((point) => `${point.x * previewDimensions.width},${point.y * previewDimensions.height}`).join(" ")}
                    />
                  )}
                  {activeStats?.objects.filter((object) => object.isGlassBead).map((object) => (
                    <ellipse
                      key={`bead-outline-${object.id}`}
                      className="bead-outline"
                      cx={object.centerX / activeStats.imageWidth * previewDimensions.width}
                      cy={object.centerY / activeStats.imageHeight * previewDimensions.height}
                      rx={(object.maxX - object.minX + 1) / activeStats.imageWidth * previewDimensions.width / 2}
                      ry={(object.maxY - object.minY + 1) / activeStats.imageHeight * previewDimensions.height / 2}
                    />
                  ))}
                </svg>
                {interactionMode && <div className="interaction-hint">
                  {interactionMode === "bead" ? "點選近圓區域以指定／取消玻璃珠" : "按住滑鼠圈選不處理的原圖區域"}
                </div>}
                <footer><span>{active?.name}</span><b>{liveUpdating ? "LIVE UPDATING" : showResult ? showAnalysis ? "ANALYSIS OVERLAY" : "PROCESSED" : "ORIGINAL"}</b></footer>
              </div>
              <div className="template-bar">
                <input ref={templateInputRef} type="file" accept=".msj,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={importTemplate} />
                <label><span>管線範本名稱</span><input value={templateName} maxLength={80} onChange={(event) => setTemplateName(event.target.value)} /></label>
                <button onClick={() => templateInputRef.current?.click()}>↥ 上傳 .msj</button>
                <button onClick={saveTemplateInBrowser}>▣ 儲存範本</button>
                <button className="accent" onClick={downloadTemplate}>↓ 下載 .msj</button>
                {savedTemplates.length > 0 && <select value="" onChange={(event) => {
                  const template = savedTemplates.find((item) => item.name === event.target.value);
                  if (template) applyTemplate(template);
                }}>
                  <option value="" disabled>載入已儲存範本</option>
                  {savedTemplates.map((template) => <option key={template.name} value={template.name}>{template.name}</option>)}
                </select>}
              </div>
              <div className="pipeline-title"><span><strong>處理管線</strong><small>拖曳排序；.msj 會記錄模組、順序、參數與分析設定</small></span><em>{pipeline.filter((step) => step.enabled).length} ACTIVE</em></div>
              <div className="pipeline">
                {pipeline.map((step, index) => {
                  const item = IMAGE_MODULE_MAP[step.moduleId];
                  return (
                    <article key={step.uid} draggable onDragStart={() => setDragStep(step.uid)} onDragOver={(event) => { event.preventDefault(); reorder(step.uid); }} onDragEnd={() => setDragStep(null)} onClick={() => setSelectedUid(step.uid)} className={`${selectedUid === step.uid ? "active" : ""} ${!step.enabled ? "off" : ""}`}>
                      <header><b>⠿</b><em>{String(index + 1).padStart(2, "0")}</em><label onClick={(event) => event.stopPropagation()}><input type="checkbox" checked={step.enabled} onChange={(event) => patchStep(step.uid, (current) => ({ ...current, enabled: event.target.checked }))} /><i /></label></header>
                      <strong>{item.en}</strong><span>{item.zh}</span><small>{item.parameters.map((p) => `${p.en.split(" ")[0]} ${step.params[p.key]}`).join(" · ") || "No parameters"}</small>
                      <button onClick={(event) => { event.stopPropagation(); setPipeline((current) => current.filter((value) => value.uid !== step.uid)); }}>×</button><i className="node" />
                    </article>
                  );
                })}
                <select value="" onChange={(event) => addModule(event.target.value as ImageModuleId)}><option value="" disabled>＋ 新增模組</option>{IMAGE_MODULES.map((item) => <option key={item.id} value={item.id}>{item.zh} / {item.en}</option>)}</select>
              </div>
            </section>

            <aside className="panel parameter-panel">
              <div className="panel-title"><b>⌁</b><span><strong>參數設定</strong><small>Parameters</small></span></div>
              {selected && definition && (
                <>
                  <div className="module-head"><b>{definition.category === "模糊降噪" ? "∿" : definition.category === "邊緣偵測" ? "⌁" : "◐"}</b><span><em>{definition.category}</em><strong>{definition.en}</strong><small>{definition.zh}</small></span><i>{selected.enabled ? "啟用中" : "已停用"}</i></div>
                  <p>{definition.description}</p>
                  <div className="parameters">
                    {definition.parameters.length ? definition.parameters.map((param) => (
                      <label key={param.key}><span><strong>{param.zh}</strong><small>{param.en}</small></span>
                        <div><input type="range" min={param.min} max={param.max} step={param.step} value={selected.params[param.key]} onChange={(event) => patchStep(selected.uid, (current) => ({ ...current, params: { ...current.params, [param.key]: Number(event.target.value) } }))} />
                        <input type="number" min={param.min} max={param.max} step={param.step} value={selected.params[param.key]} onChange={(event) => patchStep(selected.uid, (current) => ({ ...current, params: { ...current.params, [param.key]: Number(event.target.value) } }))} /></div>
                      </label>
                    )) : <small className="no-params">此模組沒有可調參數，可直接執行。</small>}
                  </div>
                </>
              )}
              <div className="analysis-options">
                <header><strong>◎ 影像分析輸出</strong><em>執行時必定分析</em></header>
                <div className="output-checks">
                  <label><input type="checkbox" checked={outputOptions.histogram} onChange={(event) => setOutputOptions((current) => ({ ...current, histogram: event.target.checked }))} /><span>a. 內側灰階分布與數值</span></label>
                  <label><input type="checkbox" checked={outputOptions.insidePixels} onChange={(event) => setOutputOptions((current) => ({ ...current, insidePixels: event.target.checked }))} /><span>b. 邊緣內側像素總數</span></label>
                  <label><input type="checkbox" checked={outputOptions.areaRatio} onChange={(event) => setOutputOptions((current) => ({ ...current, areaRatio: event.target.checked }))} /><span>c. 邊緣內外面積比例</span></label>
                  <label><input type="checkbox" checked={outputOptions.circularCells} onChange={(event) => setOutputOptions((current) => ({ ...current, circularCells: event.target.checked }))} /><span>d. 近似圓形細胞總數</span></label>
                </div>
                <div className="analysis-controls">
                  <label><span>圖表</span><select value={histogramKind} onChange={(event) => setHistogramKind(event.target.value as "bar" | "curve")}><option value="bar">長條圖</option><option value="curve">曲線圖</option></select></label>
                  <label><span>細胞圓度門檻</span><input type="number" min="50" max="99" value={circularityThreshold} onChange={(event) => setCircularityThreshold(Number(event.target.value))} /><small>%</small></label>
                </div>
                <label className="bead-toggle"><input type="checkbox" checked={glassBeadEnabled} onChange={(event) => {
                  const enabled = event.target.checked;
                  setGlassBeadEnabled(enabled);
                  if (!enabled) setInteractionMode(null);
                  scheduleLiveReprocess({ glassBeadEnabled: enabled }, enabled ? "已啟用玻璃珠辨識並更新統計" : "已停用玻璃珠辨識並更新統計");
                }} /><span><strong>影像中有玻璃珠</strong><small>自動門檻或滑鼠點選；玻璃珠區域會從統計中扣除</small></span></label>
                {glassBeadEnabled && <div className="bead-tools">
                  <div className="bead-calibration">
                    <label><span>玻璃珠真實直徑</span><input type="number" min="0.0001" step="0.1" value={glassBeadDiameter} onChange={(event) => {
                      setGlassBeadDiameter(Number(event.target.value));
                      scheduleLiveReprocess({}, "玻璃珠真實直徑已更新");
                    }} /></label>
                    <select value={diameterUnit} onChange={(event) => setDiameterUnit(event.target.value)}><option value="µm">µm</option><option value="mm">mm</option><option value="cm">cm</option></select>
                  </div>
                  <label className="bead-threshold"><span><strong>玻璃珠近似圓門檻</strong><small>即時更新黑色輪廓與統計</small></span>
                    <div><input type="range" min="50" max="100" step="0.5" value={glassBeadCircularityThreshold} onChange={(event) => {
                      const value = Number(event.target.value);
                      setGlassBeadCircularityThreshold(value);
                      scheduleLiveReprocess({ glassBeadCircularityThreshold: value }, `玻璃珠圓度門檻已更新為 ${value}%`);
                    }} /><input type="number" min="50" max="100" step="0.5" value={glassBeadCircularityThreshold} onChange={(event) => {
                      const value = Number(event.target.value);
                      setGlassBeadCircularityThreshold(value);
                      scheduleLiveReprocess({ glassBeadCircularityThreshold: value }, `玻璃珠圓度門檻已更新為 ${value}%`);
                    }} /><i>%</i></div>
                  </label>
                  <div className="interaction-actions">
                    <button className={interactionMode === "bead" ? "active" : ""} disabled={!activeStats} onClick={() => {
                      setInteractionMode((current) => current === "bead" ? null : "bead");
                      setShowResult(true);
                      setShowAnalysis(true);
                    }}>◎ 點選玻璃珠</button>
                    <button disabled={!activeManualBeads.length} onClick={() => {
                      if (!active) return;
                      setManualBeadPoints((current) => ({ ...current, [active.id]: [] }));
                      void reprocessActive({ manualBeadPoints: [] }, "已清除手動玻璃珠並重新統計");
                    }}>清除點選 ({activeManualBeads.length})</button>
                  </div>
                </div>}
                <label className="bead-toggle exclusion-toggle"><input type="checkbox" checked={exclusionEnabled} onChange={(event) => {
                  const enabled = event.target.checked;
                  setExclusionEnabled(enabled);
                  setInteractionMode(enabled ? "exclude" : null);
                  if (enabled) {
                    setShowResult(false);
                    setMessage("排除模式已啟用：請在原始影像上按住滑鼠圈選");
                  }
                }} /><span><strong>排除區域</strong><small>圈選區域保留原圖，不進行管線處理或資料統計</small></span></label>
                {exclusionEnabled && <div className="interaction-actions exclusion-actions">
                  <button className={interactionMode === "exclude" ? "active" : ""} onClick={() => {
                    setInteractionMode((current) => current === "exclude" ? null : "exclude");
                    setShowResult(false);
                  }}>⌁ 圈選排除區域</button>
                  <button disabled={!activeExclusions.length} onClick={() => {
                    if (!active) return;
                    const next = activeExclusions.slice(0, -1);
                    setExcludedRegions((current) => ({ ...current, [active.id]: next }));
                    if (results[active.id]) void reprocessActive({ exclusionRegions: next }, "已復原最後一個排除區域並更新結果");
                  }}>復原上一區</button>
                  <button disabled={!activeExclusions.length} onClick={() => {
                    if (!active) return;
                    setExcludedRegions((current) => ({ ...current, [active.id]: [] }));
                    if (results[active.id]) void reprocessActive({ exclusionRegions: [] }, "已清除排除區域並更新結果");
                  }}>全部清除 ({activeExclusions.length})</button>
                </div>}
                <div className="analysis-legend"><span><i className="cell" />近圓細胞</span><span><i className="bead" />玻璃珠（黑邊）</span><span><i className="excluded" />排除區域</span><span><i />其他輪廓</span></div>
              </div>
              <div className="stats"><header><strong>▥ 分析量測結果</strong><em>{activeStats ? "已更新" : "等待執行"}</em></header>
                {activeStats ? <>
                  {outputOptions.histogram && <>
                    <Histogram values={activeStats.histogram} kind={histogramKind} />
                    <details className="histogram-values"><summary>展開 0–255 灰階數值</summary><div>{activeStats.histogram.map((count, gray) => <span key={gray}><i>{gray}</i><b>{count.toLocaleString()}</b></span>)}</div></details>
                  </>}
                  <dl className="measurement-grid">
                    {outputOptions.insidePixels && <div><dt>內側像素</dt><dd>{activeStats.insidePixels.toLocaleString()}</dd></div>}
                    {outputOptions.areaRatio && <div><dt>內／外比</dt><dd>{Number.isFinite(activeStats.insideOutsideRatio) ? activeStats.insideOutsideRatio.toFixed(4) : "∞"}</dd></div>}
                    {outputOptions.areaRatio && <div><dt>內側面積</dt><dd>{activeStats.insidePercent.toFixed(2)}%</dd></div>}
                    {outputOptions.circularCells && <div><dt>近圓細胞</dt><dd>{activeStats.circularCellCount}</dd></div>}
                    {glassBeadEnabled && <div><dt>玻璃珠</dt><dd>{activeStats.beadCount}</dd></div>}
                    {glassBeadEnabled && <div><dt>玻璃珠扣除</dt><dd>{activeStats.beadExcludedPixels.toLocaleString()} px</dd></div>}
                    {exclusionEnabled && <div><dt>區域排除</dt><dd>{activeStats.excludedPixels.toLocaleString()} px</dd></div>}
                    <div><dt>分割閾值</dt><dd>{activeStats.threshold}</dd></div>
                  </dl>
                  {glassBeadEnabled && <div className="calibration-result">
                    {activeStats.realUnitsPerPixel ? <>
                      <strong>校正：1 pixel = {activeStats.realUnitsPerPixel.toPrecision(5)} {diameterUnit}</strong>
                      <small>玻璃珠平均直徑 {activeStats.beadDiameterPixels?.toFixed(2)} pixel；細胞面積已換算為 {diameterUnit}²。</small>
                    </> : <><strong>尚未辨識到合格玻璃珠</strong><small>請確認圓度、邊緣平滑度、內部均勻性與輸入直徑。</small></>}
                  </div>}
                  {activeStats.objects.length > 0 && <div className="object-table"><header><span>ID</span><span>面積 px</span><span>圓度</span><span>類型／真實面積</span></header>{activeStats.objects.slice(0, 12).map((object) => <div key={object.id}><span>{object.id}</span><span>{object.areaPixels}</span><span>{object.circularity.toFixed(1)}%</span><span>{object.isGlassBead ? object.manuallySelectedBead ? "玻璃珠（手動）" : "玻璃珠（自動）" : object.isCircularCell ? object.realArea ? `${object.realArea.toPrecision(5)} ${diameterUnit}²` : "近圓細胞" : "其他"}</span></div>)}</div>}
                </> : <p>執行後顯示邊緣內側灰階分布、面積比例、近圓細胞及玻璃珠校正結果。</p>}
              </div>
              <div className="save-actions three"><button disabled={!results[active?.id]} onClick={() => download(results[active.id], active.name.replace(/\.[^.]+$/, "") + "_processed.png")}>↓ 處理圖</button><button disabled={!analysisOverlays[active?.id]} onClick={() => download(analysisOverlays[active.id], active.name.replace(/\.[^.]+$/, "") + "_analysis.png")}>↓ 分析圖</button><button disabled={!Object.keys(stats).length} onClick={downloadAnalysisExcel}>▦ Excel</button><button disabled={!Object.keys(results).length} onClick={downloadAllResults}>⇊ 全部 ZIP</button></div>
            </aside>
          </div>
          <div className="run-dock"><div><span>▤ {pipeline.length} modules</span><span>◫ {assets.length} files</span><em>處理完成即更新預覽；運算皆在瀏覽器進行</em></div><button onClick={() => run(true)} disabled={processing || liveUpdating}>批次處理＋分析</button><button className="primary" onClick={() => run(false)} disabled={processing || liveUpdating}><b>{processing || liveUpdating ? "◌" : "▶"}</b><span><strong>{processing ? "正在運算…" : liveUpdating ? "即時更新中…" : "執行處理與分析"}</strong><small>RUN CURRENT IMAGE</small></span></button></div>
        </section>
      ) : tab === "data" ? <DataWorkspace /> : tab === "som" ? <SomWorkspace /> : <ModuleRegistry />}
    </main>
  );
}
