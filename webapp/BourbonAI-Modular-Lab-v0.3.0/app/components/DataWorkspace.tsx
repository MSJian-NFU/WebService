"use client";

import { useMemo, useRef, useState, type ChangeEvent } from "react";
import * as XLSX from "xlsx";
import {
  analyze,
  precisionSearch,
  vectorizeText,
  type AnalysisMethod,
  type AnalysisResult,
  type TextDocument,
} from "../lib/data-modules";

type Mode = "numeric" | "english" | "chinese" | "precision";
type LoadedFile = { file: File; text?: string };

const methods: { id: AnalysisMethod; zh: string; en: string }[] = [
  { id: "kmeans", zh: "K-Means 分群", en: "Centroid clustering" },
  { id: "dbscan", zh: "DBSCAN 分群", en: "Density clustering" },
  { id: "svm", zh: "支援向量機", en: "Linear SVM" },
  { id: "tree", zh: "決策樹", en: "Decision Tree" },
  { id: "forest", zh: "隨機森林", en: "Random Forest" },
];

async function readText(file: File) {
  if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
    const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages: string[] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => "str" in item ? item.str : "").join(" "));
    }
    return pages.join("\n");
  }
  return file.text();
}

function numericRows(text: string) {
  try {
    const parsed = JSON.parse(text);
    const source = Array.isArray(parsed) ? parsed : [parsed];
    const rows = source.map((item) =>
      Array.isArray(item)
        ? item.map(Number).filter(Number.isFinite)
        : typeof item === "object" && item
          ? Object.values(item).map(Number).filter(Number.isFinite)
          : [],
    ).filter((row) => row.length >= 2);
    if (rows.length) return rows;
  } catch {
    // Delimited text is handled below.
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.trim().split(/[,;\t ]+/).map(Number).filter(Number.isFinite))
    .filter((row) => row.length >= 2);
}

async function numericRowsFromFile(file: File) {
  if (/\.xlsx?$/i.test(file.name)) {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const rows: number[][] = [];
    const names: string[] = [];
    workbook.SheetNames.forEach((sheetName) => {
      const sheet = workbook.Sheets[sheetName];
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
      grid.forEach((source, index) => {
        const row = source
          .map((value) => typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN)
          .filter(Number.isFinite);
        if (row.length >= 2) {
          rows.push(row);
          names.push(`${file.name} · ${sheetName} · ${index + 1}`);
        }
      });
    });
    return { rows, names };
  }
  const rows = numericRows(await file.text());
  return { rows, names: rows.map((_, index) => `${file.name} · ${index + 1}`) };
}

