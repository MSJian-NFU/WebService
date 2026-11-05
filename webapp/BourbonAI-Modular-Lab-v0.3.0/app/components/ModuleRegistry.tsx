"use client";

import { IMAGE_MODULES } from "../lib/image-modules";

const dataModules = [
  ["K-Means", "非監督式", "群組數 K", "分群標籤、中心點"],
  ["DBSCAN", "非監督式", "ε、最少點數", "密度群組、離群點"],
  ["Linear SVM", "監督式", "暫定或人工標籤", "分類標籤、一致率"],
  ["Decision Tree", "監督式", "暫定或人工標籤", "分類標籤、規則"],
  ["Random Forest", "監督式", "樹數、特徵子集", "分類標籤、一致率"],
  ["PCA", "降維", "標準化數值矩陣", "PC1／PC2、解釋率"],
  ["TF-IDF", "文件探勘", "語言、停用詞", "文件向量、關鍵詞"],
  ["Precision Search", "文字搜尋", "詞 A、詞 B、字元窗", "命中文字段落"],
  ["SOM", "非監督式檢索", "網格、epochs、影像特徵", "拓撲座標、相似距離"],
];

export default function ModuleRegistry() {
  return (
    <section className="workspace registry-workspace">
      <div className="workspace-heading">
        <div><span>EXTENSIBLE MODULE REGISTRY</span><h1>功能模組庫</h1><p>每項影像與數據方法皆以獨立定義、參數結構及執行函式註冊，方便後續擴充。</p></div>
        <em><i />{IMAGE_MODULES.length + dataModules.length} modules registered</em>
      </div>
      <div className="registry-summary">
        <article><b>{IMAGE_MODULES.length}</b><span>影像處理模組<small>Image processing</small></span></article>
        <article><b>{dataModules.length}</b><span>資料／探勘模組<small>Data & mining</small></span></article>
        <article><b>3</b><span>模組介面契約<small>Input · Params · Output</small></span></article>
        <article><b>∞</b><span>可擴充能力<small>Registry based</small></span></article>
      </div>
      <div className="registry-columns">
        <section className="panel">
          <div className="panel-title"><b>◫</b><span><strong>影像處理模組</strong><small>Image modules</small></span></div>
          <div className="registry-list">
            {IMAGE_MODULES.map((item, index) => <article key={item.id}><em>{String(index + 1).padStart(2, "0")}</em><span><strong>{item.zh}</strong><small>{item.en} · {item.category}</small><p>{item.description}</p></span><div>{item.parameters.length ? item.parameters.map((parameter) => <i key={parameter.key}>{parameter.en}</i>) : <i>No params</i>}</div></article>)}
          </div>
        </section>
        <section className="panel">
          <div className="panel-title"><b>⌁</b><span><strong>資料與探勘模組</strong><small>Data & mining modules</small></span></div>
          <div className="data-registry-table">
            <header><span>模組</span><span>類型</span><span>參數／輸入</span><span>輸出</span></header>
            {dataModules.map((item) => <div key={item[0]}>{item.map((value) => <span key={value}>{value}</span>)}</div>)}
          </div>
        </section>
      </div>
      <section className="panel extension-contract">
        <div>
          <span>FUTURE EXTENSION</span>
          <h2>新增方法不必重寫介面</h2>
          <p>在 Registry 註冊名稱、分類、參數 Schema 與執行函式後，介面會自動產生選項與參數控制。影像模組接收並回傳 ImageData；資料模組接收數值矩陣或文件向量，回傳標籤、座標與可匯出結果。</p>
        </div>
        <pre>{`registerModule({
  id: "new-method",
  category: "image | data | mining",
  parameters: [{ key, min, max, default }],
  apply: async (input, params) => output
});`}</pre>
      </section>
    </section>
  );
}
