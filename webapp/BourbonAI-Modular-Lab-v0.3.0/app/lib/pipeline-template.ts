import * as XLSX from "xlsx";
import {
  IMAGE_MODULE_MAP,
  createStep,
  type ImageModuleId,
  type PipelineStep,
} from "./image-modules";

export type PipelineTemplateSettings = {
  circularityThreshold: number;
  glassBeadEnabled: boolean;
  glassBeadDiameter: number;
  glassBeadCircularityThreshold: number;
  diameterUnit: string;
  outputHistogram: boolean;
  outputInsidePixels: boolean;
  outputAreaRatio: boolean;
  outputCircularCells: boolean;
};

export type PipelineTemplateData = {
  name: string;
  pipeline: PipelineStep[];
  settings: PipelineTemplateSettings;
};

type GenericRow = Record<string, string | number | boolean | undefined>;

const toBoolean = (value: unknown, fallback = false) => {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return ["1", "true", "yes", "是", "啟用"].includes(value.trim().toLowerCase());
  return fallback;
};

const toNumber = (value: unknown, fallback: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

function safeName(name: string) {
  return name.trim().replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80) || "未命名管線";
}

export function createPipelineTemplateWorkbook(data: PipelineTemplateData) {
  const workbook = XLSX.utils.book_new();
  const metadata = [
    { 欄位: "格式", 值: "BOURBONAI_MSJ" },
    { 欄位: "版本", 值: 1 },
    { 欄位: "範本名稱", 值: safeName(data.name) },
    { 欄位: "建立時間", 值: new Date().toISOString() },
    { 欄位: "說明", 值: "此 .msj 檔案為 Excel 工作簿格式，記錄影像處理模組、順序與參數。" },
  ];
  const pipelineRows = data.pipeline.map((step, index) => ({
    順序: index + 1,
    模組ID: step.moduleId,
    模組中文名稱: IMAGE_MODULE_MAP[step.moduleId].zh,
    模組英文名稱: IMAGE_MODULE_MAP[step.moduleId].en,
    啟用: step.enabled ? "是" : "否",
  }));
  const parameterRows = data.pipeline.flatMap((step, index) =>
    Object.entries(step.params).map(([key, value]) => ({
      順序: index + 1,
      模組ID: step.moduleId,
      參數鍵: key,
      參數值: value,
    })),
  );
  const settingsRows = [
    { 設定鍵: "circularityThreshold", 設定名稱: "細胞圓度門檻 (%)", 值: data.settings.circularityThreshold },
    { 設定鍵: "glassBeadEnabled", 設定名稱: "啟用玻璃珠", 值: data.settings.glassBeadEnabled ? "是" : "否" },
    { 設定鍵: "glassBeadDiameter", 設定名稱: "玻璃珠真實直徑", 值: data.settings.glassBeadDiameter },
    { 設定鍵: "glassBeadCircularityThreshold", 設定名稱: "玻璃珠圓度門檻 (%)", 值: data.settings.glassBeadCircularityThreshold },
    { 設定鍵: "diameterUnit", 設定名稱: "直徑單位", 值: data.settings.diameterUnit },
    { 設定鍵: "outputHistogram", 設定名稱: "輸出灰階分布", 值: data.settings.outputHistogram ? "是" : "否" },
    { 設定鍵: "outputInsidePixels", 設定名稱: "輸出內側像素", 值: data.settings.outputInsidePixels ? "是" : "否" },
    { 設定鍵: "outputAreaRatio", 設定名稱: "輸出內外面積比", 值: data.settings.outputAreaRatio ? "是" : "否" },
    { 設定鍵: "outputCircularCells", 設定名稱: "輸出近圓細胞數", 值: data.settings.outputCircularCells ? "是" : "否" },
  ];

  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(metadata), "範本資訊");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(pipelineRows), "處理管線");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(parameterRows), "模組參數");
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(settingsRows), "分析設定");
  return workbook;
}

export function pipelineTemplateBlob(data: PipelineTemplateData) {
  const bytes = XLSX.write(createPipelineTemplateWorkbook(data), {
    type: "array",
    bookType: "xlsx",
  });
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

export function pipelineTemplateFilename(name: string) {
  return `${safeName(name)}.msj`;
}

export function parsePipelineTemplate(buffer: ArrayBuffer): PipelineTemplateData {
  const workbook = XLSX.read(buffer, { type: "array" });
  const pipelineSheet = workbook.Sheets["處理管線"];
  if (!pipelineSheet) throw new Error("此檔案缺少「處理管線」工作表，無法作為 BourbonAI .msj 範本載入");

  const metadataRows = workbook.Sheets["範本資訊"]
    ? XLSX.utils.sheet_to_json<GenericRow>(workbook.Sheets["範本資訊"])
    : [];
  const metadata = Object.fromEntries(metadataRows.map((row) => [String(row.欄位 ?? ""), row.值]));
  if (metadata.格式 && metadata.格式 !== "BOURBONAI_MSJ") {
    throw new Error("此檔案不是 BourbonAI MSJ 管線範本");
  }

  const pipelineRows = XLSX.utils.sheet_to_json<GenericRow>(pipelineSheet)
    .sort((a, b) => toNumber(a.順序, 0) - toNumber(b.順序, 0));
  const parameterRows = workbook.Sheets["模組參數"]
    ? XLSX.utils.sheet_to_json<GenericRow>(workbook.Sheets["模組參數"])
    : [];

  const pipeline = pipelineRows.map((row, index) => {
    const moduleId = String(row.模組ID ?? "") as ImageModuleId;
    if (!IMAGE_MODULE_MAP[moduleId]) {
      throw new Error(`第 ${index + 1} 個步驟使用未知模組：${moduleId || "空白"}`);
    }
    const step = createStep(moduleId);
    const order = toNumber(row.順序, index + 1);
    const params = { ...step.params };
    parameterRows
      .filter((parameter) => toNumber(parameter.順序, -1) === order)
      .forEach((parameter) => {
        const key = String(parameter.參數鍵 ?? "");
        const value = Number(parameter.參數值);
        if (key in params && Number.isFinite(value)) params[key] = value;
      });
    return {
      ...step,
      enabled: toBoolean(row.啟用, true),
      params,
    };
  });
  if (!pipeline.length) throw new Error("MSJ 範本內沒有任何處理模組");

  const settingRows = workbook.Sheets["分析設定"]
    ? XLSX.utils.sheet_to_json<GenericRow>(workbook.Sheets["分析設定"])
    : [];
  const settings = Object.fromEntries(settingRows.map((row) => [String(row.設定鍵 ?? ""), row.值]));
  return {
    name: String(metadata.範本名稱 ?? "匯入管線"),
    pipeline,
    settings: {
      circularityThreshold: toNumber(settings.circularityThreshold, 75),
      glassBeadEnabled: toBoolean(settings.glassBeadEnabled, false),
      glassBeadDiameter: toNumber(settings.glassBeadDiameter, 10),
      glassBeadCircularityThreshold: toNumber(settings.glassBeadCircularityThreshold, 96),
      diameterUnit: String(settings.diameterUnit ?? "µm"),
      outputHistogram: toBoolean(settings.outputHistogram, true),
      outputInsidePixels: toBoolean(settings.outputInsidePixels, true),
      outputAreaRatio: toBoolean(settings.outputAreaRatio, true),
      outputCircularCells: toBoolean(settings.outputCircularCells, true),
    },
  };
}
