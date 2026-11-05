"use client";

import { useRef, useState, type ChangeEvent } from "react";
import {
  extractImageFeature,
  mapSomItems,
  retrieveSimilar,
  trainSom,
  type SomItem,
  type SomModel,
} from "../lib/som";

type RawImage = { id: string; name: string; url: string; demo?: boolean };
const demo: RawImage = { id: "som-demo", name: "demo_fluorescence_cells.png", url: "/demo-cells.png", demo: true };

function saveCsv(items: SomItem[]) {
  const rows = [
    "file,som_x,som_y,quantization_distance",
    ...items.map((item) => `"${item.name.replaceAll('"', '""')}",${item.node?.x ?? ""},${item.node?.y ?? ""},${item.distance ?? ""}`),
  ];
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([rows.join("\n")], { type: "text/csv" }));
  anchor.download = "som_image_map.csv";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

export default function SomWorkspace() {
  const [images, setImages] = useState<RawImage[]>([demo]);
  const [mapped, setMapped] = useState<SomItem[]>([]);
  const [model, setModel] = useState<SomModel | null>(null);
  const [width, setWidth] = useState(5);
  const [height, setHeight] = useState(4);
  const [epochs, setEpochs] = useState(90);
  const [queryId, setQueryId] = useState("som-demo");
  const [message, setMessage] = useState("請加入至少一張影像，再建立 SOM");
  const [training, setTraining] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const query = mapped.find((item) => item.id === queryId);
  const similar = query ? retrieveSimilar(query, mapped, 8) : [];

  function addFiles(event: ChangeEvent<HTMLInputElement>) {
    if (!event.target.files) return;
    const next = Array.from(event.target.files).filter((file) => /^image\//.test(file.type)).map((file, index) => ({
      id: `${file.name}-${file.lastModified}-${index}`,
      name: file.name,
      url: URL.createObjectURL(file),
    }));
    setImages((current) => [...current, ...next]);
    if (next[0]) setQueryId(next[0].id);
    setMessage(`已加入 ${next.length} 張影像`);
    event.target.value = "";
  }

  async function train() {
    if (images.length < 2) return setMessage("SOM 至少需要兩張影像，請再加入一張");
    setTraining(true);
    try {
      const featured: SomItem[] = [];
      for (let index = 0; index < images.length; index += 1) {
        setMessage(`擷取特徵 ${index + 1}/${images.length}：${images[index].name}`);
        featured.push({ ...images[index], feature: await extractImageFeature(images[index].url) });
      }
      setMessage(`訓練 ${width}×${height} SOM，共 ${epochs} epochs…`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      const nextModel = trainSom(featured.map((item) => item.feature), width, height, epochs);
      const nextMapped = mapSomItems(nextModel, featured);
      setModel(nextModel);
      setMapped(nextMapped);
      setMessage(`SOM 建立完成：${images.length} 張影像映射至 ${width * height} 個節點`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "SOM 訓練失敗");
    } finally {
      setTraining(false);
    }
  }

  return (
    <section className="workspace som-workspace">
      <div className="workspace-heading">
        <div><span>SELF-ORGANIZING MAP RETRIEVAL</span><h1>SOM 影像檢索</h1><p>以色彩、灰階與邊緣特徵進行非監督式拓撲映射，再依特徵距離檢索相似影像。</p></div>
        <em><i />{message}</em>
      </div>
      <div className="som-layout">
        <aside className="panel som-source">
          <div className="panel-title"><b>◫</b><span><strong>影像資料集</strong><small>Image dataset</small></span><em>{images.length}</em></div>
          <input hidden ref={inputRef} type="file" multiple accept="image/*" onChange={addFiles} />
          <button className="data-upload" onClick={() => inputRef.current?.click()}>＋ 加入多張影像</button>
          <div className="som-thumbnails">
            {images.map((image) => <button key={image.id} className={queryId === image.id ? "active" : ""} onClick={() => setQueryId(image.id)}><img src={image.url} alt="" /><span><strong>{image.name}</strong><small>{image.demo ? "內建範例" : "資料集影像"}</small></span><i>{queryId === image.id ? "查詢" : ""}</i></button>)}
          </div>
        </aside>

        <section className="panel som-map-panel">
          <div className="panel-title"><b>⬡</b><span><strong>自組織映射圖</strong><small>Topology map</small></span><em>{model ? `${model.width}×${model.height}` : "—"}</em></div>
          <div className="som-map" style={{ gridTemplateColumns: `repeat(${model?.width ?? width}, minmax(70px, 1fr))` }}>
            {Array.from({ length: (model?.width ?? width) * (model?.height ?? height) }, (_, index) => {
              const x = index % (model?.width ?? width);
              const y = Math.floor(index / (model?.width ?? width));
              const nodeItems = mapped.filter((item) => item.node?.x === x && item.node?.y === y);
              return <div key={index} className={nodeItems.some((item) => item.id === queryId) ? "query-node" : ""}><header><span>{x},{y}</span><em>{nodeItems.length}</em></header><div>{nodeItems.slice(0, 4).map((item) => <button key={item.id} title={item.name} onClick={() => setQueryId(item.id)}><img src={item.url} alt={item.name} /></button>)}</div></div>;
            })}
          </div>
          {!model && <div className="som-map-empty"><b>⬡</b><strong>尚未建立拓撲映射</strong><span>加入影像並執行 SOM 訓練</span></div>}
        </section>

        <aside className="panel som-controls">
          <div className="panel-title"><b>⌘</b><span><strong>訓練與檢索</strong><small>Train & retrieve</small></span></div>
          <div className="som-params">
            <label><span>網格寬度</span><input type="number" min="2" max="12" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label>
            <label><span>網格高度</span><input type="number" min="2" max="12" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label>
            <label><span>訓練回合</span><input type="number" min="20" max="400" step="10" value={epochs} onChange={(event) => setEpochs(Number(event.target.value))} /></label>
          </div>
          <div className="feature-list"><strong>特徵向量</strong><span>12-bin 灰階直方圖</span><span>RGB 色彩分布</span><span>亮度變化／邊緣密度</span></div>
          <button className="train-som" onClick={train} disabled={training}>{training ? "◌ 訓練中…" : "▶ 建立 SOM 映射"}</button>
          <div className="retrieval">
            <header><strong>相似影像</strong><em>{similar.length}</em></header>
            {query && <div className="query-image"><img src={query.url} alt="" /><span><small>查詢影像</small><strong>{query.name}</strong></span></div>}
            <div className="similar-list">{similar.map((item, index) => <button key={item.id} onClick={() => setQueryId(item.id)}><em>{String(index + 1).padStart(2, "0")}</em><img src={item.url} alt="" /><span><strong>{item.name}</strong><small>距離 {item.distance?.toFixed(4)}</small></span></button>)}</div>
          </div>
          <button className="export-analysis" disabled={!mapped.length} onClick={() => saveCsv(mapped)}>↓ 匯出 SOM 映射 CSV</button>
        </aside>
      </div>
    </section>
  );
}