function saveText(text: string, name: string, type = "text/csv") {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([text], { type }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

function Scatter({ result, names }: { result: AnalysisResult; names: string[] }) {
  const points = result.projection;
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const colors = ["#36d7e8", "#74f0a7", "#f26b4a", "#9d8cff", "#ffd166", "#7bdff2", "#ff8fab"];
  const scaleX = (value: number) => 32 + 446 * (value - minX) / Math.max(0.0001, maxX - minX);
  const scaleY = (value: number) => 258 - 226 * (value - minY) / Math.max(0.0001, maxY - minY);
  return (
    <svg className="pca-chart" viewBox="0 0 510 290" role="img" aria-label="PCA 降維資料分布圖">
      <g className="grid-lines">
        {[0, 1, 2, 3, 4].map((index) => <line key={`h${index}`} x1="32" y1={32 + index * 56.5} x2="478" y2={32 + index * 56.5} />)}
        {[0, 1, 2, 3, 4, 5].map((index) => <line key={`v${index}`} x1={32 + index * 89.2} y1="32" x2={32 + index * 89.2} y2="258" />)}
      </g>
      {points.map((point, index) => (
        <circle key={index} cx={scaleX(point[0])} cy={scaleY(point[1])} r="6" fill={result.labels[index] < 0 ? "#607988" : colors[result.labels[index] % colors.length]}>
          <title>{names[index] ?? `Row ${index + 1}`} · Group {result.labels[index]}</title>
        </circle>
      ))}
      <text x="255" y="282">PC1 · {result.explainedVariance[0].toFixed(1)}%</text>
      <text x="13" y="145" transform="rotate(-90 13 145)">PC2 · {result.explainedVariance[1].toFixed(1)}%</text>
    </svg>
  );
}

export default function DataWorkspace() {
  const [mode, setMode] = useState<Mode>("numeric");
  const [files, setFiles] = useState<LoadedFile[]>([]);
  const [stopWords, setStopWords] = useState<Set<string>>(new Set());
  const [method, setMethod] = useState<AnalysisMethod>("kmeans");
  const [clusters, setClusters] = useState(3);
  const [epsilon, setEpsilon] = useState(0.9);
  const [minPoints, setMinPoints] = useState(4);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [keywords, setKeywords] = useState<{ term: string; score: number }[]>([]);
  const [wordA, setWordA] = useState("cell");
  const [wordB, setWordB] = useState("");
  const [windowSize, setWindowSize] = useState(80);
  const [searchResults, setSearchResults] = useState<{ file: string; excerpt: string }[]>([]);
  const [message, setMessage] = useState("請加入資料或文件");
  const [running, setRunning] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const stopRef = useRef<HTMLInputElement>(null);

  const accept = mode === "numeric" ? ".xlsx,.xls,.csv,.json,.jsonl,.log,.txt" : ".pdf,.json,.log,.txt,.csv";
  const countSummary = useMemo(() => `${files.length} files · ${stopWords.size} stop words`, [files, stopWords]);

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    if (!event.target.files) return;
    setFiles((current) => [...current, ...Array.from(event.target.files!).map((file) => ({ file }))]);
    setMessage(`已加入 ${event.target.files.length} 個檔案`);
    event.target.value = "";
  }

  async function loadStopWords(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    setStopWords(new Set(text.split(/\r?\n|[,;]/).map((word) => word.trim().toLowerCase()).filter(Boolean)));
    setMessage(`已載入停用詞彙：${file.name}`);
  }

  async function run() {
    if (!files.length) return setMessage("請先加入分析檔案");
    setRunning(true);
    try {
      const documents: TextDocument[] = [];
      if (mode !== "numeric") {
        for (const item of files) documents.push({ name: item.file.name, text: item.text ?? await readText(item.file) });
      }
      if (mode === "precision") {
        if (!wordA.trim()) throw new Error("請填入關鍵詞彙 A");
        const found = precisionSearch(documents, wordA.trim(), wordB.trim(), windowSize);
        setSearchResults(found);
        setResult(null);
        setMessage(`精準搜尋完成：找到 ${found.length} 個段落`);
        return;
      }
      let rows: number[][] = [];
      let rowNames: string[] = [];
      if (mode === "numeric") {
        for (const item of files) {
          const parsed = await numericRowsFromFile(item.file);
          rows.push(...parsed.rows);
          rowNames.push(...parsed.names);
        }
      } else {
        if (documents.length < 2) throw new Error("文件關鍵字分析至少需要兩份文件");
        const vectorized = vectorizeText(documents, mode === "english" ? "en" : "zh", stopWords);
        rows = vectorized.features;
        rowNames = documents.map((document) => document.name);
        setKeywords(vectorized.keywords);
      }
      if (!rows.length) throw new Error("檔案中找不到至少含兩個數值的資料列");
      const width = Math.min(...rows.map((row) => row.length));
      rows = rows.map((row) => row.slice(0, width));
      const analysis = analyze(rows, method, { clusters, epsilon, minPoints });
      setNames(rowNames);
      setResult(analysis);
      setSearchResults([]);
      setMessage(`分析完成：${rows.length} 筆 × ${width} 個特徵`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "資料分析失敗");
    } finally {
      setRunning(false);
    }
  }

  function exportResult() {
    if (searchResults.length) {
      saveText(["file,excerpt", ...searchResults.map((item) => `"${item.file.replaceAll('"', '""')}","${item.excerpt.replaceAll('"', '""')}"`)].join("\n"), "precision_search_results.csv");
      return;
    }
    if (!result) return;
    saveText([
      "item,pc1,pc2,group",
      ...result.projection.map((point, index) => `"${(names[index] ?? `Row ${index + 1}`).replaceAll('"', '""')}",${point[0]},${point[1]},${result.labels[index]}`),
    ].join("\n"), "analysis_pca_results.csv");
  }

  return (
    <section className="workspace analysis-workspace">
      <div className="workspace-heading">
        <div><span>STANDALONE DATA ANALYSIS</span><h1>獨立資料分析與分類分群</h1><p>直接上傳 Excel 或 TXT 即可分析，不需要任何影像；整合分類、分群與 PCA 視覺化。</p></div>
        <em><i />{message}</em>
      </div>
      <div className="analysis-grid">
        <aside className="panel analysis-source">
          <div className="panel-title"><b>▤</b><span><strong>分析模式</strong><small>Analysis mode</small></span></div>
          <div className="mode-list">
            {([
              ["numeric", "數值分析", "EXCEL · CSV · JSON · TXT"],
              ["english", "英文關鍵字分析", "TF-IDF keyword analysis"],
              ["chinese", "中文關鍵字分析", "中文雙字詞斷詞"],
              ["precision", "精準段落搜尋", "Keyword A · B · Window"],
            ] as [Mode, string, string][]).map(([id, zh, en]) => (
              <button key={id} className={mode === id ? "active" : ""} onClick={() => { setMode(id); setResult(null); setSearchResults([]); }}>
                <i>{mode === id ? "●" : "○"}</i><span><strong>{zh}</strong><small>{en}</small></span>
              </button>
            ))}
          </div>
          <div className="independent-note"><b>✓</b><span><strong>資料功能可獨立運作</strong><small>Excel / TXT 不需搭配影像上傳</small></span></div>
          <input ref={fileRef} hidden type="file" multiple accept={accept} onChange={addFiles} />
          <button className="data-upload" onClick={() => fileRef.current?.click()}>＋ 加入分析檔案</button>
          <div className="loaded-files">
            {files.length ? files.map((item, index) => <div key={`${item.file.name}-${index}`}><b>▧</b><span><strong>{item.file.name}</strong><small>{(item.file.size / 1024).toFixed(1)} KB</small></span><button onClick={() => setFiles((current) => current.filter((_, position) => position !== index))}>×</button></div>) : <p>尚未加入檔案</p>}
          </div>
          {(mode === "english" || mode === "chinese") && <>
            <input ref={stopRef} hidden type="file" accept=".txt,.csv" onChange={loadStopWords} />
            <button className="stop-upload" onClick={() => stopRef.current?.click()}>載入停用詞彙檔案</button>
          </>}
          <small className="source-summary">{countSummary}</small>
          <div className="sample-links">
            <span>範例檔案</span>
            <a href="/samples/numeric_cells.csv" download>數值 CSV</a>
            <a href="/samples/stopwords_en.txt" download>英文停用詞</a>
            <a href="/samples/stopwords_zh.txt" download>中文停用詞</a>
          </div>
        </aside>

        <section className="panel analysis-methods">
          <div className="panel-title"><b>⌘</b><span><strong>分析方法與參數</strong><small>Methods & parameters</small></span></div>
          {mode === "precision" ? (
            <div className="search-params">
              <label><span>關鍵詞彙 A</span><input value={wordA} onChange={(event) => setWordA(event.target.value)} /></label>
              <label><span>關鍵詞彙 B（可空白）</span><input value={wordB} onChange={(event) => setWordB(event.target.value)} /></label>
              <label><span>前後字元長度</span><input type="number" min="10" max="1000" value={windowSize} onChange={(event) => setWindowSize(Number(event.target.value))} /></label>
            </div>
          ) : (
            <>
              <div className="method-list">
                {methods.map((item) => <button key={item.id} className={method === item.id ? "active" : ""} onClick={() => setMethod(item.id)}><b>{item.id === "kmeans" ? "K" : item.id === "dbscan" ? "D" : item.id === "svm" ? "S" : item.id === "tree" ? "T" : "RF"}</b><span><strong>{item.zh}</strong><small>{item.en}</small></span><i>{method === item.id ? "✓" : ""}</i></button>)}
              </div>
              <div className="analysis-params">
                <label><span>群組數 K</span><input type="number" min="2" max="12" value={clusters} onChange={(event) => setClusters(Number(event.target.value))} /></label>
                <label><span>DBSCAN ε</span><input type="number" min=".1" max="5" step=".1" value={epsilon} onChange={(event) => setEpsilon(Number(event.target.value))} /></label>
                <label><span>最少點數</span><input type="number" min="2" max="30" value={minPoints} onChange={(event) => setMinPoints(Number(event.target.value))} /></label>
              </div>
            </>
          )}
          <button className="run-analysis" onClick={run} disabled={running}>{running ? "◌ 正在分析…" : "▶ 執行分析流程"}</button>
        </section>

        <section className="panel analysis-output">
          <div className="panel-title"><b>⌁</b><span><strong>分析輸出</strong><small>PCA & result</small></span><em>{result ? Object.keys(result.counts).length : searchResults.length}</em></div>
          {result ? <>
            <Scatter result={result} names={names} />
            <div className="analysis-summary">
              <div><span>PC1 解釋率</span><strong>{result.explainedVariance[0].toFixed(1)}%</strong></div>
              <div><span>PC2 解釋率</span><strong>{result.explainedVariance[1].toFixed(1)}%</strong></div>
              <div><span>群組／類別</span><strong>{Object.keys(result.counts).length}</strong></div>
              <div><span>分類一致率</span><strong>{result.score ? `${result.score.toFixed(1)}%` : "—"}</strong></div>
            </div>
            <p className="analysis-note">{result.note}</p>
            {keywords.length > 0 && <div className="keyword-cloud">{keywords.map((keyword) => <span key={keyword.term}>{keyword.term}</span>)}</div>}
          </> : searchResults.length ? (
            <div className="search-results">{searchResults.slice(0, 20).map((item, index) => <article key={index}><strong>{item.file}</strong><p>{item.excerpt}</p></article>)}</div>
          ) : (
            <div className="output-empty"><b>⌁</b><strong>等待分析結果</strong><p>完成後將在此顯示 PCA 分布、群組統計與關鍵詞。</p></div>
          )}
          <button className="export-analysis" disabled={!result && !searchResults.length} onClick={exportResult}>↓ 匯出分析結果 CSV</button>
        </section>
      </div>
    </section>
  );
}
